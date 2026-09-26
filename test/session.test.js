import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { resolveConfig } from "../src/config.js";
import { ensureRuntime, runWithShims } from "../src/runtime.js";
import {
  applySessionPlan,
  deferSessionRouting,
  environmentWithoutSessionRouting,
  nativeSessionEnvironment,
  persistSessionPlan,
  planSession,
  selectSessionMode
} from "../src/session.js";
import { detectStack } from "../src/workspace.js";
import { isolatedEnvironment } from "../scripts/harness-utils.mjs";
import { CleanDevelopmentPlugin } from "../.opencode/plugins/clean-development.js";

const cli = path.resolve("bin/clean-development.js");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clean-development-session-"));
  const project = path.join(root, "project");
  const fakeBin = path.join(root, "fake-bin");
  fs.mkdirSync(project);
  fs.mkdirSync(fakeBin);
  const env = {
    ...isolatedEnvironment(root),
    CLEAN_DEVELOPMENT_ROOT: path.join(root, "managed"),
    PATH: fakeBin
  };
  return { root, project, fakeBin, env };
}

test("stack detection is read-only and reports package-manager conflicts", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(item.project, ".git"));
  fs.writeFileSync(path.join(item.project, "Cargo.toml"), "[workspace]\n");
  fs.writeFileSync(path.join(item.project, "package.json"), '{"packageManager":"pnpm@9.0.0"}\n');
  fs.writeFileSync(path.join(item.project, "package-lock.json"), "{}\n");
  fs.writeFileSync(path.join(item.project, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  const before = fs.readdirSync(item.project).sort();
  const detected = detectStack(path.join(item.project, "nested"));
  assert.equal(detected.root, fs.realpathSync.native(item.project));
  assert.deepEqual(detected.tools, ["cargo", "pnpm", "npm", "npx"]);
  assert.deepEqual(detected.conflicts[0].tools, ["pnpm", "npm"]);
  assert.deepEqual(fs.readdirSync(item.project).sort(), before);
  assert.equal(fs.existsSync(path.join(item.root, "managed")), false);
});

test("session planning has no side effects and session-only prepares only external storage", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(item.project, "Cargo.toml"), "[package]\nname='fixture'\nversion='0.1.0'\n");
  fs.writeFileSync(path.join(item.project, "package.json"), "{}\n");
  const config = resolveConfig({ cwd: item.project, env: item.env });
  const plan = planSession({ cwd: item.project, env: item.env, config });
  assert.deepEqual(plan.detected.tools, ["cargo", "npm", "npx"]);
  assert.deepEqual(plan.managed.dynamic, ["CARGO_TARGET_DIR"]);
  assert.match(plan.managed.environment.npm_config_cache, /managed[/\\]caches[/\\]node[/\\]npm$/);
  assert.equal(fs.existsSync(path.join(item.project, ".clean-development.json")), false);
  assert.equal(fs.existsSync(config.root), false);

  const applied = applySessionPlan(plan, "session-only", item.env);
  assert.equal(applied.mode, "session-only");
  assert.equal(applied.env.CLEAN_DEVELOPMENT_SESSION_MODE, "session-only");
  assert.equal(applied.env.CARGO_TARGET_DIR, undefined);
  assert.equal(fs.existsSync(config.cacheRoot), true);
  assert.equal(fs.existsSync(config.buildRoot), true);
  assert.equal(fs.existsSync(path.join(item.project, ".clean-development.json")), false);
});

test("session-only refuses every managed path inside the project", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(item.project, "package.json"), "{}\n");
  const env = { ...item.env, CLEAN_DEVELOPMENT_ROOT: path.join(item.project, ".managed") };
  const config = resolveConfig({ cwd: item.project, env });
  const plan = planSession({ cwd: item.project, env, config });
  assert.equal(plan.choices.find((choice) => choice.mode === "session-only").available, false);
  assert.deepEqual(plan.managed.repositoryPaths, [config.root, config.cacheRoot, config.buildRoot, config.scratchRoot]);
  assert.throws(() => applySessionPlan(plan, "session-only", env), /Managed storage must be outside the project/);
  assert.equal(fs.existsSync(config.root), false);
  assert.equal(fs.existsSync(path.join(item.project, ".clean-development.json")), false);
});

test("persist writes only the exact reviewed project file and rejects a changed target", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(item.project, "go.mod"), "module example.test/fixture\n");
  const config = resolveConfig({ cwd: item.project, env: item.env });
  const plan = planSession({ cwd: item.project, env: item.env, config });
  const applied = applySessionPlan(plan, "persist", item.env);
  const projectFile = plan.projectConfig.path;
  assert.deepEqual(applied.projectConfig, { status: "created", file: projectFile });
  assert.equal(fs.readFileSync(projectFile, "utf8"), plan.projectConfig.proposedContents);
  assert.deepEqual(fs.readdirSync(item.project).sort(), [".clean-development.json", "go.mod"]);

  fs.unlinkSync(projectFile);
  const reviewed = planSession({ cwd: item.project, env: item.env, config });
  fs.writeFileSync(projectFile, '{"schemaVersion":1,"enabled":false}\n');
  assert.throws(() => persistSessionPlan(reviewed), /appeared after review/);
  assert.equal(fs.readFileSync(projectFile, "utf8"), '{"schemaVersion":1,"enabled":false}\n');
  fs.unlinkSync(projectFile);
  const wrongParent = planSession({ cwd: item.project, env: item.env, config });
  wrongParent.projectConfig.parentIdentity.ino = "0";
  assert.throws(() => persistSessionPlan(wrongParent), /Project directory changed after review/);
  assert.equal(fs.existsSync(projectFile), false);
});

test("session selection defaults safely and inherited persist cannot write another checkout", () => {
  assert.equal(selectSessionMode({ env: {}, interactive: false }), "session-only");
  assert.equal(selectSessionMode({ requested: "skip", env: {}, interactive: true, choice: "persist" }), "skip");
  assert.equal(selectSessionMode({ env: { CLEAN_DEVELOPMENT_SESSION_MODE: "persist" }, interactive: false }), "session-only");
  assert.equal(selectSessionMode({ env: {}, interactive: true, choice: null }), "skip");
  assert.throws(() => selectSessionMode({ requested: "yes", env: {} }), /Invalid session choice/);
});

test("disabled project configuration keeps routed session choices unavailable", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(item.project, "package.json"), "{}\n");
  fs.writeFileSync(path.join(item.project, ".clean-development.json"), '{"schemaVersion":1,"enabled":false}\n');
  const config = resolveConfig({ cwd: item.project, env: item.env });
  const plan = planSession({ cwd: item.project, env: item.env, config });
  assert.equal(plan.managed.enabled, false);
  assert.equal(plan.choices.find((choice) => choice.mode === "session-only").available, false);
  assert.deepEqual(plan.managed.environment, {});
  for (const mode of ["session-only", "persist"]) {
    const applied = applySessionPlan(plan, mode, item.env);
    assert.equal(applied.mode, "skip");
    assert.equal(applied.env.CLEAN_DEVELOPMENT_SESSION_MODE, "skip");
    assert.equal(applied.projectConfig, null);
    assert.equal(fs.existsSync(config.root), false);
  }
  const capture = path.join(item.root, "disabled-agent");
  fs.writeFileSync(path.join(item.fakeBin, "agy"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.CAPTURE, process.env.CLEAN_DEVELOPMENT_SESSION_MODE || 'missing');\n`, { mode: 0o755 });
  const launched = spawnSync(process.execPath, [cli, "agent", "antigravity", "--", "hello"], {
    cwd: item.project, env: { ...item.env, CAPTURE: capture }, encoding: "utf8"
  });
  assert.equal(launched.status, 0, launched.stderr);
  assert.equal(fs.readFileSync(capture, "utf8"), "skip");
  assert.equal(fs.existsSync(path.join(item.root, "data")), false);
  assert.equal(fs.existsSync(path.join(item.root, "managed")), false);
});

test("nested session planning retains cleanup provenance for outer injected values", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(item.project, "package.json"), "{}\n");
  const config = resolveConfig({ cwd: item.project, env: item.env });
  const first = applySessionPlan(planSession({ cwd: item.project, env: item.env, config }), "session-only", item.env);
  const secondPlan = planSession({ cwd: item.project, env: first.env, config });
  const second = applySessionPlan(secondPlan, "session-only", first.env);
  const cleaned = environmentWithoutSessionRouting(second.env, config.locations.binDir);
  assert.equal(cleaned.npm_config_cache, undefined);
  assert.equal(cleaned.CLEAN_DEVELOPMENT_SESSION_ENV, undefined);
  for (const disabled of [false, true]) {
    const skippedPlan = { ...secondPlan, managed: { ...secondPlan.managed, enabled: !disabled } };
    const skipped = applySessionPlan(skippedPlan, disabled ? "session-only" : "skip", second.env);
    assert.equal(skipped.mode, "skip");
    assert.equal(skipped.env.npm_config_cache, undefined);
    assert.equal(skipped.env.CLEAN_DEVELOPMENT_SESSION_ENV, undefined);
    const overridden = applySessionPlan(skippedPlan, "skip", { ...second.env, npm_config_cache: "user-cache" });
    assert.equal(overridden.env.npm_config_cache, "user-cache");
  }
});

test("skip bypasses runtime, shims, managed variables, and Codex argument changes", async (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(item.project, "Cargo.toml"), "[package]\nname='fixture'\nversion='0.1.0'\n");
  const capture = path.join(item.root, "capture.json");
  const fakeCodex = path.join(item.fakeBin, "codex");
  fs.writeFileSync(fakeCodex, `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.CAPTURE, JSON.stringify({args:process.argv.slice(2),active:process.env.CLEAN_DEVELOPMENT_ACTIVE,target:process.env.CARGO_TARGET_DIR,path:process.env.PATH}));\n`, { mode: 0o755 });
  const config = resolveConfig({ cwd: item.project, env: item.env });
  const env = {
    ...item.env,
    CAPTURE: capture,
    CLEAN_DEVELOPMENT_ACTIVE: "1",
    CLEAN_DEVELOPMENT_SESSION_MODE: "skip",
    CLEAN_DEVELOPMENT_SESSION_ENV: JSON.stringify({ CARGO_TARGET_DIR: "/managed/injected" }),
    CLEAN_DEVELOPMENT_CARGO_TARGET_DIR: "/managed/injected",
    CARGO_TARGET_DIR: "/managed/injected"
  };
  assert.equal(await runWithShims("codex", ["exec", "prompt"], { config, cwd: item.project, env }), 0);
  const observed = JSON.parse(fs.readFileSync(capture, "utf8"));
  assert.deepEqual(observed.args, ["exec", "prompt"]);
  assert.equal(observed.active, undefined);
  assert.equal(observed.target, undefined);
  assert.equal(fs.existsSync(config.locations.runtimeDir), false);
});

test("skip cleanup removes only environment values injected by the session", () => {
  const cleaned = environmentWithoutSessionRouting({
    PATH: "/managed/bin:/native/bin",
    npm_config_cache: "/explicit/npm",
    UV_CACHE_DIR: "/managed/uv",
    CLEAN_DEVELOPMENT_SESSION_ENV: JSON.stringify({ npm_config_cache: "/managed/npm", UV_CACHE_DIR: "/managed/uv" }),
    CLEAN_DEVELOPMENT_ACTIVE: "1"
  }, "/managed/bin");
  assert.equal(cleaned.PATH, "/native/bin");
  assert.equal(cleaned.npm_config_cache, "/explicit/npm");
  assert.equal(cleaned.UV_CACHE_DIR, undefined);
  assert.equal(cleaned.CLEAN_DEVELOPMENT_ACTIVE, undefined);
  assert.equal(cleaned.CLEAN_DEVELOPMENT_SESSION_MODE, "skip");
  for (const marker of ["null", "[]", "42", '"value"', '{"UV_CACHE_DIR":42}']) {
    assert.doesNotThrow(() => environmentWithoutSessionRouting({ CLEAN_DEVELOPMENT_SESSION_ENV: marker }));
  }
});

test("native adapters clean routed state before entering a disabled project", () => {
  const cleaned = nativeSessionEnvironment({
    PATH: "/managed/bin:/native/bin",
    npm_config_cache: "/managed/npm",
    CLEAN_DEVELOPMENT_ACTIVE: "1",
    CLEAN_DEVELOPMENT_SESSION_MODE: "session-only",
    CLEAN_DEVELOPMENT_SESSION_ENV: JSON.stringify({ npm_config_cache: "/managed/npm" })
  }, { binDir: "/managed/bin" });
  assert.deepEqual(cleaned, {
    PATH: "/native/bin",
    CLEAN_DEVELOPMENT_SESSION_MODE: "skip"
  });
});

test("OpenCode launcher defers static routing for its additive shell environment hook", () => {
  const routed = {
    PATH: "/managed/bin:/native/bin",
    npm_config_cache: "/managed/npm",
    CLEAN_DEVELOPMENT_SESSION_MODE: "session-only",
    CLEAN_DEVELOPMENT_SESSION_ENV: JSON.stringify({ npm_config_cache: "/managed/npm" })
  };
  assert.deepEqual(deferSessionRouting(routed, "/managed/bin"), {
    PATH: "/native/bin",
    CLEAN_DEVELOPMENT_SESSION_MODE: "session-only"
  });
});

test("the CLI dry run is read-only and explicit persistence is reviewable", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(item.project, "pyproject.toml"), "[project]\nname='fixture'\nversion='0.1.0'\n");
  fs.writeFileSync(path.join(item.project, "uv.lock"), "version = 1\n");
  const dryRun = spawnSync(process.execPath, [cli, "session", "--dry-run", "--json"], {
    cwd: item.project, env: item.env, encoding: "utf8"
  });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const reviewed = JSON.parse(dryRun.stdout);
  assert.deepEqual(reviewed.plan.detected.tools, ["uv"]);
  assert.equal(fs.existsSync(path.join(item.project, ".clean-development.json")), false);
  assert.equal(fs.existsSync(path.join(item.root, "managed")), false);

  const persisted = spawnSync(process.execPath, [cli, "session", "--session", "persist", "--json"], {
    cwd: item.project, env: { ...item.env, SESSION_TEST_SECRET: "must-not-be-printed" }, encoding: "utf8"
  });
  assert.equal(persisted.status, 0, persisted.stderr);
  assert.doesNotMatch(persisted.stdout, /must-not-be-printed/);
  const result = JSON.parse(persisted.stdout);
  assert.equal(result.mode, "persist");
  assert.equal(result.projectConfig.status, "created");
  assert.equal(fs.readFileSync(result.projectConfig.file, "utf8"), reviewed.plan.projectConfig.proposedContents);
});

test("a noninteractive agent launch applies the detected session overlay without repository writes", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(item.project, "pyproject.toml"), "[project]\nname='fixture'\nversion='0.1.0'\n");
  fs.writeFileSync(path.join(item.project, "uv.lock"), "version = 1\n");
  const capture = path.join(item.root, "agent.json");
  const agy = path.join(item.fakeBin, "agy");
  fs.writeFileSync(agy, `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.CAPTURE, JSON.stringify({args:process.argv.slice(2),mode:process.env.CLEAN_DEVELOPMENT_SESSION_MODE,active:process.env.CLEAN_DEVELOPMENT_ACTIVE,cache:process.env.UV_CACHE_DIR}));\n`, { mode: 0o755 });
  const launched = spawnSync(process.execPath, [cli, "agent", "antigravity", "--", "--print", "hello"], {
    cwd: item.project, env: { ...item.env, CAPTURE: capture }, encoding: "utf8"
  });
  assert.equal(launched.status, 0, launched.stderr);
  assert.equal(fs.existsSync(path.join(item.project, ".clean-development.json")), false);
  const observed = JSON.parse(fs.readFileSync(capture, "utf8"));
  assert.deepEqual(observed.args, ["--print", "hello"]);
  assert.equal(observed.mode, "session-only");
  assert.equal(observed.active, "1");
  assert.match(observed.cache, /managed[/\\]caches[/\\]python[/\\]uv$/);
});

test("the OpenCode launcher defers static cache routing to its command shims", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(item.project, "package.json"), "{}\n");
  const capture = path.join(item.root, "opencode.json");
  const opencode = path.join(item.fakeBin, "opencode");
  fs.writeFileSync(opencode, `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.CAPTURE, JSON.stringify({mode:process.env.CLEAN_DEVELOPMENT_SESSION_MODE,active:process.env.CLEAN_DEVELOPMENT_ACTIVE,cache:process.env.npm_config_cache,marker:process.env.CLEAN_DEVELOPMENT_SESSION_ENV,path:process.env.PATH}));\n`, { mode: 0o755 });
  const launched = spawnSync(process.execPath, [cli, "agent", "opencode", "--session", "session-only", "--", "hello"], {
    cwd: item.project,
    env: { ...item.env, CAPTURE: capture },
    encoding: "utf8"
  });
  assert.equal(launched.status, 0, launched.stderr);
  const observed = JSON.parse(fs.readFileSync(capture, "utf8"));
  assert.equal(observed.mode, "session-only");
  assert.equal(observed.active, "1");
  assert.equal(observed.cache, undefined);
  assert.equal(observed.marker, undefined);
  assert.notEqual(observed.path, item.env.PATH);
  assert.equal(fs.existsSync(path.join(item.project, ".clean-development.json")), false);
});

test("a skipped hook writes neither runtime state nor a Claude environment file", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const environmentFile = path.join(item.root, "claude", "environment");
  fs.writeFileSync(path.join(item.project, ".clean-development.json"), '{"schemaVersion":1,"unknown":true}\n');
  const skipped = spawnSync(process.execPath, [cli, "hook", "session-start"], {
    cwd: item.project,
    env: { ...item.env, CLEAN_DEVELOPMENT_SESSION_MODE: "skip", CLAUDE_ENV_FILE: environmentFile },
    encoding: "utf8"
  });
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.equal(fs.existsSync(environmentFile), false);
  assert.equal(fs.existsSync(path.join(item.root, "data")), false);
});

test("explicit skip bypasses invalid project configuration for run and direct shims", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(item.project, ".clean-development.json"), '{"schemaVersion":1,"unknown":true}\n');
  const capture = path.join(item.root, "cargo.json");
  const cargo = path.join(item.fakeBin, "cargo");
  fs.writeFileSync(cargo, `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.CAPTURE, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
  const env = { ...item.env, CAPTURE: capture };
  const run = spawnSync(process.execPath, [cli, "run", "--session", "skip", "--", "cargo", "test", "--offline"], {
    cwd: item.project, env, encoding: "utf8"
  });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(capture, "utf8")), ["test", "--offline"]);
  fs.unlinkSync(capture);
  const shim = spawnSync(process.execPath, [path.resolve("bin/clean-development-shim.js"), "cargo", "check"], {
    cwd: item.project, env: { ...env, CLEAN_DEVELOPMENT_SESSION_MODE: "skip" }, encoding: "utf8"
  });
  assert.equal(shim.status, 0, shim.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(capture, "utf8")), ["check"]);
  assert.equal(fs.existsSync(path.join(item.root, "data")), false);
  assert.equal(fs.existsSync(path.join(item.root, "managed")), false);
});

test("the generated shell helper keeps managed shims first and honors skip", { skip: process.platform === "win32" }, (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(item.project, "package.json"), "{}\n");
  for (const name of ["caches", "builds", "scratch"]) fs.mkdirSync(path.join(item.root, "managed", name), { recursive: true });
  const config = resolveConfig({ cwd: item.project, env: item.env });
  const runtime = ensureRuntime(config);
  const helper = path.join(runtime.binDir, "clean-development-shell-env");
  const reordered = spawnSync("/bin/sh", ["-c", '. "$1"; printf "%s\\n%s\\n%s" "$CLEAN_DEVELOPMENT_SESSION_MODE" "$CLEAN_DEVELOPMENT_ACTIVE" "${PATH%%:*}"', "sh", helper], {
    env: { ...item.env, PATH: `${item.fakeBin}:${runtime.binDir}`, CLEAN_DEVELOPMENT_SESSION_MODE: "session-only" }, encoding: "utf8"
  });
  assert.equal(reordered.status, 0, reordered.stderr);
  assert.deepEqual(reordered.stdout.split("\n"), ["session-only", "1", runtime.binDir]);
  const skipped = spawnSync("/bin/sh", ["-c", '. "$1"; printf "%s\\n%s\\n%s" "$CLEAN_DEVELOPMENT_SESSION_MODE" "${CLEAN_DEVELOPMENT_ACTIVE:-}" "${PATH%%:*}"', "sh", helper], {
    env: { ...item.env, PATH: item.fakeBin }, encoding: "utf8"
  });
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.deepEqual(skipped.stdout.split("\n"), ["skip", "", runtime.binDir]);
});

test("the OpenCode native adapter defaults to pass-through until a session is selected", async (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(item.project, "package.json"), "{}\n");
  for (const name of ["caches", "builds", "scratch"]) fs.mkdirSync(path.join(item.root, "managed", name), { recursive: true });
  const config = resolveConfig({ cwd: item.project, env: item.env });
  const runtime = ensureRuntime(config);
  const plugin = await CleanDevelopmentPlugin({ directory: item.project });

  const defaultOutput = { env: { ...item.env } };
  await plugin["shell.env"]({ cwd: item.project }, defaultOutput);
  assert.equal(defaultOutput.env.CLEAN_DEVELOPMENT_SESSION_MODE, "skip");
  assert.equal(defaultOutput.env.CLEAN_DEVELOPMENT_ACTIVE, "");
  assert.equal(defaultOutput.env.PATH.split(path.delimiter)[0], runtime.binDir);

  const routed = applySessionPlan(planSession({ cwd: item.project, env: item.env, config }), "session-only", item.env);
  const selectedOutput = { env: routed.env };
  await plugin["shell.env"]({ cwd: item.project }, selectedOutput);
  assert.equal(selectedOutput.env.CLEAN_DEVELOPMENT_SESSION_MODE, "session-only");
  assert.equal(selectedOutput.env.CLEAN_DEVELOPMENT_ACTIVE, "1");

  fs.writeFileSync(path.join(item.project, ".clean-development.json"), "{\n");
  const malformedOutput = { env: { ...item.env } };
  await plugin["shell.env"]({ cwd: item.project }, malformedOutput);
  assert.equal(malformedOutput.env.CLEAN_DEVELOPMENT_SESSION_MODE, "skip");
  assert.equal(malformedOutput.env.CLEAN_DEVELOPMENT_ACTIVE, "");
  assert.equal(malformedOutput.env.PATH.split(path.delimiter)[0], runtime.binDir);

  fs.writeFileSync(path.join(item.project, ".clean-development.json"), '{"schemaVersion":1,"enabled":false}\n');
  const disabledOutput = { env: { ...selectedOutput.env } };
  await assert.rejects(
    plugin["shell.env"]({ cwd: item.project }, disabledOutput),
    /cannot safely unset inherited Clean Development routing.*npm_config_cache/i
  );

  const pluginUrl = new URL("../.opencode/plugins/clean-development.js", import.meta.url).href;
  const hostContract = [
    `import { CleanDevelopmentPlugin } from ${JSON.stringify(pluginUrl)};`,
    `const plugin = await CleanDevelopmentPlugin({ directory: ${JSON.stringify(item.project)} });`,
    "const output = { env: {} };",
    "try {",
    `  await plugin[\"shell.env\"]({ cwd: ${JSON.stringify(item.project)} }, output);`,
    "  const merged = { ...process.env, ...output.env };",
    "  process.stdout.write(JSON.stringify({ ok: true, overlay: output.env, merged }));",
    "} catch (error) {",
    "  process.stdout.write(JSON.stringify({ ok: false, error: error.message }));",
    "}"
  ].join("\n");
  const deferred = deferSessionRouting(routed.env, runtime.binDir);
  const launched = spawnSync(process.execPath, ["--input-type=module", "--eval", hostContract], {
    cwd: item.project,
    env: {
      ...deferred,
      CLEAN_DEVELOPMENT_ACTIVE: "1",
      PATH: `${runtime.binDir}${path.delimiter}${deferred.PATH}`
    },
    encoding: "utf8"
  });
  assert.equal(launched.status, 0, launched.stderr);
  const observed = JSON.parse(launched.stdout);
  assert.equal(observed.ok, true);
  assert.equal(observed.merged.CLEAN_DEVELOPMENT_SESSION_MODE, "skip");
  assert.equal(observed.merged.CLEAN_DEVELOPMENT_ACTIVE, "");
  assert.equal(observed.merged.CLEAN_DEVELOPMENT_SESSION_ENV, "");
  assert.equal(observed.merged.npm_config_cache, undefined);
  assert.equal(observed.merged.PATH, item.env.PATH);

  const unsafe = spawnSync(process.execPath, ["--input-type=module", "--eval", hostContract], {
    cwd: item.project,
    env: {
      ...selectedOutput.env,
      PATH: `${runtime.binDir}${path.delimiter}${item.env.PATH}`
    },
    encoding: "utf8"
  });
  assert.equal(unsafe.status, 0, unsafe.stderr);
  const rejected = JSON.parse(unsafe.stdout);
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /cannot safely unset inherited Clean Development routing.*npm_config_cache/i);
});
