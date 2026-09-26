import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { resolveConfig } from "../src/config.js";
import { ensureRuntime, runTool } from "../src/runtime.js";
import { isolatedEnvironment } from "../scripts/harness-utils.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clean-development-runtime-"));
  const project = path.join(root, "project");
  const fakeBin = path.join(root, "fake-bin");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(project, "Cargo.toml"), "[package]\nname='fixture'\nversion='0.1.0'\n");
  fs.writeFileSync(path.join(project, ".clean-development.json"), '{"schemaVersion":1}\n');
  const env = {
    ...isolatedEnvironment(root),
    NODE_OPTIONS: "--no-experimental-detect-module",
    PATH: fakeBin
  };
  for (const name of ["caches", "builds", "scratch"]) fs.mkdirSync(path.join(root, "managed", name), { recursive: true });
  return { root, project, fakeBin, env };
}

test("runtime materializes stable CLI and tool shims", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const config = resolveConfig({ cwd: item.project, env: item.env });
  const runtime = ensureRuntime(config);
  assert.ok(fs.existsSync(path.join(runtime.binDir, "clean-development")));
  assert.ok(fs.existsSync(path.join(runtime.binDir, "cargo")));
  assert.ok(fs.existsSync(path.join(runtime.binDir, "clean-development-codex")));
  const shellEnvironment = path.join(runtime.binDir, "clean-development-shell-env");
  assert.ok(fs.existsSync(shellEnvironment));
  if (process.platform !== "win32") {
    const sourced = spawnSync("/bin/sh", ["-c", '. "$1"; printf "%s\n%s\n%s\n" "$CLEAN_DEVELOPMENT_SESSION_MODE" "${CLEAN_DEVELOPMENT_ACTIVE:-}" "${PATH%%:*}"', "sh", shellEnvironment], {
      env: { ...item.env, PATH: item.fakeBin },
      encoding: "utf8"
    });
    assert.equal(sourced.status, 0, sourced.stderr);
    assert.deepEqual(sourced.stdout.trimEnd().split("\n"), ["skip", "", runtime.binDir]);
    const activated = spawnSync("/bin/sh", ["-c", '. "$1"; printf "%s\n%s\n" "$CLEAN_DEVELOPMENT_SESSION_MODE" "$CLEAN_DEVELOPMENT_ACTIVE"', "sh", shellEnvironment], {
      env: { ...item.env, PATH: item.fakeBin, CLEAN_DEVELOPMENT_SESSION_MODE: "session-only" },
      encoding: "utf8"
    });
    assert.equal(activated.status, 0, activated.stderr);
    assert.deepEqual(activated.stdout.trim().split("\n"), ["session-only", "1"]);
  }
  assert.ok(fs.existsSync(path.join(runtime.versionRoot, "src", "adapters.js")));
});

test("Codex launcher disables login shells before forwarding user arguments", (t) => {
  if (process.platform === "win32") return t.skip("POSIX launcher execution is covered on non-Windows hosts");
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const capture = path.join(item.root, "codex-argv.json");
  const fakeCodex = path.join(item.fakeBin, "codex");
  fs.writeFileSync(fakeCodex, `#!${process.execPath}\nrequire("node:fs").writeFileSync(process.env.CAPTURE, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
  fs.chmodSync(fakeCodex, 0o755);
  const config = resolveConfig({ cwd: item.project, env: item.env });
  const runtime = ensureRuntime(config);
  const launched = spawnSync(path.join(runtime.binDir, "clean-development-codex"), ["exec", "--ephemeral", "prompt"], {
    cwd: item.project,
    env: { ...item.env, CAPTURE: capture },
    encoding: "utf8"
  });
  assert.equal(launched.status, 0, launched.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(capture, "utf8")), ["exec", "--ephemeral", "prompt", "-c", "allow_login_shell=false", "-c", 'shell_environment_policy.set.CLEAN_DEVELOPMENT_SESSION_MODE="session-only"']);

  const generic = spawnSync(path.join(runtime.binDir, "clean-development"), ["agent", "codex", "--", "exec", "--ignore-user-config", "prompt"], {
    cwd: item.project,
    env: { ...item.env, CAPTURE: capture },
    encoding: "utf8"
  });
  assert.equal(generic.status, 0, generic.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(capture, "utf8")), ["exec", "--ignore-user-config", "prompt", "-c", "allow_login_shell=false", "-c", 'shell_environment_policy.set.CLEAN_DEVELOPMENT_SESSION_MODE="session-only"']);

  const nestedSeparator = spawnSync(path.join(runtime.binDir, "clean-development"), ["agent", "codex", "--", "exec", "--", "echo", "ok"], {
    cwd: item.project,
    env: { ...item.env, CAPTURE: capture },
    encoding: "utf8"
  });
  assert.equal(nestedSeparator.status, 0, nestedSeparator.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(capture, "utf8")), ["exec", "-c", "allow_login_shell=false", "-c", 'shell_environment_policy.set.CLEAN_DEVELOPMENT_SESSION_MODE="session-only"', "--", "echo", "ok"]);

  const genericRun = spawnSync(path.join(runtime.binDir, "clean-development"), ["run", "--", "codex", "exec", "--ignore-user-config", "prompt"], {
    cwd: item.project,
    env: { ...item.env, CAPTURE: capture },
    encoding: "utf8"
  });
  assert.equal(genericRun.status, 0, genericRun.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(capture, "utf8")), ["exec", "--ignore-user-config", "prompt", "-c", "allow_login_shell=false", "-c", 'shell_environment_policy.set.CLEAN_DEVELOPMENT_SESSION_MODE="session-only"']);
});

test("shim executes the real tool with routed environment and exit status", async (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const capture = path.join(item.root, "capture.json");
  const fakeCargo = path.join(item.fakeBin, "cargo");
  fs.writeFileSync(fakeCargo, `#!${process.execPath}\nconst fs = require('node:fs');\nfs.writeFileSync(process.env.CAPTURE, JSON.stringify({ target: process.env.CARGO_TARGET_DIR, args: process.argv.slice(2), tty: Boolean(process.stdout.isTTY) }));\nprocess.exit(7);\n`, { mode: 0o755 });
  fs.chmodSync(fakeCargo, 0o755);
  const env = { ...item.env, CAPTURE: capture };
  const config = resolveConfig({ cwd: item.project, env });
  const code = await runTool("cargo", ["build", "--locked"], { config, cwd: item.project, env });
  assert.equal(code, 7);
  const observed = JSON.parse(fs.readFileSync(capture, "utf8"));
  assert.deepEqual(observed.args, ["build", "--locked"]);
  assert.match(observed.target, /managed[/\\]builds[/\\]project-[a-f0-9]{10}[/\\]cargo[/\\]target$/);
  assert.equal(fs.readdirSync(path.join(config.locations.stateDir, "leases")).length, 0);
});

test("the four documented skill launchers honor an explicit mode, argv, cwd, and exit status", { skip: process.platform === "win32" }, (t) => {
  for (const [agent, executable] of [["codex", "codex"], ["claude", "claude"], ["antigravity", "agy"], ["grok", "grok"]]) {
    const item = fixture();
    t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(item.project, "package.json"), "{}\n");
    fs.writeFileSync(path.join(item.fakeBin, executable), `#!${process.execPath}\nconsole.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),mode:process.env.CLEAN_DEVELOPMENT_SESSION_MODE,cache:process.env.npm_config_cache||null}));process.exit(7);\n`, { mode: 0o755 });
    const args = ["--help", "value with spaces", "--", "literal argument"];
    for (const mode of ["session-only", "skip"]) {
      const result = spawnSync(process.execPath, [path.resolve("bin/clean-development.js"), "agent", agent, "--session", mode, "--", ...args], {
        cwd: item.project,
        env: { ...item.env, CLEAN_DEVELOPMENT_SESSION_MODE: "skip" },
        encoding: "utf8"
      });
      assert.equal(result.status, 7, `${agent}/${mode}: ${result.stderr}`);
      const observed = JSON.parse(result.stdout);
      assert.equal(observed.mode, mode);
      assert.equal(fs.realpathSync(observed.cwd), fs.realpathSync(item.project));
      assert.equal(observed.cache, mode === "skip" ? null : path.join(fs.realpathSync(item.root), "managed", "caches", "node", "npm"));
      const expectedArgs = agent === "codex" && mode === "session-only"
        ? [...args.slice(0, 2), "-c", "allow_login_shell=false", "-c", 'shell_environment_policy.set.CLEAN_DEVELOPMENT_SESSION_MODE="session-only"', ...args.slice(2)]
        : args;
      assert.deepEqual(observed.args, expectedArgs);
      assert.equal(fs.readFileSync(path.join(item.project, ".clean-development.json"), "utf8"), '{"schemaVersion":1}\n');
    }
  }
});
