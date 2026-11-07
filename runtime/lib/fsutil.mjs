// clean-development 0.6.2: bounded filesystem helpers and the only deletion path.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import os from "node:os";

export function lstatOrNull(p) { try { return fs.lstatSync(p); } catch { return null; } }
export function exists(p) { return lstatOrNull(p) !== null; }
export function readJsonOrNull(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }

export function writeFileAtomic(p, data, mode = 0o600, { durable = false } = {}) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { mode, flag: "wx" });
    fs.chmodSync(tmp, mode);
    if (durable) {
      const fd = fs.openSync(tmp, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    fs.renameSync(tmp, p);
    if (durable) syncDirectory(path.dirname(p));
  } finally { try { fs.unlinkSync(tmp); } catch { /* promoted or never created */ } }
}

export function syncDirectory(dir) {
  const fd = fs.openSync(dir, "r");
  try { fs.fsyncSync(fd); } catch (e) { if (!["EINVAL", "ENOTSUP"].includes(e.code)) throw e; } finally { fs.closeSync(fd); }
}

export function children(dir, limit = 5000, { requireComplete = false } = {}) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    if (requireComplete && entries.length > limit) throw new Error(`inspection limit exceeded: ${dir}`);
    return entries.slice(0, limit);
  } catch (e) { if (e.code === "ENOENT" || e.code === "ENOTDIR") return []; throw e; }
}

// Last use = newest mtime of the entry and its direct children (bounded). Symlinks are not followed. Names in
// ignore (our own metadata such as .owner.json) are not activity.
export function lastUsedMs(p, limit = 2000, { deadline = Infinity, ignore = null } = {}) {
  let st;
  try { st = fs.lstatSync(p); } catch (e) { return e.code === "ENOENT" ? 0 : Infinity; }
  let newest = st.mtimeMs;
  if (st.isDirectory()) {
    let entries;
    try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch { return Infinity; }
    if (entries.length > limit) return Infinity; // incomplete observation cannot prove idle
    for (const d of entries) {
      if (!timeLeft(deadline)) return Infinity;
      if (ignore?.has(d.name)) continue;
      let c;
      try { c = fs.lstatSync(path.join(p, d.name)); } catch (e) { if (e.code !== "ENOENT") return Infinity; }
      if (c && c.mtimeMs > newest) newest = c.mtimeMs;
    }
  }
  return newest;
}

// Allocated size via du -sk (BSD), bounded by a timeout. Returns null when unknown.
export function sizeBytes(p, timeoutMs = 120000) {
  const r = spawnSync("/usr/bin/du", ["-sk", p], { encoding: "utf8", timeout: timeoutMs });
  if (r.status !== 0 || r.error) return null;
  const kb = Number(String(r.stdout).trim().split(/\s+/)[0]);
  return /^\d+\s/.test(String(r.stdout).trim()) && Number.isFinite(kb) ? kb * 1024 : null;
}

export function canonicalPath(p) { try { return fs.realpathSync(p); } catch { return null; } }
export function strictlyBelow(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

// An independently trusted directory anchor must not itself be a link. Neither may any managed
// component below it. Parent aliases (e.g. macOS /var -> /private/var) are resolved consistently.
// Missing descendants are allowed for creation; a missing anchor is allowed only during layout setup.
export function safeDirectory(anchor, dir, { missingAnchor = false } = {}) {
  if (!path.isAbsolute(anchor) || !path.isAbsolute(dir) || path.parse(anchor).root === path.resolve(anchor)) return false;
  anchor = path.resolve(anchor); dir = path.resolve(dir);
  if (dir !== anchor && !strictlyBelow(anchor, dir)) return false;
  const st = lstatOrNull(anchor);
  if (st ? !st.isDirectory() || st.isSymbolicLink() : !missingAnchor) return false;
  let p = anchor;
  for (const part of path.relative(anchor, dir).split(path.sep).filter(Boolean)) {
    p = path.join(p, part);
    const c = lstatOrNull(p);
    if (c && (!c.isDirectory() || c.isSymbolicLink())) return false;
  }
  return true;
}

// A candidate leaf may be a link; its parents must resolve strictly under the allowed directory.
export function isInside(parent, child) {
  const realParent = canonicalPath(parent);
  const realChildDir = canonicalPath(path.dirname(child));
  return !!realParent && !!realChildDir && strictlyBelow(realParent, path.join(realChildDir, path.basename(child)));
}

// Removes one entry that must sit strictly inside one of allowedRoots. Fast path: rename into trashDir on the same
// volume, then a detached background delete (survives the hook's own timeout). Read-only trees (Go module cache)
// are made writable first. Never follows symlinks: a symlink entry is removed as a link.
export function removeManaged(p, { anchor, allowedRoots, trashDir, trashAnchor = anchor, dryRun = false, log = () => {}, eventsFile = null, protect = () => false }) {
  try { fs.lstatSync(p); } catch (e) { return { path: p, removed: false, reason: e.code === "ENOENT" ? "absent" : `cannot inspect: ${e.code || e.message}` }; }
  if (protect(p)) return { path: p, removed: false, reason: "active lease or uncertain lease registry" };
  // Callers must supply the whole disposable anchor, not a possibly redirected deps/builds/scratch root.
  if (!anchor || !allowedRoots.some((r) => safeDirectory(anchor, r) && safeDirectory(anchor, path.dirname(p)) && isInside(r, p)))
    return { path: p, removed: false, reason: "outside managed roots" };
  if (!trashDir && !strictlyBelow(path.join(anchor, "trash"), path.resolve(p))) return { path: p, removed: false, reason: "direct deletion restricted to validated trash" };
  if (trashDir && !safeDirectory(trashAnchor, trashDir, { missingAnchor: true })) return { path: p, removed: false, reason: "unsafe trash directory" };
  if (dryRun) return { path: p, removed: false, wouldRemove: true, reason: "dry-run" };
  let target = p;
  if (trashDir) {
    try {
      fs.mkdirSync(trashDir, { recursive: true });
      const dest = path.join(trashDir, `${path.basename(p)}-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
      fs.renameSync(p, dest);
      target = dest;
    } catch (e) {
      if (e.code === "ENOENT") return { path: p, removed: false, reason: "absent" };
      // Never fall back to deleting the original in place: it stays byte-identical and the next run retries.
      log(`rename failed for ${p}: ${e.code}; retaining source`);
      if (eventsFile) appendJsonl(eventsFile, { ts: new Date().toISOString(), event: "delete", status: "skipped-rename-failed", source: p, error: e.code || e.message, retry: "next run" });
      return { path: p, removed: false, reason: `rename failed: ${e.code || e.message}` };
    }
  }
  const id = randomUUID();
  if (eventsFile) appendJsonl(eventsFile, { ts: new Date().toISOString(), event: "delete", id, status: "queued", source: p, path: target });
  spawnDelete([target], { anchor: trashDir ? trashAnchor : anchor, eventsFile, id, source: p });
  return { id, path: p, target, removed: target !== p, queued: true, status: "queued", via: target === p ? "delete" : "trash" };
}

const pendingDeletes = new Map();
let deleteFlushScheduled = false;
export function spawnDelete(paths, { anchor, eventsFile = null, id = randomUUID(), source = null } = {}) {
  if (!paths.length) return;
  if (!anchor) throw new Error("deletion requires a validated anchor");
  const key = JSON.stringify([anchor, eventsFile]);
  if (!pendingDeletes.has(key)) pendingDeletes.set(key, { anchor, eventsFile, jobs: [] });
  pendingDeletes.get(key).jobs.push(...paths.map((p) => ({ id, path: p, source })));
  // One worker per anchor for this invocation, not one Node process per cache entry. The manifest
  // avoids ARG_MAX and survives parent death; hooks explicitly flush before their forced exit.
  if (!deleteFlushScheduled) { deleteFlushScheduled = true; setImmediate(flushDeletes); }
}
export function flushDeletes() {
  deleteFlushScheduled = false;
  const batches = [...pendingDeletes.values()]; pendingDeletes.clear();
  for (const batch of batches) {
    try {
      const trash = path.join(batch.anchor, "trash");
      if (!safeDirectory(batch.anchor, trash)) throw new Error("unsafe deletion queue boundary");
      const queue = path.join(trash, `.cd-delete-${randomUUID()}.json`);
      writeFileAtomic(queue, JSON.stringify(batch));
      const child = spawn(process.execPath, [fileURLToPath(new URL("../bin/cd-delete.mjs", import.meta.url)), queue], { detached: true, stdio: "ignore" });
      child.on("error", (e) => { if (batch.eventsFile) appendJsonl(batch.eventsFile, { ts: new Date().toISOString(), event: "delete-worker", status: "failed", error: e.code, queue }); });
      child.unref();
    } catch (e) { if (batch.eventsFile) appendJsonl(batch.eventsFile, { ts: new Date().toISOString(), event: "delete-worker", status: "failed", error: e.code || e.message }); }
  }
}

// Restores owner rwx on every directory, parent before children and never through links, so a mode-000 subtree
// (test fixtures, read-only module caches) cannot make the delete fail with EACCES/ENOTEMPTY. `chmod -R u+w`
// did not add r/x, which left 0.6.0 trash entries stuck and re-failing on every Stop.
export function makeRemovable(p) {
  const stack = [p];
  while (stack.length) {
    const d = stack.pop(), st = lstatOrNull(d);
    if (!st?.isDirectory()) continue;
    if ((st.mode & 0o700) !== 0o700) { try { fs.chmodSync(d, (st.mode & 0o7777) | 0o700); } catch { /* rm reports it */ } }
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) if (e.isDirectory()) stack.push(path.join(d, e.name));
  }
}

// Synchronous delete used by the detached worker, tests and the CLI. Links are removed as links.
export function deleteNow(p) {
  const st = lstatOrNull(p);
  if (!st) return;
  if (!st.isDirectory()) { fs.rmSync(p, { force: true }); return; }
  makeRemovable(p);
  fs.rmSync(p, { recursive: true, force: true, maxRetries: 2 });
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
    const r = spawnSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid", "kern.boottime"], { encoding: "utf8", timeout: 1000 });
    if (r.status === 0 && !r.error) boot = parseDarwinBoot(r.stdout);
  } else if (process.platform === "linux") {
    try { boot.id = normBootId(fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8")); } catch { /* unknown */ }
    const up = os.uptime(); if (Number.isFinite(up) && up > 0) boot.time = Date.now() - Math.round(up * 1000);
  }
  realBoot = boot;
  return realBoot;
}

// Non-blocking owner-fenced lock. Never steal a lock by age: a paused owner can still resume.
// A crashed owner's lock is reported for explicit recovery rather than granting deletion authority; the only
// automatic takeover is locks.mjs withReclaimableLock, for lifecycle/housekeeping locks whose recorded boot id is not this boot's.
export function withLock(lockPath, fn, { boot = bootIdentity() } = {}) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  let fd;
  try { fd = fs.openSync(lockPath, "wx", 0o600); } catch (e) {
    if (e.code !== "EEXIST") throw e;
    return { locked: true, owner: readJsonOrNull(lockPath), recoveryRequired: true };
  }
  const token = randomUUID();
  const acquired = fs.fstatSync(fd);
  try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, token, acquiredAt: new Date().toISOString(), bootId: normBootId(boot?.id), bootTime: Number.isFinite(boot?.time) ? new Date(boot.time).toISOString() : null })); return { locked: false, result: fn() }; } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    const current = lstatOrNull(lockPath);
    if (current?.ino === acquired.ino && current?.dev === acquired.dev && readJsonOrNull(lockPath)?.token === token) {
      try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
    }
  }
}

export function timeLeft(deadline = Infinity, maxMs = 10000) { return Math.max(0, Math.min(maxMs, deadline - Date.now())); }

// Throttle stamps: due() is true when the named stamp is older than everyMs; touch() records now.
export function stampDue(dir, name, everyMs) {
  const st = lstatOrNull(path.join(dir, name));
  return !st || Date.now() - st.mtimeMs >= everyMs;
}
export function stampTouch(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), new Date().toISOString() + "\n");
}

// Logs rotate at 5 MB and keep 5 generations (.1 newest): about 3 days of events at the 5 Nov 2026 rate of
// 6.5k rows per 28 h. Concurrent rotation may drop one generation early; it never throws or blocks a hook.
export const LOG_ROTATE_BYTES = 5 * 1024 * 1024, LOG_KEEP = 5;
export function rotate(file, maxBytes = LOG_ROTATE_BYTES, keep = LOG_KEEP) {
  const st = lstatOrNull(file);
  if (!st || st.size <= maxBytes) return;
  for (let i = keep - 1; i >= 1; i--) { try { fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`); } catch { /* gap */ } }
  try { fs.renameSync(file, `${file}.1`); } catch { /* another writer rotated */ }
}
export function appendLog(file, line) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    rotate(file);
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch { /* logging never breaks a hook */ }
}

// One JSON object per line, rotated like hook.log. Never throws.
export function appendJsonl(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    rotate(file);
    fs.appendFileSync(file, `${JSON.stringify(obj)}\n`, { mode: 0o600 });
  } catch { /* the event log never breaks a hook */ }
}

// Synchronous sleep for short, bounded retries in hooks (no busy loop).
export function sleepMs(ms) { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
