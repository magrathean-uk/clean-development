import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { environmentForTool } from "../src/adapters.js";
import { resolveConfig } from "../src/config.js";
import { ensureRuntime, removeRuntime, resolveExecutable, runTool, runtimeHealth, spawnInherited, windowsBatchInvocation } from "../src/runtime.js";
import { acquireWorkspaceLock, activeWorkspaceIds, prunePlan, workspaceRecord } from "../src/state.js";
import { identifyWorkspace } from "../src/workspace.js";

const CLI = fileURLToPath(new URL("../bin/clean-development.js", import.meta.url));

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clean-development-regression-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  const bin = path.join(root, "bin");
  for (const directory of [first, second, bin]) fs.mkdirSync(directory);
  for (const project of [first, second]) fs.writeFileSync(path.join(project, "Cargo.toml"), `[package]\nname="${path.basename(project)}"\nversion="0.1.0"\n`);
  const env = {
    ...process.env,
    CLEAN_DEVELOPMENT_HOME: path.join(root, "home"),
    CLEAN_DEVELOPMENT_DATA_HOME: path.join(root, "data"),
    CLEAN_DEVELOPMENT_CONFIG_HOME: path.join(root, "config"),
    CLEAN_DEVELOPMENT_ROOT: path.join(root, "managed"),
    PATH: bin
  };
  for (const key of ["CARGO_TARGET_DIR", "CLEAN_DEVELOPMENT_CARGO_TARGET_DIR", "CLEAN_DEVELOPMENT_FORCE", "YARN_CACHE_FOLDER", "YARN_ENABLE_GLOBAL_CACHE", "YARN_ENABLE_MIRROR"]) delete env[key];
  for (const directory of ["caches", "builds", "scratch"]) fs.mkdirSync(path.join(root, "managed", directory), { recursive: true });
  return { root, first, second, bin, env, config: resolveConfig({ cwd: first, env }) };
}

function fakeCargo(item, body) {
  fs.writeFileSync(path.join(item.bin, "cargo"), `#!${process.execPath}\nconst fs = require('node:fs');\n${body}\n`, { mode: 0o755 });
}

test("nested Cargo re-routes inherited managed output and still preserves a changed explicit target", (t) => {
  const item = fixture(t);
  const first = environmentForTool("cargo", [], { config: item.config, cwd: item.first, env: item.env, create: false });
  const second = environmentForTool("cargo", [], { config: item.config, cwd: item.second, env: first.env, create: false });
  assert.notEqual(first.env.CARGO_TARGET_DIR, second.env.CARGO_TARGET_DIR);
  assert.ok(second.env.CARGO_TARGET_DIR.includes(second.workspace.id));
  const explicit = path.join(item.root, "explicit-output");
  const overridden = environmentForTool("cargo", [], { config: item.config, cwd: item.second, env: { ...first.env, CARGO_TARGET_DIR: explicit }, create: false });
  assert.equal(overridden.env.CARGO_TARGET_DIR, explicit);
  assert.equal(overridden.env.CLEAN_DEVELOPMENT_CARGO_TARGET_DIR, undefined);
});

test("Cargo recognizes lowercased inherited routing markers and emits one canonical marker set", (t) => {
  const item = fixture(t);
  const first = environmentForTool("cargo", [], { config: item.config, cwd: item.first, env: item.env, create: false });
  const inherited = { ...first.env };
  for (const name of [
    "CARGO_TARGET_DIR",
    "CLEAN_DEVELOPMENT_CARGO_TARGET_DIR",
    "CLEAN_DEVELOPMENT_ACTIVE",
    "CLEAN_DEVELOPMENT_RESOLVED_ROOT",
    "CLEAN_DEVELOPMENT_WORKSPACE_ID",
    "CLEAN_DEVELOPMENT_WORKSPACE"
  ]) {
    inherited[name.toLowerCase()] = inherited[name];
    delete inherited[name];
  }
  const rerouted = environmentForTool("cargo", [], { config: item.config, cwd: item.second, env: inherited, create: false });
  assert.notEqual(rerouted.env.CARGO_TARGET_DIR, first.env.CARGO_TARGET_DIR);
  assert.equal(rerouted.env.CLEAN_DEVELOPMENT_CARGO_TARGET_DIR, rerouted.env.CARGO_TARGET_DIR);
  for (const name of [
    "CARGO_TARGET_DIR",
    "CLEAN_DEVELOPMENT_CARGO_TARGET_DIR",
    "CLEAN_DEVELOPMENT_ACTIVE",
    "CLEAN_DEVELOPMENT_RESOLVED_ROOT",
    "CLEAN_DEVELOPMENT_WORKSPACE_ID",
    "CLEAN_DEVELOPMENT_WORKSPACE"
  ]) {
    assert.equal(Object.keys(rerouted.env).filter((key) => key.toLowerCase() === name.toLowerCase()).length, 1);
  }
});

test("a Cargo child launched through another workspace shim receives its own registered target", { skip: process.platform === "win32" }, async (t) => {
  const item = fixture(t);
  const capture = path.join(item.root, "capture.json");
  fakeCargo(item, `
if (process.argv[2] === 'parent') {
  const result = require('node:child_process').spawnSync(process.execPath, [process.env.CLI, 'shim', 'cargo', '--', 'child'], { cwd: process.env.SECOND, env: process.env, stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
fs.writeFileSync(process.env.CAPTURE, JSON.stringify({ target: process.env.CARGO_TARGET_DIR, workspace: process.env.CLEAN_DEVELOPMENT_WORKSPACE_ID }));`);
  assert.equal(await runTool("cargo", ["parent"], { config: item.config, cwd: item.first, env: { ...item.env, CLI, SECOND: item.second, CAPTURE: capture } }), 0);
  const observed = JSON.parse(fs.readFileSync(capture, "utf8"));
  const second = identifyWorkspace("cargo", [], item.second);
  assert.equal(observed.workspace, second.id);
  assert.equal(observed.target, path.join(item.config.buildRoot, second.id, "cargo", "target"));
  assert.equal(fs.existsSync(path.join(item.config.buildRoot, second.id, ".clean-development-owned.json")), true);
});

test("explicit environment and CLI targets belonging to another managed workspace lease that owner", { skip: process.platform === "win32" }, async (t) => {
  const item = fixture(t);
  fakeCargo(item, "if (process.argv[2] === 'wait') setTimeout(() => {}, 300);");
  await runTool("cargo", [], { config: item.config, cwd: item.first, env: item.env });
  const first = identifyWorkspace("cargo", [], item.first);
  const second = identifyWorkspace("cargo", [], item.second);
  const target = path.join(item.config.buildRoot, first.id, "cargo", "target");
  for (const options of [
    { args: ["wait"], env: { ...item.env, CARGO_TARGET_DIR: target } },
    { args: ["wait"], env: { ...item.env, CARGO_TARGET_DIR: path.join(item.config.buildRoot, first.id, "cargo", "custom") } },
    { args: ["wait", "--target-dir", target], env: item.env },
    { args: ["wait", `--target-dir=${target}`], env: item.env }
  ]) {
    const execution = runTool("cargo", options.args, { config: item.config, cwd: item.second, env: options.env });
    const deadline = Date.now() + 3000;
    while (!activeWorkspaceIds(item.config).has(second.id) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    const active = activeWorkspaceIds(item.config);
    assert.ok(active.has(first.id));
    assert.ok(active.has(second.id));
    assert.equal(prunePlan(item.config, { olderThanDays: 0 }).find((entry) => entry.workspaceId === first.id).reason, "active");
    assert.equal(await execution, 0);
    assert.equal(activeWorkspaceIds(item.config).size, 0);
  }
});

test("Cargo rejects an owned build container as its target before cargo clean can remove the marker", { skip: process.platform === "win32" }, async (t) => {
  const item = fixture(t);
  fakeCargo(item, "");
  await runTool("cargo", [], { config: item.config, cwd: item.first, env: item.env });
  const first = identifyWorkspace("cargo", [], item.first);
  const container = path.join(item.config.buildRoot, first.id);
  const invoked = path.join(item.root, "clean-was-invoked");
  fakeCargo(item, "fs.writeFileSync(process.env.INVOKED, 'yes');");
  await assert.rejects(runTool("cargo", ["clean"], { config: item.config, cwd: item.second, env: { ...item.env, CARGO_TARGET_DIR: container, INVOKED: invoked } }), /owned build directory itself/);
  await assert.rejects(runTool("cargo", ["clean", "--target-dir", container], { config: item.config, cwd: item.first, env: { ...item.env, INVOKED: invoked } }), /owned build directory itself/);
  assert.equal(fs.existsSync(invoked), false);
  assert.equal(fs.existsSync(path.join(container, ".clean-development-owned.json")), true);
  assert.ok(workspaceRecord(item.config, first.id).value);
});

test("Cargo discovers and leases an owner whose first record appears while waiting for a workspace lock", { skip: process.platform === "win32" }, async (t) => {
  const item = fixture(t);
  fakeCargo(item, "if (process.argv[2] === 'wait') setTimeout(() => {}, 300);");
  const first = identifyWorkspace("cargo", [], item.first);
  const second = identifyWorkspace("cargo", [], item.second);
  const target = path.join(item.config.buildRoot, first.id, "cargo", "custom");
  const releaseSecond = await acquireWorkspaceLock(item.config, second.id);
  const execution = runTool("cargo", ["wait"], { config: item.config, cwd: item.second, env: { ...item.env, CARGO_TARGET_DIR: target } });
  try {
    assert.equal(workspaceRecord(item.config, first.id).value, null);
    assert.equal(await runTool("cargo", [], { config: item.config, cwd: item.first, env: item.env }), 0);
    assert.ok(workspaceRecord(item.config, first.id).value);
  } finally {
    releaseSecond();
  }
  const deadline = Date.now() + 3000;
  while (!activeWorkspaceIds(item.config).has(second.id) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  const active = activeWorkspaceIds(item.config);
  assert.ok(active.has(first.id));
  assert.ok(active.has(second.id));
  assert.equal(prunePlan(item.config, { olderThanDays: 0 }).find((entry) => entry.workspaceId === first.id).reason, "active");
  assert.equal(await execution, 0);
  assert.equal(activeWorkspaceIds(item.config).size, 0);
});

test("Cargo rejects still-unowned explicit targets inside effective or recorded managed build roots", { skip: process.platform === "win32" }, async (t) => {
  const item = fixture(t);
  const invoked = path.join(item.root, "cargo-was-invoked");
  fakeCargo(item, "if (process.env.INVOKED) fs.writeFileSync(process.env.INVOKED, 'yes');");
  const first = identifyWorkspace("cargo", [], item.first);
  const second = identifyWorkspace("cargo", [], item.second);
  const target = path.join(item.config.buildRoot, first.id, "cargo", "custom");
  const releaseSecond = await acquireWorkspaceLock(item.config, second.id);
  const execution = runTool("cargo", [], { config: item.config, cwd: item.second, env: { ...item.env, CARGO_TARGET_DIR: target, INVOKED: invoked } });
  const rejected = assert.rejects(execution, /unowned explicit Cargo target inside managed build root/);
  assert.equal(workspaceRecord(item.config, first.id).value, null);
  releaseSecond();
  await rejected;
  assert.equal(fs.existsSync(invoked), false);
  assert.equal(fs.existsSync(target), false);
  await assert.rejects(runTool("cargo", ["clean", "--target-dir", item.config.buildRoot], { config: item.config, cwd: item.second, env: item.env }), /unowned explicit Cargo target inside managed build root/);
  // The normal injected target still creates the first owned workspace safely.
  assert.equal(await runTool("cargo", [], { config: item.config, cwd: item.first, env: item.env }), 0);
  assert.ok(workspaceRecord(item.config, first.id).value);
  const alternateRoot = path.join(item.root, "alternate-builds");
  fs.mkdirSync(alternateRoot);
  const alternateConfig = { ...item.config, buildRoot: alternateRoot };
  await assert.rejects(runTool("cargo", ["build", `--target-dir=${path.join(item.config.buildRoot, "not-yet-owned", "cargo", "custom")}`], { config: alternateConfig, cwd: item.second, env: { ...item.env, INVOKED: invoked } }), /unowned explicit Cargo target inside managed build root/);
  assert.equal(fs.existsSync(invoked), false);
});

test("nested owned roots reject the inner container and protect every containing owner for an inner target", { skip: process.platform === "win32" }, async (t) => {
  const item = fixture(t);
  fakeCargo(item, "if (process.env.INVOKED) fs.writeFileSync(process.env.INVOKED, 'yes'); if (process.argv[2] === 'wait') setTimeout(() => {}, 300);");
  assert.equal(await runTool("cargo", [], { config: item.config, cwd: item.first, env: item.env }), 0);
  const outer = identifyWorkspace("cargo", [], item.first);
  const outerRecord = workspaceRecord(item.config, outer.id);
  const nestedRoot = path.join(outerRecord.value.path, "nested-builds");
  fs.mkdirSync(nestedRoot);
  const innerConfig = { ...item.config, buildRoot: nestedRoot };
  assert.equal(await runTool("cargo", [], { config: innerConfig, cwd: item.second, env: item.env }), 0);
  const inner = identifyWorkspace("cargo", [], item.second);
  const innerRecord = workspaceRecord(innerConfig, inner.id);
  const third = path.join(item.root, "third");
  fs.mkdirSync(third);
  fs.writeFileSync(path.join(third, "Cargo.toml"), '[package]\nname="third"\nversion="0.1.0"\n');
  const caller = identifyWorkspace("cargo", [], third);
  const invoked = path.join(item.root, "clean-was-invoked");
  await assert.rejects(runTool("cargo", ["clean"], { config: item.config, cwd: third, env: { ...item.env, CARGO_TARGET_DIR: innerRecord.value.path, INVOKED: invoked } }), /owned build directory itself/);
  for (const unownedTarget of [nestedRoot, path.join(nestedRoot, "not-yet-owned", "cargo", "custom")]) {
    await assert.rejects(runTool("cargo", ["clean"], { config: item.config, cwd: third, env: { ...item.env, CARGO_TARGET_DIR: unownedTarget, INVOKED: invoked } }), /unowned explicit Cargo target inside managed build root/);
  }
  assert.equal(fs.existsSync(invoked), false);
  assert.equal(fs.existsSync(path.join(innerRecord.value.path, ".clean-development-owned.json")), true);
  for (const record of [outerRecord, innerRecord]) fs.writeFileSync(record.file, JSON.stringify({ ...record.value, lastUsedAt: "2000-01-01T00:00:00.000Z" }));
  const started = Date.now();
  const execution = runTool("cargo", ["wait"], { config: item.config, cwd: third, env: { ...item.env, CARGO_TARGET_DIR: path.join(innerRecord.value.path, "cargo", "custom") } });
  const deadline = Date.now() + 3000;
  while (!activeWorkspaceIds(item.config).has(caller.id) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  const active = activeWorkspaceIds(item.config);
  assert.ok(active.has(outer.id));
  assert.ok(active.has(inner.id));
  assert.ok(active.has(caller.id));
  assert.equal(prunePlan(item.config, { olderThanDays: 0 }).find((entry) => entry.workspaceId === outer.id).reason, "active");
  assert.equal(prunePlan(innerConfig, { olderThanDays: 0 }).find((entry) => entry.workspaceId === inner.id).reason, "active");
  assert.equal(await execution, 0);
  for (const [config, workspace] of [[item.config, outer], [innerConfig, inner]]) {
    assert.ok(Date.parse(workspaceRecord(config, workspace.id).value.lastUsedAt) >= started);
    assert.equal(prunePlan(config).find((entry) => entry.workspaceId === workspace.id).reason, "recent");
  }
});

test("using another workspace's custom target refreshes its retention age and preserves ownership and pin", { skip: process.platform === "win32" }, async (t) => {
  const item = fixture(t);
  fakeCargo(item, "fs.mkdirSync(process.env.CARGO_TARGET_DIR, { recursive: true }); fs.writeFileSync(require('node:path').join(process.env.CARGO_TARGET_DIR, 'used'), 'built');");
  await runTool("cargo", [], { config: item.config, cwd: item.first, env: item.env });
  const first = identifyWorkspace("cargo", [], item.first);
  const record = workspaceRecord(item.config, first.id);
  const target = path.join(item.config.buildRoot, first.id, "cargo", "custom");
  for (const pinned of [false, true]) {
    const stale = { ...record.value, lastUsedAt: "2000-01-01T00:00:00.000Z", pinned };
    fs.writeFileSync(record.file, JSON.stringify(stale));
    if (!pinned) assert.equal(prunePlan(item.config).find((entry) => entry.workspaceId === first.id).eligible, true);
    const started = Date.now();
    assert.equal(await runTool("cargo", [], { config: item.config, cwd: item.second, env: { ...item.env, CARGO_TARGET_DIR: target } }), 0);
    const refreshed = workspaceRecord(item.config, first.id).value;
    assert.ok(Date.parse(refreshed.lastUsedAt) >= started);
    assert.deepEqual(refreshed, { ...stale, lastUsedAt: refreshed.lastUsedAt });
    assert.equal(fs.readFileSync(path.join(target, "used"), "utf8"), "built");
    const plan = prunePlan(item.config).find((entry) => entry.workspaceId === first.id);
    assert.equal(plan.eligible, false);
    assert.equal(plan.reason, pinned ? "pinned" : "recent");
  }
});

test("runtime update and uninstall accept receipts created with a different Node executable", (t) => {
  const item = fixture(t);
  const original = process.execPath;
  try {
    process.execPath = path.join(item.root, "previous-node");
    ensureRuntime(item.config);
  } finally {
    process.execPath = original;
  }
  const runtime = ensureRuntime(item.config);
  const receipt = JSON.parse(fs.readFileSync(path.join(item.config.locations.stateDir, "runtime.json"), "utf8"));
  assert.equal(receipt.node, original);
  const launcher = path.join(runtime.binDir, process.platform === "win32" ? "cargo.cmd" : "cargo");
  assert.ok(fs.readFileSync(launcher, "utf8").includes(original));
  try {
    process.execPath = path.join(item.root, "yet-another-node");
    assert.ok(removeRuntime(item.config).removed.includes(launcher));
  } finally {
    process.execPath = original;
  }
});

test("runtime health verifies the installed launcher inventory without changing it", (t) => {
  const item = fixture(t);
  const runtime = ensureRuntime(item.config);
  const launcher = path.join(runtime.binDir, process.platform === "win32" ? "cargo.cmd" : "cargo");
  assert.equal(runtimeHealth(item.config).ok, true);
  fs.unlinkSync(launcher);
  const health = runtimeHealth(item.config);
  assert.equal(health.ok, false);
  assert.match(health.detail, /missing or unsafe/);
  assert.equal(fs.existsSync(launcher), false);
});

test("executable probing reads at most a 4096-byte prefix of a large binary", (t) => {
  const item = fixture(t);
  const command = path.join(item.bin, "large-tool");
  const descriptor = fs.openSync(command, "w", 0o755);
  fs.ftruncateSync(descriptor, 32 * 1024 * 1024);
  fs.closeSync(descriptor);
  const read = fs.readSync;
  let total = 0;
  t.mock.method(fs, "readSync", (...args) => {
    const bytes = read(...args);
    total += bytes;
    return bytes;
  });
  assert.equal(resolveExecutable("large-tool", item.env), command);
  assert.equal(total, 4096);
});

test("Yarn cache routing disables the global cache and mirror while honoring explicit mode overrides", (t) => {
  const item = fixture(t);
  const routed = environmentForTool("yarn", [], { config: item.config, cwd: item.first, env: item.env });
  assert.equal(routed.env.YARN_ENABLE_GLOBAL_CACHE, "false");
  assert.equal(routed.env.YARN_ENABLE_MIRROR, "false");
  assert.ok(fs.statSync(routed.env.YARN_CACHE_FOLDER).isDirectory());
  assert.equal(fs.existsSync(path.join(item.config.cacheRoot, "false")), false);
  const preserved = environmentForTool("yarn", [], { config: item.config, cwd: item.first, env: { ...item.env, YARN_ENABLE_GLOBAL_CACHE: "true", YARN_ENABLE_MIRROR: "true" }, create: false });
  assert.equal(preserved.env.YARN_ENABLE_GLOBAL_CACHE, "true");
  assert.equal(preserved.env.YARN_ENABLE_MIRROR, "true");
});

test("Windows batch invocation uses cmd with protected metacharacters and rejects multiline arguments", () => {
  const result = windowsBatchInvocation("C:\\Program Files\\npm.cmd", ["", "hello world", "x&y", "a\\", 'a"b', "%PATH%"], { ComSpec: "C:\\Windows\\System32\\cmd.exe" });
  assert.equal(result.command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(result.args.slice(0, 4), ["/d", "/v:off", "/s", "/c"]);
  assert.ok(result.args[4].includes("x^&y"));
  assert.ok(result.args[4].includes("^%PATH^%"));
  assert.equal(result.windowsVerbatimArguments, true);
  assert.throws(() => windowsBatchInvocation("tool.cmd", ["first\nsecond"], {}), /cannot contain newlines/);
});

test("Windows batch execution preserves argv, including shell metacharacters", { skip: process.platform !== "win32" }, async (t) => {
  const item = fixture(t);
  const command = path.join(item.bin, "capture tool.cmd");
  const script = path.join(item.bin, "capture.cjs");
  const capture = path.join(item.root, "arguments.json");
  fs.writeFileSync(script, "require('node:fs').writeFileSync(process.env.CAPTURE, JSON.stringify(process.argv.slice(2)));\n");
  fs.writeFileSync(command, `@echo off\r\n"${process.execPath}" "%~dp0capture.cjs" %*\r\n`);
  const args = ["", "hello world", "x&y", "a\\", 'a"b', "%PATH%", "a!b", "x|y"];
  assert.equal(await spawnInherited(command, args, { env: { ...item.env, CAPTURE: capture } }), 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(capture, "utf8")), args);
});
