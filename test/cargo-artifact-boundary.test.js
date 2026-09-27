import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { environmentForTool } from "../src/adapters.js";
import { resolveConfig } from "../src/config.js";
import { explainCommand } from "../src/explain.js";
import { runTool } from "../src/runtime.js";
import { applyPrune, listWorkspaceRecords, prunePlan } from "../src/state.js";
import { isolatedEnvironment } from "../scripts/harness-utils.mjs";

const CLI = fileURLToPath(new URL("../bin/clean-development.js", import.meta.url));

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cd-artifact-policy-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  for (const dir of [project, bin, home, "managed/builds", "managed/caches", "managed/scratch"].map(p => path.isAbsolute(p) ? p : path.join(root, p))) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(project, "Cargo.toml"), '[package]\nname="fixture"\nversion="0.1.0"\n');
  const env = { ...isolatedEnvironment(root), HOME: home, USERPROFILE: home,
    CARGO_HOME: path.join(root, "cargo-home"), PATH: [bin, path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
    CAPTURE: path.join(root, "capture.json") };
  delete env.CARGO_BUILD_TARGET_DIR;
  const cargo = path.join(bin, "cargo");
  fs.writeFileSync(cargo, `#!${process.execPath}\nconst fs = require('node:fs');\nfs.writeFileSync(process.env.CAPTURE, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), target: process.env.CARGO_TARGET_DIR, buildTarget: process.env.CARGO_BUILD_TARGET_DIR, marker: process.env.CLEAN_DEVELOPMENT_CARGO_TARGET_DIR, provenance: process.env.CLEAN_DEVELOPMENT_SESSION_ENV, cache: process.env.npm_config_cache }));\n`, { mode: 0o755 });
  return { root, project, bin, env, config: resolveConfig({ cwd: project, env }) };
}

// These are process/ownership regressions with an explicitly fake Cargo. Real
// compiler and archive-byte coverage lives in artifact-deliverables.test.js.
for (const args of [
  ["build"], ["build", "--release"], ["b", "-r"], ["build", "--profile", "shipping"],
  ["package", "--offline"], ["publish", "--dry-run"], ["rustc", "--release"],
  ["test", "--no-run"], ["bench", "--no-run"], ["check", "--timings"],
  ["release"], ["custom-command", "check"], ["--future-flag", "check"],
  ["check", "--new-output-option=elsewhere"], ["check", "--config", 'build.target-dir="elsewhere"']
]) {
  test(`Cargo refuses unreviewed deliverable/ambiguous routing: ${args.join(" ")}`, { skip: process.platform === "win32" }, async (t) => {
    const f = fixture(t);
    await assert.rejects(runTool("cargo", args, { config: f.config, cwd: f.project, env: f.env }), { code: "ERR_CARGO_ARTIFACT_BOUNDARY" });
    assert.equal(fs.existsSync(f.env.CAPTURE), false);
    assert.deepEqual(listWorkspaceRecords(f.config), []);
    assert.deepEqual(fs.readdirSync(f.config.buildRoot), []);
    assert.equal(fs.existsSync(path.join(f.project, "target")), false);
  });
}

test("deliverable commands preserve external CLI targets, remove only injected Cargo values, and do not acquire ownership", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t);
  const parent = environmentForTool("cargo", ["check"], { config: f.config, cwd: f.project, env: f.env, create: false });
  const target = path.join(f.root, "final output=東京");
  const cache = path.join(f.root, "independent-npm-cache");
  for (const args of [["build", "--release", "--target-dir", target], ["package", `--target-dir=${target}`]]) {
    const env = { ...parent.env, npm_config_cache: cache };
    const before = { ...env };
    assert.equal(await runTool("cargo", args, { config: f.config, cwd: f.project, env }), 0);
    const observed = JSON.parse(fs.readFileSync(f.env.CAPTURE));
    assert.deepEqual(observed.argv, args);
    assert.equal(observed.cwd, f.project);
    assert.equal(observed.target, undefined);
    assert.equal(observed.marker, undefined);
    assert.equal(JSON.parse(observed.provenance).CARGO_TARGET_DIR, undefined);
    assert.equal(observed.cache, cache);
    assert.deepEqual(env, before);
    assert.deepEqual(listWorkspaceRecords(f.config), []);
    assert.deepEqual(fs.readdirSync(f.config.buildRoot), []);
  }
});

test("an independent Cargo output environment wins even under force; explicit paths into managed storage are refused", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t);
  const target = path.join(f.root, "user-deliverables");
  const env = { ...f.env, CARGO_TARGET_DIR: target, CLEAN_DEVELOPMENT_FORCE: "1" };
  assert.equal(await runTool("cargo", ["build", "--release"], { config: f.config, cwd: f.project, env }), 0);
  assert.equal(JSON.parse(fs.readFileSync(f.env.CAPTURE)).target, target);
  assert.deepEqual(listWorkspaceRecords(f.config), []);
  fs.unlinkSync(f.env.CAPTURE);
  assert.equal(await runTool("cargo", ["check"], { config: f.config, cwd: f.project, env: f.env }), 0);
  const record = listWorkspaceRecords(f.config)[0].value;
  const managedTarget = path.join(record.path, "cargo", "target");
  fs.unlinkSync(f.env.CAPTURE);
  for (const args of [["package", "--target-dir", managedTarget], ["build", "--release", `--target-dir=${managedTarget}`]]) {
    await assert.rejects(runTool("cargo", args, { config: f.config, cwd: f.project, env: f.env }), { code: "ERR_CARGO_ARTIFACT_BOUNDARY" });
    assert.equal(fs.existsSync(f.env.CAPTURE), false);
  }
  // Changing the currently selected build root must not hide old prune authority.
  const alternate = { ...f.config, buildRoot: path.join(f.root, "new-builds") };
  await assert.rejects(runTool("cargo", ["package"], { config: alternate, cwd: f.project, env: { ...f.env, CARGO_TARGET_DIR: managedTarget } }), { code: "ERR_CARGO_ARTIFACT_BOUNDARY" });
  // A copied/exported output path inside the managed tree is unsafe too.
  await assert.rejects(runTool("cargo", ["build", "--target-dir", target, "--artifact-dir", managedTarget], { config: f.config, cwd: f.project, env: f.env }), { code: "ERR_CARGO_ARTIFACT_BOUNDARY" });
});

test("explicit intermediate CLI targets do not inject a second target for nested commands", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t);
  assert.equal(await runTool("cargo", ["check", "--target-dir", path.join(f.root, "external")], { config: f.config, cwd: f.project, env: f.env }), 0);
  assert.equal(JSON.parse(fs.readFileSync(f.env.CAPTURE)).target, undefined);
  assert.deepEqual(listWorkspaceRecords(f.config), []);
  assert.deepEqual(fs.readdirSync(f.config.buildRoot), []);
});

test("read-only explanation reports the deliverable boundary instead of promising a disposable release target", (t) => {
  const f = fixture(t);
  const report = explainCommand("cargo", ["build", "--release"], { cwd: f.project, env: f.env });
  assert.equal(report.routing.status, "blocked");
  assert.match(report.routing.reason, /deliverable|artifact/i);
  assert.deepEqual(report.routing.variables, []);
  assert.equal(fs.existsSync(f.env.CAPTURE), false);
  assert.deepEqual(fs.readdirSync(f.config.buildRoot), []);
});

test("nested package scripts cannot turn a disposable Cargo target into an implicit release destination", { skip: process.platform === "win32" }, (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.project, "package.json"), JSON.stringify({ scripts: { outer: "npm run inner", inner: "cargo package --offline" } }));
  // Real npm; PATH contains only a fake Cargo backend, which must never run.
  const npm = spawnSync("npm", ["--version"], { encoding: "utf8" });
  assert.equal(npm.status, 0);
  const parent = environmentForTool("cargo", ["check"], { config: f.config, cwd: f.project, env: f.env, create: false });
  const env = { ...parent.env, PATH: [f.bin, path.dirname(process.execPath), process.env.PATH].join(path.delimiter),
    npm_config_userconfig: path.join(f.root, "npmrc"), npm_config_globalconfig: path.join(f.root, "global-npmrc"), npm_config_offline: "true" };
  const result = spawnSync(process.execPath, [CLI, "run", "--session", "session-only", "--", "npm", "run", "outer"], { cwd: f.project, env, encoding: "utf8", timeout: 30000, maxBuffer: 262144 });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /artifact|deliverable/i);
  assert.equal(fs.existsSync(f.env.CAPTURE), false);
  assert.deepEqual(listWorkspaceRecords(f.config), []);
});

test("disposable check output is still prunable; source and external deliverables survive", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t);
  const source = fs.readFileSync(path.join(f.project, "Cargo.toml"));
  const final = path.join(f.root, "signed-artifact");
  const bytes = Buffer.from([0, 1, 255, 10, 42]);
  fs.writeFileSync(final, bytes);
  assert.equal(await runTool("cargo", ["check"], { config: f.config, cwd: f.project, env: f.env }), 0);
  const record = listWorkspaceRecords(f.config)[0];
  fs.writeFileSync(path.join(record.value.path, "intermediate"), "discardable");
  record.value.lastUsedAt = "2000-01-01T00:00:00.000Z";
  fs.writeFileSync(record.file, JSON.stringify(record.value));
  const plan = prunePlan(f.config, { olderThanDays: 1 });
  assert.ok(plan.some(entry => entry.eligible));
  await applyPrune(f.config, plan);
  assert.equal(fs.existsSync(record.value.path), false);
  assert.deepEqual(fs.readFileSync(final), bytes);
  assert.deepEqual(fs.readFileSync(path.join(f.project, "Cargo.toml")), source);
});

test("native Cargo configuration is not silently overridden and independent build.target-dir environment is preserved", { skip: process.platform === "win32" }, async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.project, ".cargo"));
  const file = path.join(f.project, ".cargo", "config.toml");
  fs.writeFileSync(file, '[build]\ntarget-dir="user-output"\n');
  const saved = fs.readFileSync(file);
  await assert.rejects(runTool("cargo", ["check"], { config: f.config, cwd: f.project, env: f.env }), { code: "ERR_CARGO_ARTIFACT_BOUNDARY" });
  assert.equal(fs.existsSync(f.env.CAPTURE), false);
  const target = path.join(f.root, "native-output");
  assert.equal(await runTool("cargo", ["build", "--release"], { config: f.config, cwd: f.project, env: { ...f.env, CARGO_BUILD_TARGET_DIR: target, CLEAN_DEVELOPMENT_FORCE: "1" } }), 0);
  const observed = JSON.parse(fs.readFileSync(f.env.CAPTURE));
  assert.equal(observed.target, undefined);
  assert.equal(observed.buildTarget, target);
  assert.deepEqual(fs.readFileSync(file), saved);
  assert.deepEqual(listWorkspaceRecords(f.config), []);
});

test("canonical deliverable targets reject symlinks into build storage but allow similarly named siblings", { skip: process.platform === "win32" }, async t => {
  const f = fixture(t);
  const alias = path.join(f.root, "output-alias");
  fs.symlinkSync(f.config.buildRoot, alias, "dir");
  for (const target of [f.config.buildRoot, path.join(alias, "release"), "../managed/builds/release"]) {
    await assert.rejects(runTool("cargo", ["build", "--release", "--target-dir", target], { config: f.config, cwd: f.project, env: f.env }), { code: "ERR_CARGO_ARTIFACT_BOUNDARY" });
    assert.equal(fs.existsSync(f.env.CAPTURE), false);
  }
  const sibling = `${f.config.buildRoot}-deliverables`;
  assert.equal(await runTool("cargo", ["build", "--target-dir", sibling], { config: f.config, cwd: f.project, env: f.env }), 0);
  assert.deepEqual(fs.readdirSync(f.config.buildRoot), []);
});

test("malformed, repeated and unknown Cargo output syntax cannot grant ownership even with an external target", { skip: process.platform === "win32" }, async t => {
  const f = fixture(t);
  for (const args of [
    ["check", "--target-dir"], ["check", "--target-dir="],
    ["check", "--target-dir", "one", "--target-dir=two"],
    ["build", "--target-dir", "safe", "--", "--out-dir", "elsewhere"],
    ["check", "--unexpected", "--target-dir", "safe"], ["alias", "--target-dir", "safe"]
  ]) {
    await assert.rejects(runTool("cargo", args, { config: f.config, cwd: f.project, env: f.env }), { code: "ERR_CARGO_ARTIFACT_BOUNDARY" });
  }
  assert.equal(fs.existsSync(f.env.CAPTURE), false);
  assert.deepEqual(listWorkspaceRecords(f.config), []);
});

test("Cargo run program arguments are not reinterpreted; inspection and explicit skip never register a build", { skip: process.platform === "win32" }, async t => {
  const f = fixture(t);
  const args = ["run", "--", "--target-dir", "program-option", "--no-run"];
  assert.equal(await runTool("cargo", args, { config: f.config, cwd: f.project, env: f.env }), 0);
  let observed = JSON.parse(fs.readFileSync(f.env.CAPTURE));
  assert.deepEqual(observed.argv, args);
  assert.match(observed.target, /cargo[/\\]target$/);
  const before = listWorkspaceRecords(f.config).map(record => fs.readFileSync(record.file, "utf8"));
  const inherited = environmentForTool("cargo", ["check"], { config: f.config, cwd: f.project, env: f.env, create: false }).env;
  for (const command of [[], ["--version"], ["help", "build"], ["package", "--list"]]) {
    assert.equal(await runTool("cargo", command, { config: f.config, cwd: f.project, env: inherited }), 0);
    observed = JSON.parse(fs.readFileSync(f.env.CAPTURE));
    assert.equal(observed.target, undefined);
  }
  assert.equal(await runTool("cargo", ["build", "--release"], { config: f.config, cwd: f.project, env: { ...inherited, CLEAN_DEVELOPMENT_SESSION_MODE: "skip" } }), 0);
  assert.equal(JSON.parse(fs.readFileSync(f.env.CAPTURE)).target, undefined);
  assert.deepEqual(listWorkspaceRecords(f.config).map(record => fs.readFileSync(record.file, "utf8")), before);
});

test("cache-only tools refuse recognised final-output flags into prune authority in execution and explanation", { skip: process.platform === "win32" }, async t => {
  const f = fixture(t);
  const alias = path.join(f.root, "managed-alias");
  fs.symlinkSync(f.config.buildRoot, alias, "dir");
  for (const [tool, args, overrides] of [
    ["go", ["build", "-o", path.join(alias, "binary")], {}],
    ["go", ["test", `-o=${f.config.buildRoot}/test-binary`], {}],
    ["npm", ["pack", "--pack-destination", alias], {}],
    ["npm", ["pack"], { npm_config_pack_destination: alias }],
    ["uv", ["build", `--out-dir=${alias}`], {}], ["uv", ["build", "-o", alias], {}]
  ]) {
    const env = { ...f.env, ...overrides };
    const report = explainCommand(tool, args, { cwd: f.project, env });
    assert.equal(report.routing.status, "blocked");
    assert.match(report.routing.reason, /intersects managed build storage/);
    await assert.rejects(runTool(tool, args, { config: f.config, cwd: f.project, env }), { code: "ERR_ARTIFACT_OUTPUT_BOUNDARY" });
  }
  assert.deepEqual(listWorkspaceRecords(f.config), []);
  assert.deepEqual(fs.readdirSync(f.config.buildRoot), []);
});
