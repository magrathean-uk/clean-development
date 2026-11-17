// Complete body: fsutil readHeldBody, the installer's body reads and
// re-check, and withLock's owner release read the whole body through the held fd, never a 64 KiB prefix. Real
// install.sh children run against a fixture HOME under CLEAN_DEV_TEST_DIR, from a fixture copy of the installer source.
// Every child is spawned in its own process group, recorded at spawn, given a completion deadline and, on failure or
// after its test, SIGKILLed with its group and awaited to close. Every pid this file signals is one it recorded.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { probeLock, readHeldBody } from "../install-lock.mjs";
import { plugin, sim } from "./helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const darwinOnly = process.platform === "darwin" ? false : "Darwin-only: runs the real installer and needs the kernel flock on APFS";

// Four incomplete bodies, each after a complete record.
const TAILS = ["padding past 64 KiB, then bytes that are not JSON", "oversized (valid JSON over 64 KiB)", "trailing byte", "not UTF-8"];
const PADDED = " ".repeat(70 * 1024);
function incomplete(json, tail) {
  if (tail === "not UTF-8") return Buffer.concat([Buffer.from(`${json.slice(0, -1)},"note":"`), Buffer.from([0xff, 0xfe]), Buffer.from('"}')]);
  return Buffer.from(json + (tail === "trailing byte" ? "x" : tail.startsWith("oversized") ? PADDED : `${PADDED}}not json`));
}
// A foreign write into an existing file's inode: the tail appended, or (not UTF-8) the body rewritten in place with a
// string holding bytes that are not UTF-8, which a lenient decoder would turn into U+FFFD and parse.
function giveTail(p, tail) {
  const json = fs.readFileSync(p, "utf8"), bytes = incomplete(json, tail);
  const fd = fs.openSync(p, "r+");
  try { fs.writeSync(fd, bytes, 0, bytes.length, 0); } finally { fs.closeSync(fd); }
  return bytes;
}

// Children.
const children = new Set();
const gone = (c) => c.exitCode !== null || c.signalCode !== null;
function start(file, args, env, cwd) {
  const c = spawn(file, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  children.add(c);
  c.out = ""; c.err = "";
  c.stdout.on("data", (d) => { c.out += d; });
  c.stderr.on("data", (d) => { c.err += d; });
  c.on("error", (e) => { c.spawnError = e; c.err += `spawn error: ${e.message}\n`; });
  c.exited = new Promise((resolve) => c.on("close", (code, signal) => { children.delete(c); resolve({ code, signal, error: c.spawnError ?? null }); }));
  return c;
}
async function reap(c) {
  if (!gone(c) && c.pid) { try { process.kill(-c.pid, "SIGKILL"); } catch { /* group gone */ } try { c.kill("SIGKILL"); } catch { /* gone */ } }
  for (const s of [c.stdin, c.stdout, c.stderr]) s?.destroy();
  await c.exited;
}
afterEach(() => Promise.all([...children].map(reap)));
async function finished(c, ms = 60000) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(resolve, ms, null); });
  const r = await Promise.race([c.exited, late]);
  clearTimeout(timer);
  if (r) return r;
  await reap(c);
  throw new Error(`pid ${c.pid} did not finish within ${ms} ms: ${c.out} ${c.err}`);
}
async function until(predicate, what, child, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    if (predicate()) return;
    if (child && gone(child)) throw new Error(`pid ${child.pid} exited before ${what}: ${child.out} ${child.err}`);
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
const bounded = { encoding: "utf8", timeout: 10000, killSignal: "SIGKILL" };
const procState = (pid) => String(spawnSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], bounded).stdout ?? "").trim();
const waitStopped = (c) => until(() => procState(c.pid).startsWith("T"), `pid ${c.pid} to stop`, c);
const deadPid = () => { const r = spawnSync("/usr/bin/true", [], bounded); assert.equal(r.status, 0); return r.pid; };

// Fixture.
let source;
function sourceCopy() {
  if (source) return source;
  const base = process.env.CLEAN_DEV_TEST_DIR;
  if (!base || !path.isAbsolute(base)) throw new Error("CLEAN_DEV_TEST_DIR must be absolute scratch");
  fs.mkdirSync(base, { recursive: true });
  const dir = path.join(fs.realpathSync(fs.mkdtempSync(path.join(base, "complete-body-src-"))), "clean-development");
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
  return { ...s, src, state, env: { ...s.env, CLEAN_DEV_NODE: process.execPath },
    lock: path.join(state, "install.lock"), guard: path.join(state, "install-recovery.lock") };
}
const installer = async (f, args, extra = {}) => {
  const c = start("/bin/sh", [path.join(f.src, "install.sh"), ...args], { ...f.env, ...extra }, f.root);
  c.stdin.end();
  const r = await finished(c);
  return { code: r.error ? `spawn error ${r.error.code}` : r.code, signal: r.signal, err: c.err, out: c.out };
};
function fixtureTransaction(f) {
  const id = `fixture-${randomUUID()}`, dir = path.join(f.state, "installations", id);
  fs.mkdirSync(path.join(dir, "files"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "receipt.json"), JSON.stringify({ schemaVersion: 1, id, status: "activating", files: [] }), { mode: 0o600 });
  return id;
}
function probe(p) { const r = probeLock(p); if (r.fd !== undefined) fs.closeSync(r.fd); return r.state; }
const ino = (p) => fs.lstatSync(p).ino;
const snap = (p) => ({ ino: ino(p), bytes: fs.readFileSync(p).toString("base64") });
const hookLog = (f) => { try { return fs.readFileSync(path.join(f.state, "hook.log"), "utf8"); } catch { return ""; } };
const clearLog = (f) => fs.rmSync(path.join(f.state, "hook.log"), { force: true });
const lockish = (dir) => fs.readdirSync(dir).filter((n) => /\.lock$|\.tmp$/.test(n)).sort();
// The installed shim, launcher and runtime root: every entry's type, mode, inode and content (or link target).
function installed(f) {
  const out = {};
  const walk = (p) => {
    const st = fs.lstatSync(p), key = path.relative(f.home, p);
    if (st.isSymbolicLink()) out[key] = `link ${fs.readlinkSync(p)} ${st.ino}`;
    else if (st.isDirectory()) { out[key] = `dir ${st.mode} ${st.ino}`; for (const n of fs.readdirSync(p).sort()) walk(path.join(p, n)); }
    else out[key] = `file ${st.mode} ${st.ino} ${createHash("sha256").update(fs.readFileSync(p)).digest("hex")}`;
  };
  for (const p of [path.join(f.home, "dev", "machine", "runtime"), path.join(f.home, "dev", "machine", "bin", "clean-development")]) walk(p);
  assert.ok(Object.keys(out).some((k) => k.endsWith(path.join("active", "bin", "cd-hook"))), "the hook shim is installed");
  return out;
}
const format2 = (token) => JSON.stringify({ lockFormat: 2, pid: deadPid(), token, bootId: null, bootTime: null, acquiredAt: new Date().toISOString(), harness: null, sessionId: null, event: null });
const legacy = (token) => JSON.stringify({ pid: deadPid(), token, acquiredAt: new Date().toISOString(), bootId: null, bootTime: null });
const busyLine = (which) => which === "guard" ? /^\S+ install\.lock busy: guard unreadable$/m
  : /^\S+ install\.lock busy: owner unreadable pid null harness null session null event null$/m;

test("readHeldBody returns the complete text or null; it parses nothing", () => {
  const base = process.env.CLEAN_DEV_TEST_DIR;
  if (!base || !path.isAbsolute(base)) throw new Error("CLEAN_DEV_TEST_DIR must be absolute scratch");
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, "held-body-"));
  const json = JSON.stringify({ lockFormat: 2, pid: 1, token: "t" });
  const read = (bytes) => {
    const p = path.join(dir, randomUUID());
    fs.writeFileSync(p, bytes);
    const fd = fs.openSync(p, "r");
    try { return readHeldBody(fd); } finally { fs.closeSync(fd); }
  };
  for (const tail of TAILS) {
    const got = read(incomplete(json, tail));
    if (tail === "trailing byte") assert.equal(got, `${json}x`, tail);
    else assert.equal(got, null, tail);
  }
  assert.equal(read(Buffer.from(json)), json);
  assert.equal(read(Buffer.alloc(0)), "");
  // The 64 KiB bound is fstat's size: 65536 bytes are read, 65537 are not.
  const at = (n) => Buffer.from(json + " ".repeat(n - json.length));
  assert.equal(read(at(64 * 1024)), at(64 * 1024).toString());
  assert.equal(read(at(64 * 1024 + 1)), null);
  // A file that grows during the read: the first readSync appends before it returns.
  const p = path.join(dir, "grows");
  fs.writeFileSync(p, json);
  const real = fs.readSync;
  let appended = 0;
  fs.readSync = function growing(...args) { if (!appended++) fs.appendFileSync(p, " "); return real.apply(this, args); };
  const fd = fs.openSync(p, "r");
  try { assert.equal(readHeldBody(fd), null); } finally { fs.readSync = real; fs.closeSync(fd); }
  assert.equal(appended > 0, true, "the wrapper ran");
  // A file that shrinks during the read.
  const q = path.join(dir, "shrinks");
  fs.writeFileSync(q, json);
  fs.readSync = function shrinking(...args) { fs.readSync = real; fs.truncateSync(q, 3); return real.apply(this, args); };
  const fd2 = fs.openSync(q, "r");
  try { assert.equal(readHeldBody(fd2), null); } finally { fs.readSync = real; fs.closeSync(fd2); }
  // A read error throws; it is never a body.
  const fd3 = fs.openSync(path.join(dir, "closed"), "w");
  fs.closeSync(fd3);
  assert.throws(() => readHeldBody(fd3), { code: "EBADF" });
});

test("recovery: an incomplete installer lock or guard is refused by --config and --recover and left on its inode", { skip: darwinOnly }, async () => {
  for (const which of ["lock", "guard"]) {
    const f = fixture(), name = which === "guard" ? "install-recovery" : "install";
    const ok = await installer(f, ["--config"]);
    assert.equal(ok.code, 0, ok.err);
    const before = installed(f), id = fixtureTransaction(f);
    clearLog(f);
    for (const tail of TAILS) for (const args of [["--config"], ["--recover", id]]) {
      const label = `${name}.lock, ${tail}, ${args[0]}`;
      fs.writeFileSync(f[which], incomplete(format2(`${name}-token`), tail), { mode: 0o600 });
      const keep = snap(f[which]);
      assert.equal(probe(f[which]), "free", label);
      const r = await installer(f, args);
      assert.notEqual(r.code, 0, `${label}: ${r.out}`);
      assert.match(r.err, new RegExp(`cannot verify old ${name}\\.lock owner; inspect manually; no files changed`), label);
      assert.match(hookLog(f), new RegExp(`^\\S+ ${name}\\.lock recovery refused: empty or unparseable body$`, "m"), label);
      assert.match(hookLog(f), busyLine(which), label);
      assert.doesNotMatch(hookLog(f), /reclaimed|recovered/, label);
      assert.deepEqual(snap(f[which]), keep, `${label}: left on its inode`);
      assert.deepEqual(installed(f), before, `${label}: shim, launcher and runtime root unchanged`);
      assert.deepEqual(lockish(f.state), [`${name}.lock`], `${label}: nothing else left`);
      fs.unlinkSync(f[which]); clearLog(f);
    }
    // Legacy bodies with a dead pid: --recover refuses them too.
    for (const tail of TAILS) {
      const label = `legacy ${name}.lock, ${tail}`;
      fs.writeFileSync(f[which], incomplete(legacy(`${name}-token`), tail), { mode: 0o600 });
      const keep = snap(f[which]);
      const r = await installer(f, ["--recover", id]);
      assert.notEqual(r.code, 0, label);
      assert.match(r.err, new RegExp(`cannot verify old ${name}\\.lock owner; inspect manually; no files changed`), label);
      assert.match(hookLog(f), new RegExp(`${name}\\.lock recovery refused: empty or unparseable body`), label);
      assert.match(hookLog(f), busyLine(which), label);
      assert.doesNotMatch(hookLog(f), /reclaimed|recovered/, label);
      assert.deepEqual(snap(f[which]), keep, label);
      assert.deepEqual(installed(f), before, label);
      fs.unlinkSync(f[which]); clearLog(f);
    }
    // Control: the complete body is recovered by --recover, and the transaction rolls back.
    fs.writeFileSync(f[which], format2(`${name}-token`), { mode: 0o600 });
    const r = await installer(f, ["--recover", id]);
    assert.equal(r.code, 0, r.err);
    assert.match(hookLog(f), new RegExp(`${name}\\.lock reclaimed: owner exited \\(lock free\\)`));
    assert.deepEqual(lockish(f.state), []);
  }
});

test("re-check: a tail given between probe and unlink fails the re-check and the lock stays on its inode", { skip: darwinOnly }, async () => {
  for (const tail of TAILS) {
    const f = fixture(), id = fixtureTransaction(f);
    fs.writeFileSync(f.lock, format2("install-token"), { mode: 0o600 });
    const inode = ino(f.lock);
    const c = start("/bin/sh", [path.join(f.src, "install.sh"), "--recover", id], { ...f.env, CLEAN_DEV_TEST_STOP_AT: "reclaim:before-unlink" }, f.root);
    c.stdin.end();
    await waitStopped(c);
    const bytes = giveTail(f.lock, tail);
    process.kill(c.pid, "SIGCONT");
    const end = await finished(c);
    assert.notEqual(end.code, 0, tail);
    assert.match(c.err, /cannot verify old install\.lock owner; inspect manually; no files changed/, tail);
    assert.match(hookLog(f), /install\.lock recovery refused: body changed between probe and unlink: empty or unparseable body; owner pid \d+ token install-token$/m, tail);
    assert.match(hookLog(f), busyLine("lock"), tail);
    assert.doesNotMatch(hookLog(f), /reclaimed|recovered/, tail);
    assert.equal(ino(f.lock), inode, `${tail}: left on its inode`);
    assert.deepEqual(fs.readFileSync(f.lock), bytes, tail);
    assert.equal(probe(f.lock), "free", tail);
    assert.deepEqual(lockish(f.state), ["install.lock"], `${tail}: the guard was released, no temp`);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.state, "installations", id, "receipt.json"), "utf8")).status, "activating", tail);
  }
});

test("owner release: a foreign tail in the owner's inode leaves the lock; an unchanged body is released", { skip: darwinOnly }, async () => {
  // An installer stopped at held: after SIGCONT it finishes, leaves the tailed install.lock and the next --config refuses it.
  for (const tail of [...TAILS, null]) {
    const label = `install.lock, ${tail ?? "unchanged"}`, f = fixture();
    const c = start("/bin/sh", [path.join(f.src, "install.sh"), "--config"], { ...f.env, CLEAN_DEV_TEST_STOP_AT: "held" }, f.root);
    c.stdin.end();
    await waitStopped(c);
    assert.equal(probe(f.lock), "live", label);
    const inode = ino(f.lock), bytes = tail ? giveTail(f.lock, tail) : fs.readFileSync(f.lock);
    process.kill(c.pid, "SIGCONT");
    const end = await finished(c);
    assert.equal(end.code, 0, `${label}: ${c.err}`);
    if (!tail) { assert.deepEqual(lockish(f.state), [], label); continue; }
    assert.equal(ino(f.lock), inode, `${label}: left on its inode`);
    assert.deepEqual(fs.readFileSync(f.lock), bytes, label);
    assert.equal(probe(f.lock), "free", label);
    assert.deepEqual(lockish(f.state), ["install.lock"], `${label}: no temp file`);
    const next = await installer(f, ["--config"]);
    assert.notEqual(next.code, 0, label);
    assert.match(next.err, /cannot verify old install\.lock owner; inspect manually; no files changed/, label);
    assert.match(hookLog(f), /install\.lock recovery refused: empty or unparseable body/, label);
    assert.match(hookLog(f), busyLine("lock"), label);
    assert.equal(ino(f.lock), inode, label);
  }
  // Control: an unchanged dead format-2 install.lock is still reclaimed by --config.
  const f = fixture();
  fs.writeFileSync(f.lock, format2("install-token"), { mode: 0o600 });
  const r = await installer(f, ["--config"]);
  assert.equal(r.code, 0, r.err);
  assert.match(hookLog(f), /install\.lock reclaimed: owner exited \(lock free\); owner pid \d+ token install-token /);
  assert.deepEqual(lockish(f.state), []);
});
