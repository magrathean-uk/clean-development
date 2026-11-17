// Filesystem helpers used by project detection, storage and installation.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function lstatOrNull(p) { try { return fs.lstatSync(p); } catch { return null; } }
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

// Logs rotate at 5 MB and keep 5 generations (.1 newest). Concurrent rotation may drop one generation early;
// it never throws or blocks a hook.
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

// Synchronous sleep for short, bounded retries in hooks (no busy loop).
export function sleepMs(ms) { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
