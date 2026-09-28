import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fork, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { applyRecovery, planRecovery } from "../src/recovery.js";
import { directoryIdentity, digest } from "../src/recovery-io.js";
import { resolveConfig } from "../src/config.js";
import { ensureRuntime, runtimeHealth } from "../src/runtime.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "bin", "clean-development.js");
const WORKER = path.join(ROOT, "test", "recovery", "worker.mjs");
const MARKER = ".clean-development-runtime.json";
const launcher = (name) => process.platform === "win32" ? `${name}.cmd` : name;

function tree(directory) {
  const result = [];
  if (!fs.existsSync(directory)) return result;
  function visit(file, relative) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) result.push([relative, "link", fs.readlinkSync(file)]);
    else if (stat.isDirectory()) {
      result.push([relative, "directory", stat.mode & 0o777]);
      for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name), path.join(relative, name));
    } else result.push([relative, "file", stat.mode & 0o777, digest(fs.readFileSync(file))]);
    assert.ok(result.length <= 2048, "bounded disposable inventory");
  }
  visit(directory, ".");
  return result;
}

function cli(item, args, { binary = CLI, expected = 0 } = {}) {
  const result = spawnSync(process.execPath, [binary, ...args], {
    cwd: item.project, env: item.env, encoding: "utf8", timeout: 20_000, maxBuffer: 2 * 1024 * 1024
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, expected, `${args.join(" ")}\n${result.stderr}\n${result.stdout}`);
  return result;
}

function fixture(t, { installed = true } = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "clean-recovery-test-")));
  const token = crypto.randomUUID();
  fs.writeFileSync(path.join(root, "lab-owner"), token);
  const own = directoryIdentity(root);
  const project = path.join(root, "project-東京");
  const home = path.join(root, "home");
  fs.mkdirSync(project);
  fs.mkdirSync(path.join(home, ".ssh"), { recursive: true });
  fs.writeFileSync(path.join(home, ".ssh", "synthetic-credential"), "NOT A REAL CREDENTIAL\n");
  fs.writeFileSync(path.join(project, "package.json"), '{"name":"recovery-fixture","private":true}\n');
  fs.mkdirSync(path.join(project, ".git"));
  fs.writeFileSync(path.join(project, ".git", "HEAD"), "ref: refs/heads/fixture\n");
  fs.writeFileSync(path.join(project, "release-artifact"), Buffer.from([0, 255, 17, 42]));
  const env = Object.fromEntries(["PATH", "SystemRoot", "ComSpec", "PATHEXT", "WINDIR"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  Object.assign(env, {
    HOME: home, USERPROFILE: home, CLEAN_DEVELOPMENT_HOME: home,
    CLEAN_DEVELOPMENT_DATA_HOME: path.join(root, "data"), CLEAN_DEVELOPMENT_CONFIG_HOME: path.join(root, "config"),
    CLEAN_DEVELOPMENT_ROOT: path.join(root, "managed"), XDG_DATA_HOME: path.join(root, "xdg-data"),
    XDG_CONFIG_HOME: path.join(root, "xdg-config"), XDG_CACHE_HOME: path.join(root, "xdg-cache"),
    CODEX_HOME: path.join(root, "codex"), CLAUDE_CONFIG_DIR: path.join(root, "claude"), GROK_CONFIG_DIR: path.join(root, "grok")
  });
  fs.mkdirSync(env.CODEX_HOME);
  fs.writeFileSync(path.join(env.CODEX_HOME, "config.toml"), '[mcp_servers.keep]\ncommand = "unrelated-server"\n');
  const item = { root, project, env, children: new Set() };
  item.config = () => resolveConfig({ env, includeProject: false });
  item.receiptFile = path.join(env.CLEAN_DEVELOPMENT_DATA_HOME, "state", "runtime.json");
  item.witnessFile = path.join(env.CLEAN_DEVELOPMENT_DATA_HOME, "state", "recovery.json");
  item.receipt = () => JSON.parse(fs.readFileSync(item.receiptFile, "utf8"));
  t.after(async () => {
    for (const child of item.children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await new Promise((resolve) => child.once("exit", resolve));
      }
    }
    if (fs.readFileSync(path.join(root, "lab-owner"), "utf8") === token && JSON.stringify(directoryIdentity(root)) === JSON.stringify(own)) {
      fs.rmSync(root, { recursive: true });
    } else t.diagnostic(`Retained uncertain fixture: ${root}`);
  });
  if (installed) cli(item, ["setup", "--agents", "codex", "--json"]);
  item.protected = { project: tree(project), home: tree(home), codex: tree(env.CODEX_HOME) };
  item.assertProtected = () => {
    assert.deepEqual(tree(project), item.protected.project);
    assert.deepEqual(tree(home), item.protected.home);
    assert.deepEqual(tree(env.CODEX_HOME), item.protected.codex);
  };
  return item;
}

function plan(item) { return planRecovery({ env: item.env }); }
function apply(item, report = plan(item), extra = {}) { return applyRecovery({ env: item.env, apply: true, planId: report.planId, ...extra }); }
function missingLauncher(item, name = "cargo") {
  const file = path.join(item.config().locations.binDir, launcher(name));
  const bytes = fs.readFileSync(file);
  fs.unlinkSync(file);
  return { file, bytes };
}

function worker(item, spec) {
  const child = fork(WORKER, ["recovery-worker", JSON.stringify(spec)], { cwd: item.project, env: item.env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  item.children.add(child);
  const events = [];
  const listeners = [];
  let bytes = 0;
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (value) => {
    bytes += value.length;
    if (bytes > 256 * 1024) child.kill("SIGKILL");
  });
  child.on("message", (value) => { events.push(value); for (const resolve of [...listeners]) resolve(value); });
  const exit = new Promise((resolve) => child.once("exit", (code, signal) => { item.children.delete(child); resolve({ code, signal }); }));
  function event(name) {
    const found = events.find((value) => value.event === name);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Worker event deadline: ${name}`)); }, 15_000);
      const handler = (value) => {
        if (value.event !== name) return;
        clearTimeout(timer);
        listeners.splice(listeners.indexOf(handler), 1);
        resolve(value);
      };
      listeners.push(handler);
    });
  }
  return { child, exit, event, events };
}

function oldPackage(item) {
  const root = path.join(item.root, "old-package");
  fs.mkdirSync(root);
  for (const entry of ["bin", "src", "package.json"]) fs.cpSync(path.join(ROOT, entry), path.join(root, entry), { recursive: true });
  const constants = path.join(root, "src", "constants.js");
  fs.writeFileSync(constants, fs.readFileSync(constants, "utf8").replace(/export const VERSION = "[^"]+"/, 'export const VERSION = "0.0.9"'));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  pkg.version = "0.0.9";
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg));
  return path.join(root, "bin", "clean-development.js");
}

test("recovery planning is read-only on fresh and healthy installations; apply requires explicit reviewed consent", async (t) => {
  const fresh = fixture(t, { installed: false });
  const before = tree(fresh.root);
  const report = plan(fresh);
  assert.equal(report.blocked, true);
  assert.deepEqual(tree(fresh.root), before);
  assert.equal(plan(fresh).planId, report.planId);
  await assert.rejects(applyRecovery({ env: fresh.env, planId: report.planId }), /explicit/);
  cli(fresh, ["recover", "--apply", "--json"], { expected: 1 });
  cli(fresh, ["recover", "--apply", "--dry-run"], { expected: 1 });
  cli(fresh, ["recover", "--plan-id", report.planId], { expected: 1 });
  assert.deepEqual(tree(fresh.root), before);
  const healthy = fixture(t);
  const healthyBefore = tree(healthy.root);
  const healthyPlan = plan(healthy);
  assert.equal(healthyPlan.actions.length, 0);
  assert.equal(healthyPlan.blocked, false);
  assert.equal(plan(healthy).planId, healthyPlan.planId);
  assert.equal((await apply(healthy, healthyPlan)).applied.length, 0);
  cli(healthy, ["recover", "--dry-run", "--json"]);
  assert.deepEqual(tree(healthy.root), healthyBefore);
});

test("recovery restores only absent receipted payload/launchers and is idempotent", async (t) => {
  const item = fixture(t);
  const receipt = item.receipt();
  const payload = path.join(receipt.versionRoot, "src", "probe.js");
  const original = fs.readFileSync(payload);
  fs.unlinkSync(payload);
  const absent = missingLauncher(item);
  const before = tree(item.root);
  const report = plan(item);
  assert.deepEqual(report.actions.map((entry) => entry.kind), ["restore-runtime-file", "restore-launcher"]);
  assert.deepEqual(tree(item.root), before);
  const result = await apply(item, report);
  assert.equal(result.applied.length, 2);
  assert.deepEqual(fs.readFileSync(payload), original);
  assert.deepEqual(fs.readFileSync(absent.file), absent.bytes);
  for (const entry of result.applied) assert.ok(fs.existsSync(entry.retainedStage));
  assert.equal(runtimeHealth(item.config()).ok, true);
  const after = tree(item.root);
  assert.equal((await apply(item)).applied.length, 0);
  assert.deepEqual(tree(item.root), after);
  item.assertProtected();
});

test("independent snapshot repairs an absent marker and receipt without adopting by name", async (t) => {
  const item = fixture(t);
  const originalReceipt = fs.readFileSync(item.receiptFile);
  const marker = path.join(item.receipt().versionRoot, MARKER);
  const originalMarker = fs.readFileSync(marker);
  fs.unlinkSync(marker);
  fs.unlinkSync(item.receiptFile);
  const report = plan(item);
  assert.deepEqual(report.actions.map((entry) => entry.kind), ["restore-marker", "restore-receipt"]);
  assert.equal((await apply(item, report)).applied.length, 2);
  assert.deepEqual(fs.readFileSync(marker), originalMarker);
  assert.deepEqual(fs.readFileSync(item.receiptFile), originalReceipt);
  assert.equal(runtimeHealth(item.config()).ok, true);
  assert.equal(plan(item).actions.length, 0);
  item.assertProtected();
});

test("modified and mismatched metadata is retained rather than repaired over", async (t) => {
  for (const variant of ["malformed-receipt", "wrong-id", "outside-inventory", "modified-marker", "malformed-witness", "missing-unwitnessed-marker"]) {
    await t.test(variant, async (t) => {
      const item = fixture(t);
      const receipt = item.receipt();
      const marker = path.join(receipt.versionRoot, MARKER);
      if (variant === "malformed-receipt") fs.writeFileSync(item.receiptFile, "{ damaged");
      if (variant === "wrong-id") fs.writeFileSync(item.receiptFile, JSON.stringify({ ...receipt, installationId: crypto.randomUUID() }));
      if (variant === "outside-inventory") { receipt.runtimeFiles[0].path = path.join(item.project, "release-artifact"); fs.writeFileSync(item.receiptFile, JSON.stringify(receipt)); }
      if (variant === "modified-marker") fs.appendFileSync(marker, " ");
      if (variant === "malformed-witness") fs.writeFileSync(item.witnessFile, "{ damaged");
      if (variant === "missing-unwitnessed-marker") { fs.unlinkSync(marker); fs.unlinkSync(item.witnessFile); }
      const before = tree(item.root);
      const report = plan(item);
      assert.equal(report.blocked, true);
      assert.ok(report.retained.some((entry) => entry.next));
      assert.equal((await apply(item, report)).blocked, true);
      assert.deepEqual(tree(item.root), before);
      item.assertProtected();
    });
  }
});

test("missing volumes and replacement real roots never trigger recreation or fallback", async (t) => {
  for (const key of ["root", "cacheRoot", "buildRoot", "scratchRoot", "dataDir", "replacement-root"]) {
    await t.test(key, async (t) => {
      const item = fixture(t);
      const config = item.config();
      const selected = key === "replacement-root" ? config.root : config[key] || config.locations[key];
      const retired = `${selected}-retired`;
      fs.renameSync(selected, retired);
      if (key === "replacement-root") {
        fs.mkdirSync(selected);
        for (const name of ["caches", "builds", "scratch"]) fs.mkdirSync(path.join(selected, name));
        fs.writeFileSync(path.join(selected, "not-owned"), "keep replacement bytes");
      }
      const before = tree(item.root);
      const report = plan(item);
      assert.equal(report.blocked, true);
      assert.equal((await apply(item, report)).applied.length, 0);
      assert.deepEqual(tree(item.root), before);
      assert.equal(fs.existsSync(selected), key === "replacement-root");
      assert.equal(plan(item).planId, report.planId);
      item.assertProtected();
    });
  }
});

test("partial unmarked copies and modified files remain unclaimed", async (t) => {
  const item = fixture(t);
  const receipt = item.receipt();
  const stage = path.join(item.config().locations.runtimeDir, "0.2.1.tmp-familiar-but-not-proof");
  fs.mkdirSync(stage);
  fs.writeFileSync(path.join(stage, "source"), "unregistered partial copy");
  const modified = path.join(receipt.versionRoot, "src", "probe.js");
  fs.writeFileSync(modified, "// intentional local change\n");
  const absent = missingLauncher(item);
  const before = tree(item.root);
  const report = plan(item);
  assert.equal(report.actions.length, 0);
  assert.ok(report.retained.some((entry) => entry.path === stage));
  assert.ok(report.retained.some((entry) => entry.path === modified));
  assert.ok(report.retained.some((entry) => entry.path === absent.file));
  await apply(item, report);
  assert.deepEqual(tree(item.root), before);
});

test("a copied marker does not authorise a replaced version directory", async (t) => {
  const item = fixture(t);
  const root = item.receipt().versionRoot;
  fs.renameSync(root, `${root}-original`);
  fs.cpSync(`${root}-original`, root, { recursive: true });
  missingLauncher(item);
  const before = tree(item.root);
  assert.equal(plan(item).blocked, true);
  await apply(item);
  assert.deepEqual(tree(item.root), before);
});

test("runtime directory aliases do not authorise reads/writes through their unrecorded target", async (t) => {
  const item = fixture(t);
  const src = path.join(item.receipt().versionRoot, "src");
  const copied = `${src}-unrecorded`;
  fs.renameSync(src, copied);
  fs.symlinkSync(copied, src, process.platform === "win32" ? "junction" : "dir");
  missingLauncher(item);
  const before = tree(item.root);
  const report = plan(item);
  assert.equal(report.actions.length, 0);
  assert.ok(report.retained.some((entry) => /canonical/.test(entry.reason)));
  await apply(item, report);
  assert.deepEqual(tree(item.root), before);
});

test("interrupted update rolls back only its exact journal-authorised stale launcher", async (t) => {
  const item = fixture(t, { installed: false });
  cli(item, ["setup", "--agents", "codex", "--json"], { binary: oldPackage(item) });
  const old = item.receipt();
  assert.equal(old.version, "0.0.9");
  const child = worker(item, { command: "update", boundary: "launcher-published" });
  const error = await child.event("result");
  assert.equal(error.code, "EIO");
  assert.equal((await child.exit).code, 1);
  const report = plan(item);
  assert.equal(report.operation, "update");
  assert.deepEqual(report.actions.map((entry) => entry.kind), ["restore-stale-launcher"]);
  const oldTree = tree(old.versionRoot);
  const result = await apply(item, report);
  assert.equal(result.applied.length, 1);
  assert.deepEqual(tree(old.versionRoot), oldTree);
  assert.equal(plan(item).actions.length, 0);
  cli(item, ["update", "--agents", "codex", "--json"]);
  assert.equal(runtimeHealth(item.config()).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(item.witnessFile, "utf8")).phase, "complete");
});

test("interrupted first setup retains its unmarked partial copy and can be explicitly retried", async (t) => {
  const item = fixture(t, { installed: false });
  const child = worker(item, { command: "setup", boundary: "runtime-copy" });
  assert.equal((await child.event("result")).code, "EIO");
  await child.exit;
  const before = tree(item.root);
  const report = plan(item);
  assert.equal(report.actions.length, 0);
  assert.ok(report.retained.some((entry) => /Inactive or unreceipted/.test(entry.reason)));
  await apply(item, report);
  assert.deepEqual(tree(item.root), before);
  const partial = fs.readdirSync(item.config().locations.runtimeDir).find((name) => name.includes(".tmp-"));
  assert.ok(partial);
  const partialTree = tree(path.join(item.config().locations.runtimeDir, partial));
  cli(item, ["setup", "--agents", "codex", "--json"]);
  assert.equal(runtimeHealth(item.config()).ok, true);
  assert.deepEqual(tree(path.join(item.config().locations.runtimeDir, partial)), partialTree);
});

test("interrupted uninstall creates only a tombstone and never resurrects or deletes payload", async (t) => {
  const item = fixture(t);
  const child = worker(item, { command: "uninstall", boundary: "launcher-removed" });
  assert.equal((await child.event("result")).code, "EIO");
  await child.exit;
  const data = item.config().locations;
  const beforeRuntime = tree(data.runtimeDir);
  const beforeBin = tree(data.binDir);
  const report = plan(item);
  assert.deepEqual(report.actions.map((entry) => entry.kind), ["restore-tombstone"]);
  await apply(item, report);
  assert.equal(item.receipt().status, "uninstalled");
  assert.deepEqual(tree(data.runtimeDir), beforeRuntime);
  assert.deepEqual(tree(data.binDir), beforeBin);
  assert.equal(ensureRuntime(item.config(), { automatic: true }), null);
  assert.equal((await apply(item)).applied.length, 0);
  cli(item, ["uninstall", "--json"]);
  assert.equal(item.receipt().status, "uninstalled");
});

test("missing tombstone restores uninstall intent without runtime creation", async (t) => {
  const item = fixture(t);
  cli(item, ["uninstall", "--json"]);
  const removed = fs.readFileSync(item.receiptFile);
  fs.unlinkSync(item.receiptFile);
  const report = plan(item);
  assert.deepEqual(report.actions.map((entry) => entry.kind), ["restore-tombstone"]);
  await apply(item, report);
  assert.deepEqual(fs.readFileSync(item.receiptFile), removed);
  assert.equal(fs.existsSync(item.config().locations.binDir), false);
  assert.equal(ensureRuntime(item.config(), { automatic: true }), null);
});

test("candidate changes after review are refused before locks or writes", async (t) => {
  const item = fixture(t);
  const absent = missingLauncher(item);
  const reviewed = plan(item);
  fs.writeFileSync(absent.file, "unowned competitor bytes\n");
  const before = tree(item.root);
  await assert.rejects(apply(item, reviewed), /plan changed/);
  assert.deepEqual(tree(item.root), before);
  const fresh = plan(item);
  assert.equal(fresh.actions.length, 0);
  assert.ok(fresh.retained.some((entry) => entry.path === absent.file));
});

test("each candidate is revalidated even after an earlier repair succeeded", async (t) => {
  const item = fixture(t);
  missingLauncher(item, "cargo");
  missingLauncher(item, "npm");
  const report = plan(item);
  assert.equal(report.actions.length, 2);
  const [first, second] = report.actions;
  const link = fs.linkSync;
  fs.linkSync = function (source, target) {
    const result = link(source, target);
    if (target === first.path) fs.writeFileSync(second.path, "competing user content\n");
    return result;
  };
  try {
    await assert.rejects(apply(item, report), (error) => {
      assert.match(error.message, /candidate changed under lock/);
      assert.equal(error.recovery.applied.length, 1);
      return true;
    });
  } finally { fs.linkSync = link; }
  assert.equal(fs.readFileSync(second.path, "utf8"), "competing user content\n");
  assert.equal(digest(fs.readFileSync(first.path)), first.sha256);
  item.assertProtected();
});

test("publication ENOSPC preserves the original error and partial staging evidence", async (t) => {
  const item = fixture(t);
  const absent = missingLauncher(item);
  const report = plan(item);
  const original = Object.assign(new Error("Injected ENOSPC: bounded 17-byte write"), { code: "ENOSPC" });
  const open = fs.openSync;
  const write = fs.writeFileSync;
  let descriptor;
  let stage;
  fs.openSync = function (file, ...args) {
    const fd = open(file, ...args);
    if (path.dirname(String(file)) === path.dirname(absent.file) && path.basename(String(file)).startsWith(".clean-development-recovery-")) { descriptor = fd; stage = file; }
    return fd;
  };
  fs.writeFileSync = function (file, bytes, ...args) {
    if (file === descriptor && descriptor !== undefined) {
      fs.writeSync(file, Buffer.from(bytes).subarray(0, 17));
      throw original;
    }
    return write(file, bytes, ...args);
  };
  try {
    await assert.rejects(apply(item, report), (error) => {
      assert.equal(error, original);
      assert.equal(error.code, "ENOSPC");
      assert.equal(error.recovery.retainedStage, stage);
      return true;
    });
  } finally { fs.openSync = open; fs.writeFileSync = write; }
  assert.equal(fs.statSync(stage).size, 17);
  const partial = fs.readFileSync(stage);
  assert.equal(fs.existsSync(absent.file), false);
  await apply(item);
  assert.deepEqual(fs.readFileSync(stage), partial);
  assert.deepEqual(fs.readFileSync(absent.file), absent.bytes);
  item.assertProtected();
});

test("uncertain lock metadata is retained, not guessed stale", async (t) => {
  const item = fixture(t);
  missingLauncher(item);
  const lock = path.join(item.config().locations.stateDir, "setup.lock");
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "owner.json"), "{ damaged");
  fs.utimesSync(lock, new Date(0), new Date(0));
  const before = tree(item.root);
  await assert.rejects(apply(item, plan(item), { lockTimeoutMs: 50 }), /no uncertain lock was removed/);
  assert.deepEqual(tree(item.root), before);
});

test("real process crashes retain evidence and a fresh explicit apply converges", { skip: process.platform === "win32" }, async (t) => {
  for (const boundary of ["repair-staged", "repair-published"]) {
    await t.test(boundary, async (t) => {
      const item = fixture(t);
      missingLauncher(item, "cargo");
      missingLauncher(item, "npm");
      const child = worker(item, { command: "recover", planId: plan(item).planId, boundary, crash: true });
      assert.equal((await child.exit).signal, "SIGKILL");
      assert.throws(() => process.kill(child.child.pid, 0), { code: "ESRCH" });
      const report = plan(item);
      assert.equal(report.actions.length, boundary === "repair-published" ? 1 : 2);
      const result = await apply(item, report);
      assert.equal(result.retainedLocks.length, 2);
      for (const retained of result.retainedLocks) assert.ok(fs.existsSync(retained.path));
      assert.equal(runtimeHealth(item.config()).ok, true);
      const after = tree(item.root);
      assert.equal((await apply(item)).applied.length, 0);
      assert.deepEqual(tree(item.root), after);
      item.assertProtected();
    });
  }
});

test("actual setup/uninstall and recovery serialize and reject the now-stale plan", async (t) => {
  for (const command of ["setup", "uninstall"]) {
    await t.test(command, async (t) => {
      const item = fixture(t);
      missingLauncher(item);
      const barrier = path.join(item.root, "release-lifecycle");
      const lifecycle = worker(item, { command, boundary: "witness-published", barrier });
      await lifecycle.event("boundary");
      const reviewed = plan(item);
      assert.ok(reviewed.actions.length > 0);
      const recovery = worker(item, { command: "recover", planId: reviewed.planId });
      await recovery.event("contended"); // Actual mkdir EEXIST: the lifecycle holds setup.lock.
      fs.writeFileSync(barrier, "release\n");
      const result = await recovery.event("result");
      assert.equal(result.ok, false);
      assert.match(result.message, /plan changed while waiting/);
      assert.equal((await lifecycle.event("result")).ok, true);
      await Promise.all([lifecycle.exit, recovery.exit]);
      assert.equal(item.receipt().status, command === "uninstall" ? "uninstalled" : "installed");
    });
  }
});

test("no-clobber publication preserves a competitor appearing at the final syscall", async (t) => {
  const item = fixture(t);
  const absent = missingLauncher(item);
  const report = plan(item);
  const original = fs.linkSync;
  fs.linkSync = function (from, to) {
    if (to === absent.file) fs.writeFileSync(to, "unowned final-boundary writer\n", { flag: "wx" });
    return original(from, to);
  };
  try {
    await assert.rejects(apply(item, report), (error) => {
      assert.equal(error.code, "EEXIST");
      assert.ok(fs.existsSync(error.recovery.retainedStage));
      return true;
    });
  } finally { fs.linkSync = original; }
  assert.equal(fs.readFileSync(absent.file, "utf8"), "unowned final-boundary writer\n");
  item.assertProtected();
});

test("a modified intermediate launcher is retained rather than rolled back", async (t) => {
  const item = fixture(t, { installed: false });
  cli(item, ["setup", "--agents", "codex", "--json"], { binary: oldPackage(item) });
  const child = worker(item, { command: "update", boundary: "launcher-published" });
  assert.equal((await child.event("result")).code, "EIO");
  await child.exit;
  const candidate = plan(item).actions.find((entry) => entry.kind === "restore-stale-launcher");
  assert.ok(candidate);
  fs.appendFileSync(candidate.path, "# user's modification after interruption\n");
  const before = tree(item.root);
  const report = plan(item);
  assert.equal(report.actions.length, 0);
  assert.ok(report.retained.some((entry) => entry.path === candidate.path && /modified/.test(entry.reason)));
  await apply(item, report);
  assert.deepEqual(tree(item.root), before);
});

test("missing or aliased runtime parents are reported without recreating them", async (t) => {
  for (const name of ["version", "src", "bin", "version-alias"]) await t.test(name, async (t) => {
    const item = fixture(t);
    const target = name === "bin" ? item.config().locations.binDir
      : name === "src" ? path.join(item.receipt().versionRoot, "src") : item.receipt().versionRoot;
    fs.renameSync(target, `${target}-detached`);
    if (name === "version-alias") fs.symlinkSync(`${target}-detached`, target, process.platform === "win32" ? "junction" : "dir");
    if (name === "src") missingLauncher(item);
    const before = tree(item.root);
    const report = plan(item);
    assert.equal(report.actions.length, 0);
    assert.ok(report.retained.length > 0);
    await apply(item, report);
    assert.deepEqual(tree(item.root), before);
  });
});

test("damaged agent receipts remain untouched with an actionable diagnosis", async (t) => {
  const item = fixture(t);
  const file = path.join(item.config().locations.stateDir, "integrations.json");
  fs.writeFileSync(file, "{ invalid receipt\n");
  const before = tree(item.root);
  const report = plan(item);
  assert.ok(report.retained.some((entry) => entry.path === file && /backup|manually/.test(entry.next)));
  await apply(item, report);
  assert.deepEqual(tree(item.root), before);
  item.assertProtected();
});

test("SIGKILL during real lifecycle publication preserves explicit operation intent", { skip: process.platform === "win32" }, async (t) => {
  for (const command of ["update", "uninstall"]) await t.test(command, async (t) => {
    const item = fixture(t, { installed: command === "uninstall" });
    if (command === "update") cli(item, ["setup", "--agents", "codex", "--json"], { binary: oldPackage(item) });
    const child = worker(item, { command, boundary: command === "update" ? "launcher-published" : "launcher-removed", crash: true });
    assert.equal((await child.exit).signal, "SIGKILL");
    assert.throws(() => process.kill(child.child.pid, 0), { code: "ESRCH" });
    const report = plan(item);
    assert.deepEqual(report.actions.map((entry) => entry.kind), [command === "update" ? "restore-stale-launcher" : "restore-tombstone"]);
    const result = await apply(item, report);
    assert.equal(result.retainedLocks.length, 2);
    const after = tree(item.root);
    assert.equal((await apply(item)).applied.length, 0);
    assert.deepEqual(tree(item.root), after);
    if (command === "uninstall") assert.equal(ensureRuntime(item.config(), { automatic: true }), null);
    else assert.equal(item.receipt().version, "0.0.9");
    // Only another explicit invocation completes installation/removal.
    cli(item, [command, ...(command === "update" ? ["--agents", "codex"] : []), "--json"]);
    assert.equal(item.receipt().status, command === "uninstall" ? "uninstalled" : "installed");
  });
});

test("restored stable launcher preserves argv, cwd, stdin/output bytes and child status", { skip: process.platform === "win32" }, async (t) => {
  const item = fixture(t);
  const absent = missingLauncher(item);
  await apply(item);
  const tools = path.join(item.root, "tools");
  fs.mkdirSync(tools);
  const program = path.join(tools, "capture.mjs");
  fs.writeFileSync(program, `import fs from 'node:fs';\nprocess.stdout.write(JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),stdin:fs.readFileSync(0).toString('hex')}));\nprocess.stderr.write(Buffer.from([0,255,42,10]));\nprocess.exitCode=23;\n`);
  const quote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;
  fs.writeFileSync(path.join(tools, "cargo"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(program)} "$@"\n`, { mode: 0o755 });
  const args = ["--version", "spaces = ü 東京", "", "single'quote", 'double"quote', "$not_expanded;*", "new\nline"];
  const input = Buffer.from([0, 255, 10, 17]);
  const result = spawnSync(absent.file, args, { cwd: item.project,
    env: { ...item.env, PATH: `${tools}${path.delimiter}${item.env.PATH}`, CLEAN_DEVELOPMENT_SESSION_MODE: "skip" },
    input, timeout: 10_000, maxBuffer: 64 * 1024 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 23);
  assert.deepEqual(JSON.parse(result.stdout.toString()), { argv: args, cwd: item.project, stdin: input.toString("hex") });
  assert.deepEqual(result.stderr, Buffer.from([0, 255, 42, 10]));
  item.assertProtected();
});

test("a valid-shaped but changed inventory cannot overrule its independent witness", async (t) => {
  const item = fixture(t);
  const receipt = item.receipt();
  receipt.runtimeFiles = receipt.runtimeFiles.filter((entry) => !entry.path.endsWith(`${path.sep}probe.js`));
  fs.writeFileSync(item.receiptFile, `${JSON.stringify(receipt)}\n`);
  missingLauncher(item);
  const before = tree(item.root);
  const report = plan(item);
  assert.equal(report.blocked, true);
  assert.equal(report.actions.length, 0);
  assert.ok(report.retained.some((entry) => /independent lifecycle snapshot/.test(entry.reason)));
  await apply(item, report);
  assert.deepEqual(tree(item.root), before);
});

test("ordinary runtime refresh timestamps do not invalidate otherwise identical ownership evidence", async (t) => {
  const item = fixture(t);
  const before = fs.readFileSync(item.receiptFile);
  ensureRuntime(item.config());
  assert.notDeepEqual(fs.readFileSync(item.receiptFile), before);
  const absent = missingLauncher(item);
  const report = plan(item);
  assert.equal(report.blocked, false);
  assert.deepEqual(report.actions.map((entry) => entry.kind), ["restore-launcher"]);
  await apply(item, report);
  assert.deepEqual(fs.readFileSync(absent.file), absent.bytes);
  item.assertProtected();
});

test("a repaired payload remains usable through the installed runtime itself", async (t) => {
  const item = fixture(t);
  const receipt = item.receipt();
  fs.unlinkSync(path.join(receipt.versionRoot, "src", "probe.js"));
  const result = await apply(item);
  assert.equal(result.applied.length, 1);
  const output = cli(item, ["run", "--session", "session-only", "--", process.execPath, "-e", "process.stdout.write('recovered-runtime')"],
    { binary: path.join(receipt.versionRoot, "bin", "clean-development.js") });
  assert.equal(output.stdout, "recovered-runtime");
  assert.equal(plan(item).actions.length, 0);
  item.assertProtected();
});
