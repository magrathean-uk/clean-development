import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { OWNERSHIP_MARKER } from "../src/adapters.js";
import { resolveConfig, writeUserConfig } from "../src/config.js";
import { writeJsonAtomic } from "../src/io.js";
import { ensureRuntime, removeRuntime, resolveExecutable, runTool, runtimeRemovalPlan, spawnInherited } from "../src/runtime.js";
import { acquireWorkspaceLock, activeWorkspaceIds, applyPrune, listWorkspaceRecords, prunePlan, workspaceRecord } from "../src/state.js";
import { identifyWorkspace } from "../src/workspace.js";

const REPOSITORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPOSITORY, "bin", "clean-development.js");

function fixture(prefix = "clean-development-safety-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  const fakeBin = path.join(root, "fake-bin");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    CLEAN_DEVELOPMENT_HOME: home,
    CLEAN_DEVELOPMENT_DATA_HOME: path.join(root, "data"),
    CLEAN_DEVELOPMENT_CONFIG_HOME: path.join(root, "config"),
    CLEAN_DEVELOPMENT_ROOT: path.join(root, "managed"),
    PATH: [fakeBin, "/usr/bin", "/bin"].join(path.delimiter)
  };
  for (const name of [
    "CARGO_TARGET_DIR",
    "CLEAN_DEVELOPMENT_BUILD_ROOT",
    "CLEAN_DEVELOPMENT_CACHE_ROOT",
    "CLEAN_DEVELOPMENT_FORCE",
    "NODE_OPTIONS",
    "npm_command",
    "npm_execpath",
    "NPM_EXECPATH",
    "npm_lifecycle_event",
    "npm_config_cache",
    "NPM_CONFIG_CACHE"
  ]) delete env[name];
  for (const name of ["caches", "builds", "scratch"]) fs.mkdirSync(path.join(root, "managed", name), { recursive: true });
  return { root, home, project, fakeBin, env };
}

function writeExecutable(file, source) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

function fakeNodeTool(file, body = "") {
  writeExecutable(file, `#!${process.execPath}\nconst fs = require("node:fs");\n${body}\n`);
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function cargoManifest(directory, name = path.basename(directory)) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "Cargo.toml"), `[package]\nname = "${name}"\nversion = "0.1.0"\n`);
}

function runChild(args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test("cache-only npm execution creates no build workspace record", async (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(item.project, "package.json"), "{}\n");
  fakeNodeTool(path.join(item.fakeBin, "npm"));
  const config = resolveConfig({ cwd: item.project, env: item.env });

  assert.equal(await runTool("npm", ["--version"], { config, cwd: item.project, env: item.env }), 0);
  assert.deepEqual(listWorkspaceRecords(config), []);
});

test("an explicit Cargo target is preserved and creates no managed build record", async (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  cargoManifest(item.project);
  const capture = path.join(item.root, "target.txt");
  fakeNodeTool(path.join(item.fakeBin, "cargo"), "fs.writeFileSync(process.env.CAPTURE, process.env.CARGO_TARGET_DIR);");
  const externalTarget = path.join(item.root, "deliberate-target");
  const env = { ...item.env, CAPTURE: capture, CARGO_TARGET_DIR: externalTarget };
  const config = resolveConfig({ cwd: item.project, env });

  assert.equal(await runTool("cargo", ["check"], { config, cwd: item.project, env }), 0);
  assert.equal(fs.readFileSync(capture, "utf8"), externalTarget);
  assert.deepEqual(listWorkspaceRecords(config), []);
});

test("an explicit Cargo target still leases an existing managed workspace record", async (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  cargoManifest(item.project);
  fakeNodeTool(path.join(item.fakeBin, "cargo"), "setTimeout(() => {}, process.argv[2] === 'slow' ? 400 : 0);");
  const config = resolveConfig({ cwd: item.project, env: item.env });
  assert.equal(await runTool("cargo", ["seed"], { config, cwd: item.project, env: item.env }), 0);
  const workspace = identifyWorkspace("cargo", [], item.project);
  const explicit = runTool("cargo", ["slow"], {
    config,
    cwd: item.project,
    env: { ...item.env, CARGO_TARGET_DIR: path.join(item.root, "external-target") }
  });
  const deadline = Date.now() + 1000;
  while (!activeWorkspaceIds(config).has(workspace.id) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(activeWorkspaceIds(config).has(workspace.id), true);
  assert.equal(prunePlan(config, { olderThanDays: 0 }).find((entry) => entry.workspaceId === workspace.id)?.reason, "active");
  assert.equal(await explicit, 0);
});

test("overlapping Cargo calls in one process keep independent active leases", async (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  cargoManifest(item.project);
  fakeNodeTool(path.join(item.fakeBin, "cargo"), "setTimeout(() => {}, process.argv[2] === 'short' ? 100 : 900);");
  const config = resolveConfig({ cwd: item.project, env: item.env });
  const workspace = identifyWorkspace("cargo", [], item.project);
  const long = runTool("cargo", ["long"], { config, cwd: item.project, env: item.env });
  const short = runTool("cargo", ["short"], { config, cwd: item.project, env: item.env });
  assert.equal(await short, 0);
  assert.equal(activeWorkspaceIds(config).has(workspace.id), true);
  assert.equal(await long, 0);
  assert.equal(activeWorkspaceIds(config).has(workspace.id), false);
});

test("an active Cargo child stays leased after its wrapper is killed", { skip: process.platform === "win32" }, async (t) => {
  const item = fixture();
  let wrapper;
  let childPid;
  t.after(() => {
    try { wrapper?.kill("SIGKILL"); } catch {}
    try { if (childPid) process.kill(childPid, "SIGKILL"); } catch {}
    fs.rmSync(item.root, { recursive: true, force: true });
  });
  cargoManifest(item.project);
  const pidFile = path.join(item.root, "cargo-child.pid");
  fakeNodeTool(path.join(item.fakeBin, "cargo"), "fs.writeFileSync(process.env.PID_FILE, String(process.pid)); setTimeout(() => {}, 10000);");
  const env = { ...item.env, PID_FILE: pidFile };
  wrapper = spawn(process.execPath, [CLI, "shim", "cargo", "--", "check"], { cwd: item.project, env, stdio: "ignore" });
  const deadline = Date.now() + 3000;
  while (!fs.existsSync(pidFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fs.existsSync(pidFile), true);
  childPid = Number(fs.readFileSync(pidFile, "utf8"));
  assert.notEqual(childPid, wrapper.pid);
  const wrapperClosed = new Promise((resolve) => wrapper.once("close", resolve));
  wrapper.kill("SIGKILL");
  await wrapperClosed;
  assert.doesNotThrow(() => process.kill(childPid, 0));

  const config = resolveConfig({ cwd: item.project, env });
  const workspace = identifyWorkspace("cargo", [], item.project);
  const plan = prunePlan(config, { olderThanDays: 0 });
  assert.equal(plan.find((entry) => entry.workspaceId === workspace.id)?.reason, "active");
  assert.deepEqual(await applyPrune(config, plan), []);
  assert.equal(fs.existsSync(path.join(config.buildRoot, workspace.id)), true);
});

test("Cargo refuses a pre-existing unowned managed build directory", async (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  cargoManifest(item.project);
  const invoked = path.join(item.root, "cargo-was-invoked");
  fakeNodeTool(path.join(item.fakeBin, "cargo"), "fs.writeFileSync(process.env.INVOKED, 'yes');");
  const env = { ...item.env, INVOKED: invoked };
  const config = resolveConfig({ cwd: item.project, env });
  const workspace = identifyWorkspace("cargo", [], item.project);
  const buildPath = path.join(config.buildRoot, workspace.id);
  fs.mkdirSync(buildPath, { recursive: true });
  fs.writeFileSync(path.join(buildPath, "valuable.txt"), "keep");

  await assert.rejects(
    runTool("cargo", ["check"], { config, cwd: item.project, env }),
    /Refusing unowned existing build directory/
  );
  assert.equal(fs.existsSync(invoked), false);
  assert.equal(fs.readFileSync(path.join(buildPath, "valuable.txt"), "utf8"), "keep");
  assert.deepEqual(listWorkspaceRecords(config), []);
});

test("Cargo refuses to adopt a forged ownership marker without prior state", async (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  cargoManifest(item.project);
  const invoked = path.join(item.root, "cargo-was-invoked");
  fakeNodeTool(path.join(item.fakeBin, "cargo"), "fs.writeFileSync(process.env.INVOKED, 'yes');");
  const env = { ...item.env, INVOKED: invoked };
  const config = resolveConfig({ cwd: item.project, env });
  const workspace = identifyWorkspace("cargo", [], item.project);
  const buildPath = path.join(config.buildRoot, workspace.id);
  fs.mkdirSync(buildPath, { recursive: true });
  fs.writeFileSync(path.join(buildPath, "valuable.txt"), "keep");
  writeJsonAtomic(path.join(buildPath, OWNERSHIP_MARKER), {
    schemaVersion: 1,
    owner: "clean-development",
    ownershipId: "forged-id",
    workspaceId: workspace.id,
    workspace: workspace.root
  });

  await assert.rejects(runTool("cargo", ["check"], { config, cwd: item.project, env }), /without a matching state receipt/);
  assert.equal(fs.existsSync(invoked), false);
  assert.equal(fs.readFileSync(path.join(buildPath, "valuable.txt"), "utf8"), "keep");
  assert.deepEqual(listWorkspaceRecords(config), []);
});

test("missing managed base roots fail visibly and are not silently recreated", async (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  cargoManifest(item.project);
  fs.writeFileSync(path.join(item.project, "package.json"), "{}\n");
  fakeNodeTool(path.join(item.fakeBin, "cargo"));
  fakeNodeTool(path.join(item.fakeBin, "npm"));
  const config = resolveConfig({ cwd: item.project, env: item.env });
  fs.rmSync(config.buildRoot, { recursive: true });
  await assert.rejects(runTool("cargo", ["check"], { config, cwd: item.project, env: item.env }), /Managed build root is unavailable/);
  assert.equal(fs.existsSync(config.buildRoot), false);
  fs.rmSync(config.cacheRoot, { recursive: true });
  await assert.rejects(runTool("npm", ["--version"], { config, cwd: item.project, env: item.env }), /Managed cache root is unavailable/);
  assert.equal(fs.existsSync(config.cacheRoot), false);
});

test("cache routing refuses symlinked subdirectories and does not write through them", async (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(item.project, "package.json"), "{}\n");
  fakeNodeTool(path.join(item.fakeBin, "npm"));
  const victim = path.join(item.root, "victim");
  fs.mkdirSync(victim);
  fs.symlinkSync(victim, path.join(item.root, "managed", "caches", "node"), "dir");
  const config = resolveConfig({ cwd: item.project, env: item.env });
  await assert.rejects(runTool("npm", ["--version"], { config, cwd: item.project, env: item.env }), /not a real directory|unexpected symlink/);
  assert.equal(fs.existsSync(path.join(victim, "npm")), false);
});

test("env cache export refuses a missing base without recreating it", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(item.project, "package.json"), "{}\n");
  const cacheRoot = path.join(item.root, "managed", "caches");
  fs.rmSync(cacheRoot, { recursive: true });
  const result = spawnSync(process.execPath, [CLI, "env", "--tool", "npm", "--format", "sh"], {
    cwd: item.project,
    env: item.env,
    encoding: "utf8"
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Managed cache root is unavailable/);
  assert.equal(fs.existsSync(cacheRoot), false);
});

test("tool argument inspection stops at the double-dash boundary", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const other = path.join(item.root, "other");
  cargoManifest(item.project, "main-project");
  cargoManifest(other, "other-project");

  const ignored = identifyWorkspace("cargo", ["run", "--", "--manifest-path", path.join(other, "Cargo.toml")], item.project);
  const honored = identifyWorkspace("cargo", ["--manifest-path", path.join(other, "Cargo.toml"), "check"], item.project);
  assert.equal(ignored.root, fs.realpathSync(item.project));
  assert.equal(honored.root, fs.realpathSync(other));
});

test("Cargo workspace members share their workspace-root identity", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const workspace = path.join(item.root, "rust-workspace");
  const first = path.join(workspace, "crates", "first");
  const second = path.join(workspace, "crates", "second");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "Cargo.toml"), "[workspace]\nmembers = [\"crates/first\", \"crates/second\"]\n");
  cargoManifest(first, "first");
  cargoManifest(second, "second");

  const fromFirst = identifyWorkspace("cargo", [], first);
  const fromSecond = identifyWorkspace("cargo", [], second);
  assert.equal(fromFirst.root, fs.realpathSync(workspace));
  assert.equal(fromFirst.id, fromSecond.id);
});

test("executable resolution skips symlinked, hard-linked, and stale generated shims", { skip: process.platform === "win32" }, (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const ownedBin = path.join(item.root, "owned-bin");
  const symlinkedBin = path.join(item.root, "symlinked-bin");
  const hardlinkBin = path.join(item.root, "hardlink-bin");
  const staleBin = path.join(item.root, "stale-bin");
  const realBin = path.join(item.root, "real-bin");
  const owned = path.join(ownedBin, "cargo");
  writeExecutable(owned, "#!/bin/sh\nexit 91\n");
  fs.symlinkSync(ownedBin, symlinkedBin, "dir");
  fs.mkdirSync(hardlinkBin);
  fs.linkSync(owned, path.join(hardlinkBin, "cargo"));
  writeExecutable(path.join(staleBin, "cargo"), "#!/bin/sh\nexec node /old/clean-development-shim.js cargo \"$@\"\n");
  writeExecutable(path.join(realBin, "cargo"), "#!/bin/sh\nexit 0\n");
  const env = {
    ...item.env,
    PATH: [symlinkedBin, hardlinkBin, staleBin, realBin].join(path.delimiter)
  };

  assert.equal(resolveExecutable("cargo", env, ownedBin), path.join(realBin, "cargo"));
});

test("executable resolution skips stale Windows-style generated shims", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const staleBin = path.join(item.root, "stale-cmd-bin");
  const realBin = path.join(item.root, "real-cmd-bin");
  writeExecutable(path.join(staleBin, "cargo.cmd"), "@echo off\r\nnode C:\\old\\clean-development-shim.js cargo %*\r\n");
  writeExecutable(path.join(realBin, "cargo.cmd"), "@echo off\r\nexit /b 0\r\n");
  const env = { ...item.env, PATH: [staleBin, realBin].join(path.delimiter) };
  assert.equal(resolveExecutable("cargo.cmd", env), path.join(realBin, "cargo.cmd"));
});

test("executable resolution accepts a case-variant PATH environment key", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const realBin = path.join(item.root, "case-path-bin");
  writeExecutable(path.join(realBin, "cargo"), "#!/bin/sh\nexit 0\n");
  assert.equal(resolveExecutable("cargo", { Path: realBin }), path.join(realBin, "cargo"));
});

test("signal termination is converted to the conventional shell exit code", { skip: process.platform === "win32" }, async () => {
  const code = await spawnInherited(process.execPath, ["-e", "process.kill(process.pid, 'SIGKILL')"]);
  assert.equal(code, 137);
});

test("a materialized shim remains ESM-safe when module detection is disabled", { skip: process.platform === "win32" }, (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  cargoManifest(item.project);
  const capture = path.join(item.root, "shim-capture.json");
  fakeNodeTool(path.join(item.fakeBin, "cargo"), "fs.writeFileSync(process.env.CAPTURE, JSON.stringify(process.argv.slice(2)));");
  const config = resolveConfig({ cwd: item.project, env: item.env });
  const runtime = ensureRuntime(config);
  const env = {
    ...item.env,
    CAPTURE: capture,
    NODE_OPTIONS: "--no-experimental-detect-module",
    PATH: [runtime.binDir, item.fakeBin].join(path.delimiter)
  };

  const result = spawnSync(path.join(runtime.binDir, "cargo"), ["check", "--locked"], { cwd: item.project, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(capture, "utf8")), ["check", "--locked"]);
});

test("uninstall preserves unrelated bin content and a modified owned launcher", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const config = resolveConfig({ cwd: item.project, env: item.env });
  fs.mkdirSync(config.locations.binDir, { recursive: true });
  const unrelated = path.join(config.locations.binDir, "my-unrelated-tool");
  fs.writeFileSync(unrelated, "important\n");
  const runtime = ensureRuntime(config);
  const modified = path.join(runtime.binDir, process.platform === "win32" ? "cargo.cmd" : "cargo");
  fs.writeFileSync(modified, "locally modified\n");

  const result = removeRuntime(config);
  assert.equal(fs.readFileSync(unrelated, "utf8"), "important\n");
  assert.equal(fs.readFileSync(modified, "utf8"), "locally modified\n");
  assert.ok(result.retained.includes(modified));
  assert.equal(fs.existsSync(path.join(runtime.binDir, process.platform === "win32" ? "clean-development.cmd" : "clean-development")), false);
});

test("uninstall rejects a forged current runtime receipt before deleting files", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const config = resolveConfig({ cwd: item.project, env: item.env });
  ensureRuntime(config);
  const unrelated = path.join(config.locations.binDir, "unrelated-user-file");
  fs.writeFileSync(unrelated, "important\n");
  const receiptFile = path.join(config.locations.stateDir, "runtime.json");
  const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
  receipt.ownedFiles.push({ path: unrelated, sha256: sha256File(unrelated) });
  writeJsonAtomic(receiptFile, receipt);
  assert.throws(() => removeRuntime(config), /unknown launcher path|Invalid runtime receipt/);
  assert.equal(fs.readFileSync(unrelated, "utf8"), "important\n");
  assert.equal(fs.existsSync(path.join(config.locations.binDir, process.platform === "win32" ? "cargo.cmd" : "cargo")), true);
});

test("runtime installation refuses to overwrite a pre-existing shim name", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const config = resolveConfig({ cwd: item.project, env: item.env });
  fs.mkdirSync(config.locations.binDir, { recursive: true });
  const cargo = path.join(config.locations.binDir, process.platform === "win32" ? "cargo.cmd" : "cargo");
  fs.writeFileSync(cargo, "user-owned\n");
  assert.throws(() => ensureRuntime(config), /Refusing to overwrite unowned or modified runtime file/);
  assert.equal(fs.readFileSync(cargo, "utf8"), "user-owned\n");
});

test("runtime installation refuses a symlinked runtime directory", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const config = resolveConfig({ cwd: item.project, env: item.env });
  const victim = path.join(item.root, "outside-runtime");
  fs.mkdirSync(path.dirname(config.locations.runtimeDir), { recursive: true });
  fs.mkdirSync(victim);
  fs.symlinkSync(victim, config.locations.runtimeDir, "dir");
  assert.throws(() => ensureRuntime(config), /Runtime directory is not a real directory|unexpected symlink/);
  assert.deepEqual(fs.readdirSync(victim), []);
});

test("runtime uninstall refuses a replaced bin-directory symlink", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const config = resolveConfig({ cwd: item.project, env: item.env });
  const runtime = ensureRuntime(config);
  const victim = path.join(item.root, "outside-bin");
  fs.renameSync(runtime.binDir, victim);
  fs.symlinkSync(victim, runtime.binDir, "dir");
  const launcher = path.join(victim, process.platform === "win32" ? "clean-development.cmd" : "clean-development");
  assert.throws(() => removeRuntime(config), /Runtime bin directory is not a real directory|unexpected symlink/);
  assert.equal(fs.existsSync(launcher), true);
});

test("automatic activation is dormant until explicit setup installs a runtime", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const environmentFile = path.join(item.root, "automatic.env");
  const result = spawnSync(process.execPath, [CLI, "hook", "session-start"], {
    cwd: item.project,
    env: { ...item.env, CLAUDE_ENV_FILE: environmentFile },
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(environmentFile), false);
  assert.equal(fs.existsSync(path.join(item.root, "data", "bin")), false);
  assert.equal(fs.existsSync(path.join(item.root, "data", "runtime")), false);
  assert.equal(fs.existsSync(path.join(item.root, "data")), false);
});

test("state collection symlinks fail closed without deleting outside files", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const config = resolveConfig({ cwd: item.project, env: item.env });
  const state = config.locations.stateDir;
  const victim = path.join(item.root, "outside-leases");
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(victim);
  const innocent = path.join(victim, "innocent.json");
  fs.writeFileSync(innocent, "{}\n");
  fs.symlinkSync(victim, path.join(state, "leases"), "dir");
  assert.throws(() => activeWorkspaceIds(config), /not a real directory|unexpected symlink/);
  assert.equal(fs.readFileSync(innocent, "utf8"), "{}\n");
});

test("unknown lease files are ignored and retained", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const config = resolveConfig({ cwd: item.project, env: item.env });
  const leases = path.join(config.locations.stateDir, "leases");
  fs.mkdirSync(leases, { recursive: true });
  const innocent = path.join(leases, "innocent.json");
  fs.writeFileSync(innocent, "{}\n");
  assert.deepEqual([...activeWorkspaceIds(config)], []);
  assert.equal(fs.existsSync(innocent), true);
});

test("a corrupt matching lease conservatively keeps its workspace active", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const config = resolveConfig({ cwd: item.project, env: item.env });
  const leases = path.join(config.locations.stateDir, "leases");
  fs.mkdirSync(leases, { recursive: true });
  const corrupt = path.join(leases, `${process.pid}-fixture-deadbeef00-${crypto.randomUUID()}.json`);
  const invalid = path.join(leases, `${process.pid}-fixture-deadbeef00-${crypto.randomUUID()}.json`);
  fs.writeFileSync(corrupt, "{not valid json\n");
  fs.writeFileSync(invalid, "{}\n");
  assert.deepEqual([...activeWorkspaceIds(config)], ["fixture-deadbeef00"]);
  assert.equal(fs.existsSync(corrupt), true);
  assert.equal(fs.existsSync(invalid), true);
});

test("workspace lock symlinks fail closed without touching their owner file", async (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const config = resolveConfig({ cwd: item.project, env: item.env });
  const workspaceId = "fixture-deadbeef00";
  const digest = crypto.createHash("sha256").update(path.resolve(config.buildRoot)).digest("hex").slice(0, 8);
  const lockParent = path.join(config.locations.stateDir, "workspace-locks");
  const victim = path.join(item.root, "outside-lock");
  fs.mkdirSync(lockParent, { recursive: true });
  fs.mkdirSync(victim);
  const owner = path.join(victim, "owner.json");
  fs.writeFileSync(owner, "{}\n");
  fs.symlinkSync(victim, path.join(lockParent, `${workspaceId}-${digest}.lock`), "dir");
  await assert.rejects(acquireWorkspaceLock(config, workspaceId), /not a real directory|unexpected symlink/);
  assert.equal(fs.readFileSync(owner, "utf8"), "{}\n");
});

test("uninstall retains invalid files in the runtime receipt collection", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const config = resolveConfig({ cwd: item.project, env: item.env });
  ensureRuntime(config);
  const receipts = path.join(config.locations.stateDir, "runtime-receipts");
  fs.mkdirSync(receipts, { recursive: true });
  const innocent = path.join(receipts, "innocent.json");
  fs.writeFileSync(innocent, "{}\n");
  removeRuntime(config);
  assert.equal(fs.readFileSync(innocent, "utf8"), "{}\n");
});

test("an upgrade archives the old runtime receipt so uninstall can remove both versions", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const config = resolveConfig({ cwd: item.project, env: item.env });
  const oldVersion = "0.0.9";
  const installationId = "old-installation-id";
  const oldRoot = path.join(config.locations.runtimeDir, oldVersion);
  const oldFile = path.join(oldRoot, "bin", "old.js");
  const markerFile = path.join(oldRoot, ".clean-development-runtime.json");
  fs.mkdirSync(path.dirname(oldFile), { recursive: true });
  fs.writeFileSync(oldFile, "old runtime\n");
  fs.writeFileSync(markerFile, `${JSON.stringify({
    schemaVersion: 1,
    owner: "clean-development",
    version: oldVersion,
    installationId
  }, null, 2)}\n`);
  writeJsonAtomic(path.join(config.locations.stateDir, "runtime.json"), {
    schemaVersion: 2,
    version: oldVersion,
    status: "installed",
    installationId,
    node: process.execPath,
    source: REPOSITORY,
    versionRoot: oldRoot,
    binDir: config.locations.binDir,
    binDirectoryCreated: false,
    ownedFiles: [],
    runtimeFiles: [oldFile, markerFile].map((file) => ({ path: file, sha256: sha256File(file) }))
  });

  const current = ensureRuntime(config);
  const archives = path.join(config.locations.stateDir, "runtime-receipts");
  assert.equal(fs.readdirSync(archives).filter((name) => name.endsWith(".json")).length, 1);
  assert.equal(fs.existsSync(oldRoot), true);
  const removalPlan = runtimeRemovalPlan(config);
  assert.equal(removalPlan.files.includes(oldFile), true);
  assert.equal(removalPlan.archivedReceipts.length, 1);
  removeRuntime(config);
  assert.equal(fs.existsSync(oldRoot), false);
  assert.equal(fs.existsSync(current.versionRoot), false);
  assert.equal(fs.existsSync(archives), false);
});

test("Cargo manifest-path selects the target project's configuration", async (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const destination = path.join(item.root, "destination");
  cargoManifest(item.project, "caller");
  cargoManifest(destination, "destination");
  const destinationBuilds = path.join(item.root, "destination-builds");
  fs.mkdirSync(destinationBuilds);
  fs.writeFileSync(path.join(destination, ".clean-development.json"), `${JSON.stringify({ schemaVersion: 1, buildRoot: destinationBuilds })}\n`);
  const capture = path.join(item.root, "manifest-capture.txt");
  fakeNodeTool(path.join(item.fakeBin, "cargo"), "fs.writeFileSync(process.env.CAPTURE, process.env.CARGO_TARGET_DIR);");
  const env = { ...item.env, CAPTURE: capture };
  const callerConfig = resolveConfig({ cwd: item.project, env });

  assert.equal(await runTool("cargo", ["--manifest-path", path.join(destination, "Cargo.toml"), "check"], {
    config: callerConfig,
    cwd: item.project,
    env
  }), 0);
  const canonicalBuilds = fs.realpathSync(destinationBuilds);
  assert.ok(fs.readFileSync(capture, "utf8").startsWith(`${canonicalBuilds}${path.sep}`));
  assert.equal(listWorkspaceRecords(callerConfig).length, 1);
  assert.equal(listWorkspaceRecords(callerConfig)[0].value.buildRoot, canonicalBuilds);
});

test("env refuses to export an unleased Cargo target", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  cargoManifest(item.project);
  const result = spawnSync(process.execPath, [CLI, "env", "--tool", "cargo"], {
    cwd: item.project,
    env: item.env,
    encoding: "utf8"
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cargo build output needs ownership and an active lease/);
});

test("prune without an age flag uses configured retention", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  writeUserConfig({
    root: path.join(item.root, "managed"),
    enabled: true,
    retention: { buildDays: 365 }
  }, item.env);
  const config = resolveConfig({ cwd: item.project, env: { ...item.env, CLEAN_DEVELOPMENT_ROOT: undefined } });
  const workspaceId = "fixture-retention00";
  const workspace = fs.realpathSync(item.project);
  const ownershipId = "retention-ownership";
  const buildPath = path.join(config.buildRoot, workspaceId);
  fs.mkdirSync(buildPath, { recursive: true });
  writeJsonAtomic(path.join(buildPath, OWNERSHIP_MARKER), {
    schemaVersion: 1,
    owner: "clean-development",
    ownershipId,
    workspaceId,
    workspace
  });
  writeJsonAtomic(workspaceRecord(config, workspaceId, config.buildRoot).file, {
    schemaVersion: 1,
    workspaceId,
    workspace,
    ownershipId,
    buildRoot: config.buildRoot,
    path: buildPath,
    lastUsedAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
    pinned: false
  });
  const env = { ...item.env };
  delete env.CLEAN_DEVELOPMENT_ROOT;
  const result = spawnSync(process.execPath, [CLI, "prune", "--json"], { cwd: item.project, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).entries[0].reason, "recent");
});

test("the Claude plugin hook prefers its bundled CLI over a PATH impostor", { skip: process.platform === "win32" }, (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const hijacked = path.join(item.root, "hijacked");
  writeExecutable(path.join(item.fakeBin, "clean-development"), `#!/bin/sh\ntouch ${JSON.stringify(hijacked)}\nexit 42\n`);
  const environmentFile = path.join(item.root, "claude.env");
  const env = {
    ...item.env,
    CLAUDE_PLUGIN_ROOT: REPOSITORY,
    CLAUDE_ENV_FILE: environmentFile,
    PATH: [item.fakeBin, path.dirname(process.execPath)].join(path.delimiter)
  };
  const setup = spawnSync(process.execPath, [CLI, "setup", "--root", path.join(item.root, "managed"), "--agents", "claude", "--json"], {
    cwd: item.project, env, encoding: "utf8"
  });
  assert.equal(setup.status, 0, setup.stderr);
  const unbound = spawnSync(path.join(REPOSITORY, "hooks", "session-start"), [], { cwd: item.project, env, encoding: "utf8" });
  assert.equal(unbound.status, 0, unbound.stderr);
  assert.equal(fs.existsSync(environmentFile), false);
  assert.equal(fs.existsSync(hijacked), false);
  const owner = JSON.parse(setup.stdout).integrations.find((entry) => entry.agent === "claude").ownershipId;
  const result = spawnSync(path.join(REPOSITORY, "hooks", "session-start"), [owner], { cwd: item.project, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(hijacked), false);
  assert.match(fs.readFileSync(environmentFile, "utf8"), /CLEAN_DEVELOPMENT_SESSION_MODE=skip/);
});

test("concurrent first Cargo invocations converge on one owned build directory", async (t) => {
  const item = fixture("clean-development-concurrent-");
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  cargoManifest(item.project);
  fakeNodeTool(path.join(item.fakeBin, "cargo"), "setTimeout(() => {}, 40);");
  const command = [process.execPath, CLI, "shim", "cargo", "--", "check"];

  const [first, second] = await Promise.all([
    runChild(command, { cwd: item.project, env: item.env }),
    runChild(command, { cwd: item.project, env: item.env })
  ]);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);

  const config = resolveConfig({ cwd: item.project, env: item.env });
  const workspace = identifyWorkspace("cargo", [], item.project);
  const buildPath = path.join(config.buildRoot, workspace.id);
  const marker = JSON.parse(fs.readFileSync(path.join(buildPath, OWNERSHIP_MARKER), "utf8"));
  assert.equal(marker.owner, "clean-development");
  assert.equal(marker.workspaceId, workspace.id);
  assert.equal(marker.workspace, fs.realpathSync(item.project));
  assert.equal(fs.readdirSync(config.buildRoot).some((name) => name.startsWith(".clean-development-")), false);
});

test("concurrent setup converges on one owned integration per agent", async (t) => {
  const item = fixture("clean-development-setup-concurrent-");
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const env = {
    ...item.env,
    CLAUDE_CONFIG_DIR: path.join(item.root, "claude"),
    CODEX_HOME: path.join(item.root, "codex"),
    GROK_HOME: path.join(item.root, "grok")
  };
  const command = [process.execPath, CLI, "setup", "--root", path.join(item.root, "managed"), "--agents", "claude,codex,grok", "--json"];
  const results = await Promise.all(Array.from({ length: 4 }, () => runChild(command, { cwd: item.project, env })));
  for (const result of results) assert.equal(result.code, 0, result.stderr);

  const settings = JSON.parse(fs.readFileSync(path.join(env.CLAUDE_CONFIG_DIR, "settings.json"), "utf8"));
  const ownedHooks = settings.hooks.SessionStart.flatMap((entry) => entry.hooks || []).filter((hook) => /hook session-start --owner/.test(hook.command || ""));
  assert.equal(ownedHooks.length, 1);
  const codex = fs.readFileSync(path.join(env.CODEX_HOME, "config.toml"), "utf8");
  assert.equal((codex.match(/clean-development begin/g) || []).length, 1);
  const grokConfig = fs.readFileSync(path.join(env.GROK_HOME, "config.toml"), "utf8");
  assert.equal((grokConfig.match(/clean-development begin/g) || []).length, 1);
  assert.match(grokConfig, /cmd_prefix = ".*clean-development-shell-env/);
  const receipt = JSON.parse(fs.readFileSync(path.join(item.root, "data", "state", "integrations.json"), "utf8"));
  assert.deepEqual(receipt.integrations.map((entry) => entry.agent).sort(), ["claude", "codex", "grok"]);
  const grok = receipt.integrations.find((entry) => entry.agent === "grok");
  assert.equal(grok.mode, "native-shell-environment");
  assert.equal(grok.file, path.join(env.GROK_HOME, "config.toml"));
});

test("concurrent prepare calls converge on the same project roots", async (t) => {
  const item = fixture("clean-development-prepare-concurrent-");
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const storage = path.join(item.root, "project-storage");
  fs.writeFileSync(path.join(item.project, ".clean-development.json"), `${JSON.stringify({ schemaVersion: 1, root: storage })}\n`);
  const env = { ...item.env };
  delete env.CLEAN_DEVELOPMENT_ROOT;
  const command = [process.execPath, CLI, "prepare", "--json"];
  const results = await Promise.all(Array.from({ length: 8 }, () => runChild(command, { cwd: item.project, env })));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  for (const name of ["caches", "builds", "scratch"]) assert.equal(fs.lstatSync(path.join(storage, name)).isDirectory(), true);
});

test("setup and uninstall serialize to a consistent final state", async (t) => {
  const item = fixture("clean-development-setup-uninstall-");
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const env = {
    ...item.env,
    CLAUDE_CONFIG_DIR: path.join(item.root, "claude"),
    CODEX_HOME: path.join(item.root, "codex"),
    GROK_HOME: path.join(item.root, "grok")
  };
  const setup = [process.execPath, CLI, "setup", "--root", path.join(item.root, "managed"), "--agents", "claude,codex,grok", "--json"];
  const first = await runChild(setup, { cwd: item.project, env });
  assert.equal(first.code, 0, first.stderr);
  const [installed, removed] = await Promise.all([
    runChild(setup, { cwd: item.project, env }),
    runChild([process.execPath, CLI, "uninstall", "--json"], { cwd: item.project, env })
  ]);
  assert.equal(installed.code, 0, installed.stderr);
  assert.equal(removed.code, 0, removed.stderr);

  const runtime = JSON.parse(fs.readFileSync(path.join(item.root, "data", "state", "runtime.json"), "utf8"));
  const launcher = path.join(item.root, "data", "bin", process.platform === "win32" ? "clean-development.cmd" : "clean-development");
  const grokLauncher = path.join(item.root, "data", "bin", process.platform === "win32" ? "clean-development-grok.cmd" : "clean-development-grok");
  const receipt = JSON.parse(fs.readFileSync(path.join(item.root, "data", "state", "integrations.json"), "utf8"));
  const settings = JSON.parse(fs.readFileSync(path.join(env.CLAUDE_CONFIG_DIR, "settings.json"), "utf8"));
  const ownedHooks = (settings.hooks?.SessionStart || []).flatMap((entry) => entry.hooks || []).filter((hook) => /hook session-start --owner/.test(hook.command || ""));
  const codex = fs.readFileSync(path.join(env.CODEX_HOME, "config.toml"), "utf8");
  const markerCount = (codex.match(/clean-development begin/g) || []).length;
  const grokConfig = fs.readFileSync(path.join(env.GROK_HOME, "config.toml"), "utf8");
  const grokMarkerCount = (grokConfig.match(/clean-development begin/g) || []).length;
  if (runtime.status === "installed") {
    assert.equal(fs.existsSync(launcher), true);
    assert.equal(fs.existsSync(grokLauncher), true);
    assert.equal(ownedHooks.length, 1);
    assert.equal(markerCount, 1);
    assert.deepEqual(receipt.integrations.map((entry) => entry.agent).sort(), ["claude", "codex", "grok"]);
    const grok = receipt.integrations.find((entry) => entry.agent === "grok");
    assert.equal(grok.mode, "native-shell-environment");
    assert.equal(grokMarkerCount, 1);
  } else {
    assert.equal(runtime.status, "uninstalled");
    assert.equal(fs.existsSync(launcher), false);
    assert.equal(fs.existsSync(grokLauncher), false);
    assert.equal(ownedHooks.length, 0);
    assert.equal(markerCount, 0);
    assert.equal(grokMarkerCount, 0);
    assert.deepEqual(receipt.integrations, []);
  }
});
