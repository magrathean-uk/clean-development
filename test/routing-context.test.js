import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { resolveConfig } from "../src/config.js";
import { explainCommand } from "../src/explain.js";
import { environmentForTool } from "../src/adapters.js";
import { runTool, runWithShims } from "../src/runtime.js";
import { planSession } from "../src/session.js";
import { isolatedEnvironment } from "../scripts/harness-utils.mjs";

const cli = path.resolve("bin/clean-development.js");
const boundaryError = { code: "ERR_MANAGED_STORAGE_IN_PROJECT" };
function writeConfig(directory, value) {
  fs.writeFileSync(path.join(directory, ".clean-development.json"), JSON.stringify({ schemaVersion: 1, ...value }));
}
function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cd-command-boundary-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = path.join(root, "project-a"), b = path.join(root, "project-b"), bin = path.join(root, "bin");
  for (const directory of [a, b, bin]) fs.mkdirSync(directory);
  for (const directory of [a, b]) {
    fs.writeFileSync(path.join(directory, "package.json"), '{"private":true}\n');
    fs.writeFileSync(path.join(directory, "go.mod"), "module example.invalid/boundary\n\ngo 1.22\n");
    fs.writeFileSync(path.join(directory, "Cargo.toml"), '[package]\nname="boundary"\nversion="0.1.0"\n');
  }
  const env = isolatedEnvironment(root, Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC"].includes(key.toUpperCase()))));
  delete env.CLEAN_DEVELOPMENT_ROOT;
  env.CLEAN_DEVELOPMENT_SESSION_MODE = "session-only";
  for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
  env.PATH = `${bin}${path.delimiter}${path.dirname(process.execPath)}`;
  const configA = { root: path.join(root, "storage-a") }, configB = { root: path.join(root, "storage-b") };
  writeConfig(a, configA); writeConfig(b, configB);
  return { root, a, b, bin, cwd: a, env, configA, configB };
}
function snapshot(root) {
  const result = {};
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    result[entry.name] = entry.isDirectory() ? snapshot(file)
      : entry.isSymbolicLink() ? { link: fs.readlinkSync(file) } : fs.readFileSync(file).toString("base64");
  }
  return result;
}
function fakeTool(item, tool = "npm") {
  const capture = path.join(item.root, "capture.json"), discovery = path.join(item.root, "discovery.json");
  const script = path.join(item.bin, `${tool}.cjs`);
  fs.writeFileSync(script, `const fs=require("node:fs");
if(process.argv.includes("locate-project")) {
  fs.writeFileSync(${JSON.stringify(discovery)},JSON.stringify(process.argv.slice(2)));
  process.stdout.write(JSON.stringify({root:process.env.BOUNDARY_CARGO_ROOT}));
} else {
  fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),
    cache:process.env.npm_config_cache||process.env.NPM_CONFIG_CACHE||null,
    active:process.env.CLEAN_DEVELOPMENT_ACTIVE||null,session:process.env.CLEAN_DEVELOPMENT_SESSION_MODE}));
  process.exit(Number(process.env.BOUNDARY_EXIT||0));
}\n`);
  const executable = path.join(item.bin, process.platform === "win32" ? `${tool}.cmd` : tool);
  fs.writeFileSync(executable, process.platform === "win32"
    ? `@echo off\r\nsetlocal DisableDelayedExpansion\r\n"${process.execPath}" "${script}" %*\r\nexit /b %errorlevel%\r\n`
    : `#!${process.execPath}\nrequire(${JSON.stringify(script)});\n`, { mode: 0o755 });
  return { capture, discovery };
}
function resolved(item) { return resolveConfig({ cwd: item.a, env: item.env }); }
function ready(config) {
  for (const key of ["root", "cacheRoot", "buildRoot", "scratchRoot"]) fs.mkdirSync(config[key], { recursive: true });
}

for (const key of ["root", "cacheRoot", "buildRoot", "scratchRoot"]) {
  test(`npm target-project ${key} cannot bypass the external-storage boundary`, async (t) => {
    const item = fixture(t);
    writeConfig(item.b, { ...item.configB, [key]: path.join(item.b, `local-${key}`) });
    const args = ["--prefix", item.b, "config", "get", "cache"], config = resolved(item);
    const before = snapshot(item.root), envBefore = { ...item.env };
    const report = explainCommand("npm", args, item);
    assert.equal(report.routing.status, "blocked");
    assert.deepEqual(report.routing.variables, []);
    await assert.rejects(runTool("npm", args, { ...item, config }), boundaryError);
    await assert.rejects(runWithShims("npm", args, { ...item, config }), boundaryError);
    assert.deepEqual(item.env, envBefore);
    assert.deepEqual(snapshot(item.root), before);
  });
}

test("recognised target selectors share one boundary in prediction and dispatch", async (t) => {
  const item = fixture(t);
  writeConfig(item.b, { root: path.join(item.b, "managed") });
  const config = resolved(item), before = snapshot(item.root);
  for (const [tool, args] of [
    ["npm", [`--prefix=${item.b}`, "test"]], ["npx", ["--prefix", item.b, "--version"]],
    ["pnpm", ["--dir", item.b, "test"]], ["yarn", ["-C", item.b, "test"]],
    ["go", ["-C", item.b, "env"]], ["cargo", ["check", "--manifest-path", path.join(item.b, "Cargo.toml")]],
    ["cargo", [`-C${item.b}`, "check"]]
  ]) {
    assert.equal(explainCommand(tool, args, item).routing.status, "blocked", tool);
    await assert.rejects(runTool(tool, args, { ...item, config }), boundaryError);
  }
  assert.deepEqual(snapshot(item.root), before);
});

test("existing target storage is not permission to route inside the target project", async (t) => {
  const item = fixture(t), fake = fakeTool(item);
  writeConfig(item.b, { root: path.join(item.b, "managed") });
  ready(resolveConfig({ cwd: item.b, env: item.env }));
  const before = snapshot(item.root);
  await assert.rejects(runTool("npm", ["--prefix", item.b, "test"], { ...item, config: resolved(item) }), boundaryError);
  assert.equal(fs.existsSync(fake.capture), false);
  assert.deepEqual(snapshot(item.root), before);
});

test("target configuration also cannot redirect managed storage into the starting project", async (t) => {
  const item = fixture(t);
  writeConfig(item.b, { ...item.configB, cacheRoot: path.join(item.a, "unexpected-cache") });
  const args = ["--prefix", item.b, "test"], before = snapshot(item.root);
  assert.equal(explainCommand("npm", args, item).routing.status, "blocked");
  await assert.rejects(runTool("npm", args, { ...item, config: resolved(item) }), boundaryError);
  assert.deepEqual(snapshot(item.root), before);
});

test("force and preserved overrides do not bypass an invalid managed-storage configuration", async (t) => {
  const item = fixture(t), args = ["--prefix", item.b, "test"];
  writeConfig(item.b, { ...item.configB, cacheRoot: path.join(item.b, "local") });
  for (const extra of [{ CLEAN_DEVELOPMENT_FORCE: "1" }, { npm_config_cache: path.join(item.root, "explicit") }]) {
    const env = { ...item.env, ...extra }, config = resolveConfig({ cwd: item.a, env }), before = snapshot(item.root);
    assert.equal(explainCommand("npm", args, { ...item, env }).routing.status, "blocked");
    await assert.rejects(runTool("npm", args, { ...item, env, config }), boundaryError);
    assert.deepEqual(snapshot(item.root), before);
  }
});

test("safe external routing preserves target selection, exact argv, cwd and exit status", async (t) => {
  const item = fixture(t), fake = fakeTool(item);
  const storage = path.join(item.root, "project-b-storage"); // Prefix overlap is not containment.
  writeConfig(item.b, { root: storage });
  ready(resolveConfig({ cwd: item.b, env: item.env }));
  const args = ["--prefix", item.b, "test", "--", "space value", "--prefix", "not-a-project"];
  const env = { ...item.env, BOUNDARY_EXIT: "23" }, config = resolveConfig({ cwd: item.a, env });
  const report = explainCommand("npm", args, { ...item, env });
  assert.equal(report.routing.status, "predicted");
  assert.equal(await runTool("npm", args, { ...item, env, config }), 23);
  const captured = JSON.parse(fs.readFileSync(fake.capture));
  assert.deepEqual(captured.args, args);
  assert.equal(captured.cwd, item.a);
  assert.equal(captured.cache, path.join(storage, "caches", "node", "npm"));
  assert.equal(fs.existsSync(config.locations.stateDir), false);
  assert.equal(fs.existsSync(item.configA.root), false);
});

test("independent user cache overrides remain valid when managed roots are external", async (t) => {
  const item = fixture(t), fake = fakeTool(item), explicit = path.join(item.b, "user-owned-cache");
  const env = { ...item.env, npm_config_cache: explicit }, args = ["--prefix", item.b, "test"];
  const report = explainCommand("npm", args, { ...item, env });
  assert.equal(report.routing.variables.find((row) => row.name === "npm_config_cache").action, "preserve");
  assert.equal(await runTool("npm", args, { ...item, env, config: resolved(item) }), 0);
  assert.equal(JSON.parse(fs.readFileSync(fake.capture)).cache, explicit);
  assert.equal(fs.existsSync(explicit), false);
  assert.equal(fs.existsSync(item.configB.root), false);
});

test("explicit skip bypasses malformed target configuration without runtime or storage writes", async (t) => {
  const item = fixture(t), fake = fakeTool(item), config = resolved(item);
  fs.writeFileSync(path.join(item.b, ".clean-development.json"), "{");
  const env = { ...item.env, CLEAN_DEVELOPMENT_SESSION_MODE: "skip", npm_config_cache: "independent-value" };
  const args = ["--prefix", item.b, "test"];
  assert.equal(explainCommand("npm", args, { ...item, env }).routing.status, "skipped");
  assert.equal(await runWithShims("npm", args, { ...item, env, config }), 0);
  const value = JSON.parse(fs.readFileSync(fake.capture));
  assert.equal(value.cache, "independent-value"); assert.equal(value.active, null);
  assert.equal(fs.existsSync(config.locations.dataDir), false);
  assert.equal(fs.existsSync(config.root), false);
});

test("a disabled starting project stays pass-through without reading malformed target config", async (t) => {
  const item = fixture(t), fake = fakeTool(item);
  writeConfig(item.a, { ...item.configA, enabled: false });
  fs.writeFileSync(path.join(item.b, ".clean-development.json"), "{");
  const args = ["--prefix", item.b, "test"], config = resolved(item);
  assert.equal(explainCommand("npm", args, item).routing.status, "disabled");
  assert.equal(await runWithShims("npm", args, { ...item, config }), 0);
  assert.equal(JSON.parse(fs.readFileSync(fake.capture)).active, null);
  assert.equal(fs.existsSync(config.locations.dataDir), false);
  assert.equal(fs.existsSync(config.root), false);
});

test("disabled target routing cleans only inherited managed values and does not prepare runtime", async (t) => {
  const item = fixture(t), fake = fakeTool(item), config = resolved(item);
  const routed = environmentForTool("npm", [], { ...item, config, create: false });
  writeConfig(item.b, { ...item.configB, tools: { npm: false }, cacheRoot: path.join(item.b, "ignored") });
  const args = ["--prefix", item.b, "test"];
  assert.equal(explainCommand("npm", args, { ...item, env: routed.env }).routing.status, "disabled");
  assert.equal(await runWithShims("npm", args, { ...item, config, env: routed.env }), 0);
  assert.equal(JSON.parse(fs.readFileSync(fake.capture)).cache, null);
  assert.equal(fs.existsSync(config.locations.dataDir), false);
  assert.equal(fs.existsSync(config.root), false);
});

test("the final npm prefix selects disabled routing and preserves exact native arguments", async (t) => {
  const item = fixture(t), fake = fakeTool(item), config = resolved(item);
  const routed = environmentForTool("npm", [], { ...item, config, create: false });
  writeConfig(item.b, { ...item.configB, enabled: false });
  const args = ["--prefix", item.a, `--prefix=${item.b}`, "test", "--", "--prefix", item.a];
  assert.equal(explainCommand("npm", args, { ...item, env: routed.env }).routing.status, "disabled");
  assert.equal(await runWithShims("npm", args, { ...item, config, env: routed.env }), 0);
  const captured = JSON.parse(fs.readFileSync(fake.capture));
  assert.deepEqual(captured.args, args);
  assert.equal(captured.cwd, item.a);
  assert.equal(captured.cache, null);
  assert.equal(captured.active, null);
  assert.equal(captured.session, "skip");
  assert.equal(fs.existsSync(config.locations.dataDir), false);
  assert.equal(fs.existsSync(config.root), false);
});

test("the final npm prefix determines the storage boundary before any writes", async (t) => {
  const item = fixture(t), fake = fakeTool(item), config = resolved(item);
  writeConfig(item.b, { root: path.join(item.b, "managed") });
  const args = [`--prefix=${item.a}`, "--prefix", item.b, "test"];
  const before = snapshot(item.root);
  assert.equal(explainCommand("npm", args, item).routing.status, "blocked");
  await assert.rejects(runTool("npm", args, { ...item, config }), boundaryError);
  await assert.rejects(runWithShims("npm", args, { ...item, config }), boundaryError);
  assert.deepEqual(snapshot(item.root), before);
  assert.equal(fs.existsSync(fake.capture), false);
});

for (const disabled of [{ enabled: false }, { tools: { npm: false } }]) {
  test(`disabled target ${JSON.stringify(disabled)} preserves a mixed-case override after another adapter`, async (t) => {
    const item = fixture(t), fake = fakeTool(item), config = resolved(item);
    const first = environmentForTool("npm", [], { ...item, config, create: false });
    const explicit = path.join(item.root, "user-cache");
    const intermediate = environmentForTool("go", [], {
      ...item, config, env: { ...first.env, NPM_CONFIG_CACHE: explicit }, create: false
    });
    writeConfig(item.b, { ...item.configB, ...disabled });
    const args = ["--prefix", item.b, "test", "--", "space value"];
    const env = { ...intermediate.env, BOUNDARY_EXIT: "23" }, before = { ...env };
    assert.equal(explainCommand("npm", args, { ...item, env }).routing.status, "disabled");
    assert.equal(await runWithShims("npm", args, { ...item, config, env }), 23);
    const captured = JSON.parse(fs.readFileSync(fake.capture));
    assert.equal(captured.cache, explicit);
    assert.equal(captured.active, null);
    assert.equal(captured.session, "skip");
    assert.deepEqual(captured.args, args);
    assert.equal(captured.cwd, item.a);
    assert.deepEqual(env, before);
    assert.equal(fs.existsSync(config.locations.dataDir), false);
    assert.equal(fs.existsSync(config.root), false);
    assert.equal(fs.existsSync(item.configB.root), false);
    assert.equal(fs.existsSync(explicit), false);
  });
}

test("selector-looking child arguments after -- do not change the routing project", async (t) => {
  const item = fixture(t), fake = fakeTool(item), config = resolved(item);
  writeConfig(item.b, { root: path.join(item.b, "managed") });
  ready(config);
  const args = ["test", "--", "--prefix", item.b];
  assert.equal(explainCommand("npm", args, item).routing.status, "predicted");
  assert.equal(await runTool("npm", args, { ...item, config }), 0);
  assert.equal(JSON.parse(fs.readFileSync(fake.capture)).cache, path.join(config.cacheRoot, "node", "npm"));
});

test("public CLI rejects target conflicts before preparing storage or persisting session settings", (t) => {
  const item = fixture(t); fakeTool(item);
  fs.unlinkSync(path.join(item.a, ".clean-development.json"));
  const env = { ...item.env, CLEAN_DEVELOPMENT_ROOT: item.configA.root };
  writeConfig(item.b, { cacheRoot: path.join(item.b, "local-cache") });
  const before = snapshot(item.root);
  for (const mode of ["session-only", "persist"]) {
    const result = spawnSync(process.execPath, [cli, "run", "--session", mode, "--", "npm", "--prefix", item.b, "test"],
      { cwd: item.a, env, encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Managed storage must be outside the project/);
    assert.deepEqual(snapshot(item.root), before);
  }
});

test("home exception does not exempt target projects nested beneath home", (t) => {
  const item = fixture(t), home = path.dirname(item.a);
  const env = { ...item.env, CLEAN_DEVELOPMENT_HOME: home };
  const homeConfig = resolveConfig({ cwd: home, env });
  assert.deepEqual(planSession({ cwd: home, env, config: homeConfig }).managed.repositoryPaths, []);
  writeConfig(item.b, { cacheRoot: path.join(item.b, "local") });
  assert.equal(explainCommand("npm", ["--prefix", item.b, "test"], { cwd: home, env }).routing.status, "blocked");
});

test("symlink or junction aliases do not conceal storage inside a target project", async (t) => {
  const item = fixture(t), alias = path.join(item.root, "alias");
  fs.symlinkSync(item.b, alias, process.platform === "win32" ? "junction" : "dir");
  writeConfig(item.b, { cacheRoot: path.join(alias, "local") });
  const before = snapshot(item.root), args = ["--prefix", item.b, "test"];
  assert.equal(explainCommand("npm", args, item).routing.status, "blocked");
  await assert.rejects(runTool("npm", args, { ...item, config: resolved(item) }), boundaryError);
  assert.deepEqual(snapshot(item.root), before);
});

test("Cargo authoritative roots are rechecked before ownership writes or the actual build command", async (t) => {
  const item = fixture(t), fake = fakeTool(item, "cargo"), external = path.join(item.root, "external-workspace");
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, "Cargo.toml"), '[workspace]\nmembers=[]\n');
  fs.appendFileSync(path.join(item.b, "Cargo.toml"), 'workspace="../external-workspace"\n');
  writeConfig(item.b, { root: path.join(external, "managed") });
  const env = { ...item.env, BOUNDARY_CARGO_ROOT: path.join(external, "Cargo.toml") };
  const args = ["check", "--manifest-path", path.join(item.b, "Cargo.toml")], config = resolved(item);
  const before = snapshot(item.root);
  const report = explainCommand("cargo", args, { ...item, env });
  assert.equal(report.routing.status, "predicted"); // Static estimate cannot know the external workspace.
  assert.match(report.workspace.authority, /static estimate/);
  assert.deepEqual(snapshot(item.root), before);
  await assert.rejects(runTool("cargo", args, { ...item, env, config }), boundaryError);
  assert.equal(fs.existsSync(fake.discovery), true);
  assert.equal(fs.existsSync(fake.capture), false);
  fs.unlinkSync(fake.discovery); // Only the fixture Cargo executable wrote this evidence.
  assert.deepEqual(snapshot(item.root), before);
});
