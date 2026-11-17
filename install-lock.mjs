// Installer transaction lock. Kept outside the shipped runtime.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatOrNull, readJsonOrNull } from "./runtime/lib/fsutil.mjs";

const childTimeout = (capMs) => capMs;

// Test-mode binary hook: with DEV_STORAGE_VOLUME_TEST and an absolute
// CLEAN_DEV_TEST_BIN_DIR set, du, ps and sysctl run from that directory. Without test mode the absolute system path is
// used whatever the variable says.
export function helperBinary(name, systemPath, env = process.env) {
  const dir = env.DEV_STORAGE_VOLUME_TEST ? env.CLEAN_DEV_TEST_BIN_DIR : null;
  return dir && path.isAbsolute(dir) ? path.join(dir, name) : systemPath;
}

// The current boot: macOS kern.bootsessionuuid (new on every boot, not on wake) and kern.boottime; Linux boot_id.
// { id: null, time: null } when unreadable. Lock owners record it so a reboot is proved by identity: kern.boottime
// alone is not proof, because XNU shifts it when the clock is set. Ids are canonical upper-case UUIDs or null.
// Test mode only (DEV_STORAGE_VOLUME_TEST set): CLEAN_DEV_TEST_BOOT is JSON { id, time } or "unknown".
const UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;
export function normBootId(id) { const u = typeof id === "string" ? id.trim().toUpperCase() : ""; return UUID.test(u) ? u : null; }
export function parseDarwinBoot(text) {
  const [uuid = "", bt = ""] = String(text ?? "").split("\n");
  const m = /^\{\s*sec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)\s*\}/.exec(bt.trim());
  return { id: normBootId(uuid), time: m ? Number(m[1]) * 1000 + Math.floor(Number(m[2]) / 1000) : null };
}
let realBoot;
export function bootIdentity(env = process.env) {
  if (env.DEV_STORAGE_VOLUME_TEST && env.CLEAN_DEV_TEST_BOOT !== undefined) {
    let t = null; try { t = JSON.parse(env.CLEAN_DEV_TEST_BOOT); } catch { /* unknown */ }
    return { id: normBootId(t?.id), time: Number.isFinite(t?.time) ? t.time : null };
  }
  if (realBoot) return realBoot;
  let boot = { id: null, time: null };
  if (process.platform === "darwin") {
    const r = spawnSync(helperBinary("sysctl", "/usr/sbin/sysctl", env), ["-n", "kern.bootsessionuuid", "kern.boottime"], { encoding: "utf8", timeout: childTimeout(1000) });
    if (r.status === 0 && !r.error) boot = parseDarwinBoot(r.stdout);
  } else if (process.platform === "linux") {
    try { boot.id = normBootId(fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8")); } catch { /* unknown */ }
    const up = os.uptime(); if (Number.isFinite(up) && up > 0) boot.time = Date.now() - Math.round(up * 1000);
  }
  realBoot = boot;
  return realBoot;
}

// Installer lock. The only same-boot liveness proof is the kernel advisory lock
// (BSD flock through O_EXLOCK) on the lock file's inode: the owner takes it on a private temp file before the lock path
// exists, publishes the complete body with link(2) and holds the fd until its owner release has unlinked the path.
// The kernel drops it when the owner exits by any cause. pid, start time, wall clock and age are never proof.
const O_EXLOCK = 0x20; // Darwin <fcntl.h>; Node does not export it.
const HELD_READ_MAX = 64 * 1024;
const testMode = (env = process.env) => !!env.DEV_STORAGE_VOLUME_TEST;


// Test mode only: SIGSTOP this process at a named lock-protocol point (CLEAN_DEV_TEST_STOP_AT).
export function testStop(point, env = process.env) {
  if (testMode(env) && env.CLEAN_DEV_TEST_STOP_AT === point) process.kill(process.pid, "SIGSTOP");
}
// Test mode only: forced refusals (CLEAN_DEV_TEST_LOCK_REFUSE=exlock|link, CLEAN_DEV_TEST_STATFS_TYPE=<type>). They can
// only make a lock fail closed; nothing selects a backend.
function refused(kind, env = process.env) {
  if (!testMode(env)) return false;
  return String(env.CLEAN_DEV_TEST_LOCK_REFUSE || "").split(",").includes(kind);
}
const errnoError = (code) => Object.assign(new Error(code), { code });

// The state directory must be on the filesystem type of the sealed system volume (APFS). statfs follows links, so a
// redirected directory is checked at its target. Two syscalls, nothing spawned.
export function stateFsSupported(dir, env = process.env) {
  if (process.platform !== "darwin") return { supported: false, reason: `platform ${process.platform}` };
  let type, rootType;
  try { type = fs.statfsSync(dir).type; rootType = fs.statfsSync("/").type; } catch (e) { return { supported: false, reason: `statfs ${e.code || e.message}` }; }
  if (testMode(env) && env.CLEAN_DEV_TEST_STATFS_TYPE !== undefined && env.CLEAN_DEV_TEST_STATFS_TYPE !== "") {
    const forced = Number(env.CLEAN_DEV_TEST_STATFS_TYPE);
    if (forced !== rootType) type = Number.isFinite(forced) ? forced : env.CLEAN_DEV_TEST_STATFS_TYPE;
  }
  return type === rootType ? { supported: true, type, rootType }
    : { supported: false, type, rootType, reason: `state filesystem type ${type} differs from the system volume type ${rootType} (APFS required)` };
}

// Probe: live (another open file description holds the flock), free (the returned fd now holds it; the caller closes
// it), absent, or unreadable. A legacy body probes free because its owner held no flock.
export function probeLock(p) {
  if (process.platform !== "darwin") return { state: "unreadable", reason: `platform ${process.platform}` };
  let fd;
  try { fd = fs.openSync(p, fs.constants.O_RDONLY | O_EXLOCK | fs.constants.O_NONBLOCK); } catch (e) {
    if (e.code === "EAGAIN" || e.code === "EWOULDBLOCK") return { state: "live" };
    if (e.code === "ENOENT") return { state: "absent" };
    return { state: "unreadable", reason: e.code || e.message };
  }
  return { state: "free", fd };
}
// Reads at most 64 KiB through a held fd, from the start of the file.
export function readHeld(fd) {
  const buf = Buffer.alloc(HELD_READ_MAX);
  let n = 0;
  while (n < buf.length) { const r = fs.readSync(fd, buf, n, buf.length - n, n); if (r <= 0) break; n += r; }
  return buf.subarray(0, n).toString("utf8");
}
// Unlinks p only when its inode and device equal fstat(fd) and accept(text read through fd) holds.
export function unlinkHeld(p, fd, accept) {
  const held = fs.fstatSync(fd), current = lstatOrNull(p);
  if (!current || current.ino !== held.ino || current.dev !== held.dev) return false;
  let ok = false;
  try { ok = !!accept(readHeld(fd)); } catch { ok = false; }
  if (!ok) return false;
  try { fs.unlinkSync(p); return true; } catch (e) { if (e.code === "ENOENT") return false; throw e; }
}
// Complete body: the text of the whole file read through fd from offset 0, or null
// when fstat gives more than 64 KiB, when the read does not return exactly the fstat size (the body changed during the
// read) or when the bytes are not valid UTF-8. It checks size, completeness and encoding only and parses nothing: its
// callers parse the text, so trailing bytes fail there. The decoder drops one leading BOM. A read
// error throws. readHeld keeps its 64 KiB prefix read for unlinkHeld.
const heldUtf8 = new TextDecoder("utf-8", { fatal: true });
export function readHeldBody(fd) {
  const size = fs.fstatSync(fd).size;
  if (size > HELD_READ_MAX) return null;
  const buf = Buffer.alloc(size + 1);
  let n = 0;
  while (n < buf.length) { const r = fs.readSync(fd, buf, n, buf.length - n, n); if (r <= 0) break; n += r; }
  if (n !== size) return null;
  try { return heldUtf8.decode(buf.subarray(0, n)); } catch { return null; }
}
// Owner release acceptance: the complete body read through the held fd (never a prefix, never the path) is one JSON
// object carrying this token. The text unlinkHeld passes (its prefix read) is ignored. A read error is a refusal.
const ownBody = (fd, token) => () => {
  try { const o = JSON.parse(readHeldBody(fd)); return !!o && typeof o === "object" && !Array.isArray(o) && o.token === token; } catch { return false; }
};

// Non-blocking owner-fenced lock. Never steal a lock by age: a paused owner can still resume. A held lock returns
// { locked: true, owner, recoveryRequired: true }; an unsupported platform, state filesystem, flock or link returns
// { locked: true, unsupported } having created nothing. The installer reclaims a lock whose owner has exited (flock free).
// The fd is private: never returned, exported or passed to a spawn (libuv opens it close-on-exec).
export function withLock(lockPath, fn, { boot = bootIdentity() } = {}) {
  const token = randomUUID();
  const body = { pid: process.pid, token, acquiredAt: new Date().toISOString(), bootId: normBootId(boot?.id),
    bootTime: Number.isFinite(boot?.time) ? new Date(boot.time).toISOString() : null, lockFormat: 2,
    harness: null, sessionId: null, event: null };
  if (process.platform !== "darwin") return { locked: true, unsupported: `platform ${process.platform}` };
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const fsCheck = stateFsSupported(path.dirname(lockPath));
  if (!fsCheck.supported) return { locked: true, unsupported: fsCheck.reason };
  // A published lock is held: answer without creating a temp file, so a busy lock leaves its directory untouched.
  if (lstatOrNull(lockPath)) return { locked: true, owner: readJsonOrNull(lockPath), recoveryRequired: true };
  const tmp = `${lockPath}.${token}.tmp`;
  let fd;
  try {
    if (refused("exlock")) throw errnoError("ENOTSUP");
    fd = fs.openSync(tmp, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | O_EXLOCK | fs.constants.O_NONBLOCK, 0o600);
  } catch (e) { return { locked: true, unsupported: `flocked temp open ${e.code || e.message}` }; }
  // The creator's own temp is removed by owner release too (Removal rule, contract 1): through the held fd, only while
  // the temp path still names that inode and the body read through the fd carries this token. A temp path replaced
  // while this process was paused is left as it is.
  const releaseTmp = () => { try { unlinkHeld(tmp, fd, ownBody(fd, token)); } catch { /* a replaced or vanished temp is left */ } };
  const drop = () => { releaseTmp(); try { fs.closeSync(fd); } catch { /* ignore */ } };
  try {
    const data = Buffer.from(JSON.stringify(body));
    let off = 0;
    while (off < data.length) off += fs.writeSync(fd, data, off, data.length - off, off);
    testStop("acquire:before-link");
    if (refused("link")) throw errnoError("EPERM");
    fs.linkSync(tmp, lockPath);
  } catch (e) {
    drop();
    if (e.code === "EEXIST") return { locked: true, owner: readJsonOrNull(lockPath), recoveryRequired: true };
    return { locked: true, unsupported: `lock link ${e.code || e.message}` };
  }
  try {
    testStop("acquire:after-link");
    releaseTmp(); // published; the inode stays the lock path's
    testStop("held");
    return { locked: false, result: fn() };
  } finally {
    // Owner release (Removal rule, contract 1): through the held fd, own token only, no probe and no guard.
    try { unlinkHeld(lockPath, fd, ownBody(fd, token)); } catch { /* a replaced or vanished path is left */ }
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

