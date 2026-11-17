// Installer locks under the format-2 rule: acquisition, owner release and removal.
// Real child processes run the real installer (install.sh, or installPackage from a node child) against a fixture HOME
// under CLEAN_DEV_TEST_DIR, from a fixture copy of the source without a private sidecar manifest beside it. Every pid
// these tests signal or name was recorded by the test itself.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { probeLock } from "../install-lock.mjs";
import { appendLog, rotate } from "../runtime/lib/fsutil.mjs";
import { plugin, sim } from "./helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const lockChild = path.join(here, "support", "lock-child.mjs");
const darwinOnly = process.platform === "darwin" ? false : "Darwin-only: runs the real installer and needs the kernel flock on APFS";

let source;
// One fixture copy of the installer source per run, including the hook planner and fragments.
function sourceCopy() {
  if (source) return source;
  const base = process.env.CLEAN_DEV_TEST_DIR;
  if (!base || !path.isAbsolute(base)) throw new Error("CLEAN_DEV_TEST_DIR must be absolute scratch");
  fs.mkdirSync(base, { recursive: true });
  const dir = path.join(fs.realpathSync(fs.mkdtempSync(path.join(base, "installer-src-"))), "clean-development");
  for (const name of ["runtime", "machine", "scripts", "fragments"]) fs.cpSync(path.join(plugin, name), path.join(dir, name), { recursive: true });
  for (const name of ["installer.mjs", "install-lock.mjs", "install.sh"]) fs.copyFileSync(path.join(plugin, name), path.join(dir, name));
  return (source = dir);
}
function fixture() {
  const s = sim({ mounted: false });
  const realHome = fs.realpathSync(os.userInfo().homedir);
  if (fs.realpathSync(s.home) === realHome || fs.realpathSync(s.env.HOME) === realHome) throw new Error("refusing to run: HOME resolves to the real home");
  const src = sourceCopy(), state = path.join(s.home, "dev", "machine", "state", "clean-development");
  fs.mkdirSync(state, { recursive: true });
  const env = { ...s.env, CLEAN_DEV_NODE: process.execPath };
  return { ...s, src, state, env, install: path.join(src, "install.sh"),
    lock: path.join(state, "install.lock"), guard: path.join(state, "install-recovery.lock") };
}
const run = (f, args, extra = {}) => spawnSync("/bin/sh", [f.install, ...args], { cwd: f.root, env: { ...f.env, ...extra }, encoding: "utf8", timeout: 60000 });
// Every child this file starts is recorded and SIGKILLed after its test if still running, so a failed assertion
// never leaves a stopped installer or a lock holder behind (and never signals a pid it did not record).
const running = new Set();
afterEach(() => { for (const c of running) { try { process.kill(c.pid, "SIGKILL"); } catch { /* gone */ } } running.clear(); });
function start(file, args, env, cwd) {
  const child = spawn(file, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  running.add(child); child.on("exit", () => running.delete(child));
  child.out = ""; child.err = "";
  child.stdout.on("data", (d) => { child.out += d; });
  child.stderr.on("data", (d) => { child.err += d; });
  child.exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  return child;
}
const startInstall = (f, args, extra = {}) => start("/bin/sh", [f.install, ...args], { ...f.env, ...extra }, f.root);
const holdLocks = (f, paths) => start(process.execPath, [lockChild, ...paths], f.env, f.root);
async function until(predicate, ms = 20000, what = "condition") {
  const end = Date.now() + ms;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
const procState = (pid) => String(spawnSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout).trim();
const waitStopped = (c) => until(() => procState(c.pid).startsWith("T"), 30000, `pid ${c.pid} to stop (${c.err})`);
const waitHeld = (c) => until(() => c.out.split("\n").includes("held"), 20000, `"held" from pid ${c.pid} (${c.err})`);
async function killed(c) { process.kill(c.pid, "SIGKILL"); return c.exited; }
async function deadFormat2(f, paths) {
  const c = holdLocks(f, paths); await waitHeld(c);
  assert.equal((await killed(c)).signal, "SIGKILL");
  for (const p of paths) assert.equal(probe(p), "free", `${path.basename(p)} is a dead format-2 lock`);
  return c.pid;
}
function probe(p) { const r = probeLock(p); if (r.fd !== undefined) fs.closeSync(r.fd); return r.state; }
const ino = (p) => fs.statSync(p).ino;
const hookLog = (f) => { try { return fs.readFileSync(path.join(f.state, "hook.log"), "utf8"); } catch { return ""; } };
const lockish = (dir) => fs.readdirSync(dir).filter((n) => /\.lock$|\.tmp$/.test(n)).sort();
const deadPid = () => spawnSync("/usr/bin/true").pid;
const ownerPid = (p) => JSON.parse(fs.readFileSync(p, "utf8")).pid;
// Interface 1, Logging: the busy records a refused installer run appends to hook.log.
const busyOwner = (cls, pid) => new RegExp(`^\\S+ install\\.lock busy: owner ${cls} pid ${pid} harness null session null event null$`, "m");
const busyGuard = (cls) => new RegExp(`^\\S+ install\\.lock busy: guard ${cls}$`, "m");
function fixtureTransaction(f) {
  const id = `fixture-${randomUUID()}`, dir = path.join(f.state, "installations", id);
  fs.mkdirSync(path.join(dir, "files"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "receipt.json"), JSON.stringify({ schemaVersion: 1, id, status: "activating", files: [] }), { mode: 0o600 });
  return id;
}
const receiptStatus = (f, id) => JSON.parse(fs.readFileSync(path.join(f.state, "installations", id, "receipt.json"), "utf8")).status;
// A node child running installPackage on the fixture HOME; onPhase acts at `phase` ("block" waits, "kill" SIGKILLs itself).
function installChild(f, phase, action) {
  const marker = path.join(f.root, `phase-${randomUUID()}`);
  const script = `import fs from "node:fs";
    import { installPackage } from ${JSON.stringify(pathToFileURL(path.join(f.src, "installer.mjs")).href)};
    installPackage(${JSON.stringify(f.src)}, process.env, { config: true, onPhase: (p) => {
      if (p !== ${JSON.stringify(phase)}) return;
      ${action === "kill" ? 'process.kill(process.pid, "SIGKILL");' : `fs.writeFileSync(${JSON.stringify(marker)}, ""); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);`}
    } });`;
  const c = start(process.execPath, ["--input-type=module", "-e", script], f.env, f.root);
  c.marker = marker;
  return c;
}
function pendingId(f) {
  const dir = path.join(f.state, "installations");
  const ids = fs.readdirSync(dir).filter((id) => receiptStatus(f, id) === "activating");
  assert.equal(ids.length, 1); return ids[0];
}
// Preload that makes process.kill report ESRCH ("dead") or success ("alive") for one recorded pid.
function killPreload(f, pid, report) {
  const file = path.join(f.root, `kill-${report}-${randomUUID()}.mjs`), seen = `${file}.loaded`;
  fs.writeFileSync(file, `import fs from "node:fs";
    const real = process.kill.bind(process);
    process.kill = (p, sig) => { if (p === ${pid} && (sig === 0 || sig === undefined)) { ${report === "dead" ? 'throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });' : "return true;"} } return real(p, sig); };
    fs.writeFileSync(${JSON.stringify(seen)}, "loaded");`);
  return { NODE_OPTIONS: `--import=${pathToFileURL(file).href}`, seen };
}

test("normal release: --config and --recover leave no lock, guard or temp; a held guard does not stop a running install", { skip: darwinOnly }, async () => {
  const f = fixture();
  const a = run(f, ["--config"]);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(JSON.parse(a.stdout).status, "committed");
  assert.deepEqual(lockish(f.state), []);
  const id = fixtureTransaction(f);
  const b = run(f, ["--recover", id]);
  assert.equal(b.status, 0, b.stderr);
  assert.equal(receiptStatus(f, id), "rolled-back");
  assert.deepEqual(lockish(f.state), []);
  assert.doesNotMatch(hookLog(f), /reclaimed|recovered/);
  // --config stopped at held, resumed while lock-child holds install-recovery.lock live.
  const c = startInstall(f, ["--config"], { CLEAN_DEV_TEST_STOP_AT: "held" });
  await waitStopped(c);
  assert.equal(probe(f.lock), "live");
  const g = holdLocks(f, [f.guard]); await waitHeld(g);
  const guardIno = ino(f.guard);
  process.kill(c.pid, "SIGCONT");
  const end = await c.exited;
  assert.equal(end.code, 0, c.err);
  assert.equal(fs.existsSync(f.lock), false, "install.lock released");
  assert.equal(ino(f.guard), guardIno, "the held guard is untouched");
  assert.equal(probe(f.guard), "live");
  g.stdin.end(); assert.equal((await g.exited).code, 0);
  assert.deepEqual(lockish(f.state), []);
  assert.doesNotMatch(hookLog(f), /reclaimed|recovered/);
});

test("live owner: an installer blocked in onPhase or SIGSTOPped at held keeps its lock whatever kill reports", { skip: darwinOnly }, async () => {
  const check = async (f, owner, id) => {
    const lockIno = ino(f.lock), lockOwner = ownerPid(f.lock);
    for (const report of ["dead", "alive"]) {
      const inject = killPreload(f, owner, report);
      const cfg = run(f, ["--config"], { NODE_OPTIONS: inject.NODE_OPTIONS });
      assert.equal(fs.existsSync(inject.seen), true, "the injected kill was loaded");
      assert.notEqual(cfg.status, 0); assert.match(cfg.stderr, /install lock busy/);
      const rec = run(f, ["--recover", id], { NODE_OPTIONS: inject.NODE_OPTIONS });
      assert.notEqual(rec.status, 0); assert.match(rec.stderr, /installer may still be alive; refusing recovery/);
      assert.equal(ino(f.lock), lockIno, `install.lock stays on its inode (kill reports ${report})`);
      assert.equal(probe(f.lock), "live");
      assert.equal(fs.existsSync(f.guard), false);
    }
    // Both commands, under both injected kill reports, log the live owner's busy record.
    assert.equal(hookLog(f).split("\n").filter((l) => busyOwner("live", lockOwner).test(l)).length, 4);
    assert.doesNotMatch(hookLog(f), /reclaimed|recovered/);
  };
  let f = fixture();
  const blocked = installChild(f, "runtime-published", "block");
  await until(() => fs.existsSync(blocked.marker), 30000, `onPhase in pid ${blocked.pid} (${blocked.err})`);
  await check(f, blocked.pid, pendingId(f));
  await killed(blocked);
  f = fixture();
  const stopped = startInstall(f, ["--config"], { CLEAN_DEV_TEST_STOP_AT: "held" });
  await waitStopped(stopped);
  await check(f, stopped.pid, fixtureTransaction(f));
  await killed(stopped);
});

test("killed owner: a dead install.lock is reclaimed by --config and by --recover", { skip: darwinOnly }, async () => {
  // SIGKILLed at held, no transaction yet: the next --config reclaims and installs.
  let f = fixture();
  const c = startInstall(f, ["--config"], { CLEAN_DEV_TEST_STOP_AT: "held" });
  await waitStopped(c); await killed(c);
  assert.equal(probe(f.lock), "free");
  const a = run(f, ["--config"]);
  assert.equal(a.status, 0, a.stderr);
  assert.match(hookLog(f), new RegExp(`install\\.lock reclaimed: owner exited \\(lock free\\); owner pid ${c.pid} token `));
  assert.match(a.stderr, /install\.lock reclaimed: owner exited \(lock free\)/);
  assert.match(hookLog(f), new RegExp(`^\\S+ install\\.lock reclaimed: owner exited \\(lock free\\); owner pid ${c.pid} token [0-9a-f-]{36} harness null session null event null acquiredAt \\d{4}-\\d\\d-\\d\\dT[0-9:.]+Z$`, "m"));
  assert.deepEqual(lockish(f.state), []);
  // SIGKILLed after the receipt says activating: --config reclaims and stops at the unfinished transaction.
  f = fixture();
  let k = installChild(f, "runtime-published", "kill");
  assert.equal((await k.exited).signal, "SIGKILL");
  let id = pendingId(f);
  const b = run(f, ["--config"]);
  assert.notEqual(b.status, 0); assert.match(b.stderr, /unfinished install transaction/);
  assert.match(hookLog(f), new RegExp(`install\\.lock reclaimed: owner exited \\(lock free\\); owner pid ${k.pid} `));
  assert.deepEqual(lockish(f.state), []);
  let r = run(f, ["--recover", id]);
  assert.equal(r.status, 0, r.stderr); assert.equal(receiptStatus(f, id), "rolled-back");
  // The same death recovered directly by --recover, which reclaims the lock itself (no manual unlink).
  f = fixture();
  k = installChild(f, "runtime-published", "kill");
  assert.equal((await k.exited).signal, "SIGKILL");
  id = pendingId(f);
  assert.equal(probe(f.lock), "free");
  r = run(f, ["--recover", id]);
  assert.equal(r.status, 0, r.stderr); assert.equal(receiptStatus(f, id), "rolled-back");
  assert.match(hookLog(f), new RegExp(`install\\.lock reclaimed: owner exited \\(lock free\\); owner pid ${k.pid} `));
  assert.deepEqual(lockish(f.state), []);
  const again = run(f, ["--config"]);
  assert.equal(again.status, 0, again.stderr);
});

test("replaced file: a remover stopped before its unlink leaves a replacement lock on its inode and refuses", { skip: darwinOnly }, async () => {
  const f = fixture();
  await deadFormat2(f, [f.lock]);
  const remover = startInstall(f, ["--config"], { CLEAN_DEV_TEST_STOP_AT: "reclaim:before-unlink" });
  await waitStopped(remover);
  fs.unlinkSync(f.lock); // the old inode goes; a live format-2 lock is published at the same name
  const owner = holdLocks(f, [f.lock]); await waitHeld(owner);
  const replacement = ino(f.lock), replacementOwner = ownerPid(f.lock);
  process.kill(remover.pid, "SIGCONT");
  const end = await remover.exited;
  assert.notEqual(end.code, 0);
  assert.match(remover.err, /install\.lock was replaced during recovery and left/);
  assert.match(hookLog(f), /install\.lock recovery refused: replaced between probe and unlink/);
  assert.match(hookLog(f), busyOwner("live", replacementOwner), "the replacement is classified, not the old owner");
  assert.doesNotMatch(hookLog(f), /reclaimed/);
  assert.equal(ino(f.lock), replacement); assert.equal(probe(f.lock), "live");
  owner.stdin.end(); assert.equal((await owner.exited).code, 0);
  assert.deepEqual(lockish(f.state), []);
});

test("guard: dead format-2 guards are recovered by both commands; legacy only by --recover with a dead pid", { skip: darwinOnly }, async () => {
  for (const cmd of ["config", "recover"]) {
    const args = (f) => cmd === "config" ? ["--config"] : ["--recover", fixtureTransaction(f)];
    // Alone, then above a dead install.lock.
    for (const both of [false, true]) {
      const f = fixture();
      const pid = await deadFormat2(f, both ? [f.guard, f.lock] : [f.guard]);
      const r = run(f, args(f));
      assert.equal(r.status, 0, `${cmd} both=${both}: ${r.stderr}`);
      assert.match(hookLog(f), new RegExp(`install-recovery\\.lock reclaimed: owner exited \\(lock free\\); owner pid ${pid} `));
      if (both) assert.match(hookLog(f), new RegExp(`install\\.lock reclaimed: owner exited \\(lock free\\); owner pid ${pid} `));
      assert.deepEqual(lockish(f.state), []);
    }
    // A live guard makes the command refuse.
    const f = fixture();
    const g = holdLocks(f, [f.guard]); await waitHeld(g);
    const guardIno = ino(f.guard);
    const r = run(f, args(f));
    assert.notEqual(r.status, 0); assert.match(r.stderr, /another recovery is active/);
    assert.match(hookLog(f), busyGuard("live"));
    assert.equal(ino(f.guard), guardIno); assert.equal(fs.existsSync(f.lock), false);
    g.stdin.end(); await g.exited;
  }
  // Legacy bodies (no lockFormat) on either file.
  const sleeper = start("/bin/sleep", ["120"], {}, "/");
  try {
    for (const which of ["guard", "lock"]) {
      const name = which === "guard" ? "install-recovery.lock" : "install.lock";
      // Dead pid: --config refuses and leaves it; --recover recovers it explicitly.
      let f = fixture();
      const dead = deadPid(), body = JSON.stringify({ pid: dead, token: randomUUID(), acquiredAt: new Date().toISOString(), bootId: null, bootTime: null });
      fs.writeFileSync(f[which], body, { mode: 0o600 });
      const before = ino(f[which]);
      const cfg = run(f, ["--config"]);
      assert.notEqual(cfg.status, 0, `${name} legacy --config`); assert.match(cfg.stderr, /only install\.sh --recover ID recovers it/);
      assert.equal(ino(f[which]), before); assert.equal(fs.readFileSync(f[which], "utf8"), body);
      assert.match(hookLog(f), which === "guard" ? busyGuard("legacy") : busyOwner("legacy", dead));
      const id = fixtureTransaction(f), rec = run(f, ["--recover", id]);
      assert.equal(rec.status, 0, rec.stderr);
      assert.match(hookLog(f), new RegExp(`${name.replace(".", "\\.")} recovered explicitly \\(owner dead\\); owner pid ${dead} `));
      assert.match(hookLog(f), new RegExp(`^\\S+ ${name.replace(".", "\\.")} recovered explicitly \\(owner dead\\); owner pid ${dead} token [0-9a-f-]{36} harness null session null event null acquiredAt \\d{4}-[0-9T:.-]+Z$`, "m"));
      assert.doesNotMatch(hookLog(f), /reclaimed/);
      assert.equal(receiptStatus(f, id), "rolled-back");
      assert.deepEqual(lockish(f.state), []);
      // A live pid, an empty body and an unparseable body are refused by both commands and left.
      for (const text of [JSON.stringify({ pid: sleeper.pid, token: randomUUID(), acquiredAt: new Date().toISOString() }), "", "{not json"]) {
        f = fixture();
        const cls = text.startsWith("{\"") ? "legacy" : "unreadable";
        const busy = which === "guard" ? busyGuard(cls) : busyOwner(cls, cls === "legacy" ? sleeper.pid : "null");
        fs.writeFileSync(f[which], text, { mode: 0o600 });
        const keep = ino(f[which]);
        for (const a of [["--config"], ["--recover", fixtureTransaction(f)]]) {
          const x = run(f, a);
          assert.notEqual(x.status, 0, `${name} ${JSON.stringify(text)} ${a[0]}`);
          assert.equal(ino(f[which]), keep); assert.equal(fs.readFileSync(f[which], "utf8"), text);
          assert.match(hookLog(f), busy, `${name} ${JSON.stringify(text)} ${a[0]} busy record`);
          assert.doesNotMatch(hookLog(f), /reclaimed|recovered/);
          fs.rmSync(path.join(f.state, "hook.log"), { force: true });
        }
        assert.doesNotMatch(hookLog(f), /reclaimed|recovered/);
      }
    }
  } finally { sleeper.kill("SIGKILL"); }
});

test("fence: while a remover is stopped before its unlink holding the guard, a second remover removes nothing", { skip: darwinOnly }, async () => {
  const f = fixture();
  await deadFormat2(f, [f.lock]);
  const first = startInstall(f, ["--config"], { CLEAN_DEV_TEST_STOP_AT: "reclaim:before-unlink" });
  await waitStopped(first);
  assert.equal(probe(f.guard), "live");
  const lockIno = ino(f.lock), guardIno = ino(f.guard);
  for (const a of [["--config"], ["--recover", fixtureTransaction(f)]]) {
    const x = run(f, a);
    assert.notEqual(x.status, 0, a[0]); assert.match(x.stderr, /another recovery is active/);
    assert.match(x.stderr, /install\.lock busy: guard live/);
    assert.equal(ino(f.lock), lockIno); assert.equal(ino(f.guard), guardIno);
  }
  process.kill(first.pid, "SIGCONT");
  const end = await first.exited;
  assert.notEqual(end.code, 0, "the first remover reclaims, then meets the fixture transaction");
  assert.match(first.err, /unfinished install transaction/);
  assert.equal((hookLog(f).match(/install\.lock reclaimed/g) || []).length, 1);
  assert.deepEqual(lockish(f.state), []);
});

test("unsupported state filesystem: both commands refuse before any guard recovery and unlink nothing", { skip: darwinOnly }, async () => {
  for (const both of [false, true]) {
    const f = fixture();
    await deadFormat2(f, both ? [f.guard, f.lock] : [f.guard]);
    const files = both ? [f.guard, f.lock] : [f.guard], inodes = files.map(ino);
    for (const a of [["--config"], ["--recover", fixtureTransaction(f)]]) {
      const x = run(f, a, { CLEAN_DEV_TEST_STATFS_TYPE: "17" });
      assert.notEqual(x.status, 0, `${a[0]} both=${both}`);
      assert.match(x.stderr, /install\.lock unsupported: state filesystem type 17 differs/);
      assert.deepEqual(files.map(ino), inodes, "every lock stays on its inode");
      for (const p of files) assert.equal(probe(p), "free");
    }
    assert.doesNotMatch(hookLog(f), /reclaimed|recovered|removed/);
    assert.deepEqual(lockish(f.state), files.map((p) => path.basename(p)).sort(), "no temp file");
    // On the supported filesystem the same state recovers.
    const ok = run(f, ["--config"]);
    assert.notEqual(ok.status, 0); assert.match(ok.stderr, /unfinished install transaction/);
    assert.match(hookLog(f), /install-recovery\.lock reclaimed: owner exited \(lock free\)/);
  }
});


test("installer log rotation keeps prior generations and appends a new log", () => {
  const s = sim(), file = path.join(s.root, "log", "hook.log");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "large"); fs.writeFileSync(`${file}.1`, "older");
  rotate(file, 1, 2);
  assert.equal(fs.readFileSync(`${file}.1`, "utf8"), "large");
  assert.equal(fs.readFileSync(`${file}.2`, "utf8"), "older");
  appendLog(file, "installer busy");
  assert.match(fs.readFileSync(file, "utf8"), /installer busy/);
});
