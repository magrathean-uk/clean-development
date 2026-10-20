// clean-development 0.6.0: bounded filesystem helpers and the only deletion path.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

export function lstatOrNull(p) { try { return fs.lstatSync(p); } catch { return null; } }
export function exists(p) { return lstatOrNull(p) !== null; }
export function readJsonOrNull(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }

export function writeFileAtomic(p, data, mode = 0o600) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, p);
}

export function children(dir, limit = 5000) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).slice(0, limit); } catch { return []; }
}

// Last use = newest mtime of the entry and its direct children (bounded). Symlinks are not followed.
export function lastUsedMs(p, limit = 2000) {
  const st = lstatOrNull(p);
  if (!st) return 0;
  let newest = st.mtimeMs;
  if (st.isDirectory()) {
    for (const d of children(p, limit)) {
      const c = lstatOrNull(path.join(p, d.name));
      if (c && c.mtimeMs > newest) newest = c.mtimeMs;
    }
  }
  return newest;
}

// Allocated size via du -sk (BSD), bounded by a timeout. Returns null when unknown.
export function sizeBytes(p, timeoutMs = 120000) {
  const r = spawnSync("/usr/bin/du", ["-sk", p], { encoding: "utf8", timeout: timeoutMs });
  if (r.status !== 0 && !r.stdout) return null;
  const kb = Number(String(r.stdout).trim().split(/\s+/)[0]);
  return Number.isFinite(kb) ? kb * 1024 : null;
}

// True when child is strictly inside parent (lexically, after resolving the parent's real path).
export function isInside(parent, child) {
  let realParent = parent;
  try { realParent = fs.realpathSync(parent); } catch { /* keep lexical */ }
  let realChildDir = path.dirname(child);
  try { realChildDir = fs.realpathSync(realChildDir); } catch { /* keep lexical */ }
  const c = path.join(realChildDir, path.basename(child));
  const rel = path.relative(realParent, c);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// Removes one entry that must sit strictly inside one of allowedRoots. Fast path: rename into trashDir on the same
// volume, then a detached background delete (survives the hook's own timeout). Read-only trees (Go module cache)
// are made writable first. Never follows symlinks: a symlink entry is removed as a link.
export function removeManaged(p, { allowedRoots, trashDir, dryRun = false, log = () => {} }) {
  const st = lstatOrNull(p);
  if (!st) return { path: p, removed: false, reason: "absent" };
  if (!allowedRoots.some((r) => isInside(r, p))) return { path: p, removed: false, reason: "outside managed roots" };
  if (dryRun) return { path: p, removed: false, reason: "dry-run" };
  let target = p;
  if (trashDir) {
    try {
      fs.mkdirSync(trashDir, { recursive: true });
      const dest = path.join(trashDir, `${path.basename(p)}-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
      fs.renameSync(p, dest);
      target = dest;
    } catch (e) {
      if (e.code !== "EXDEV" && e.code !== "ENOENT") log(`rename failed for ${p}: ${e.code}`);
      if (e.code === "ENOENT") return { path: p, removed: false, reason: "absent" };
    }
  }
  spawnDelete([target]);
  return { path: p, removed: true, via: target === p ? "delete" : "trash" };
}

export function spawnDelete(paths) {
  if (!paths.length) return;
  const child = spawn("/bin/sh", ["-c", 'for p do /bin/chmod -R -P u+w "$p" 2>/dev/null; /bin/rm -rf "$p"; done', "cd-delete", ...paths],
    { detached: true, stdio: "ignore" });
  child.unref();
}

// Synchronous delete for tests and the CLI (--wait).
export function deleteNow(p) {
  spawnSync("/bin/chmod", ["-R", "-P", "u+w", p], { stdio: "ignore" });
  fs.rmSync(p, { recursive: true, force: true });
}

// Single housekeeping lock across sessions. Stale after 15 minutes.
export function withLock(lockPath, fn) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  let fd;
  try { fd = fs.openSync(lockPath, "wx"); } catch (e) {
    if (e.code !== "EEXIST") throw e;
    const st = lstatOrNull(lockPath);
    if (st && Date.now() - st.mtimeMs < 15 * 60 * 1000) return { locked: true };
    try { fs.unlinkSync(lockPath); fd = fs.openSync(lockPath, "wx"); } catch { return { locked: true }; }
  }
  try { fs.writeSync(fd, String(process.pid)); return { locked: false, result: fn() }; } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
  }
}

// Throttle stamps: due() is true when the named stamp is older than everyMs; touch() records now.
export function stampDue(dir, name, everyMs) {
  const st = lstatOrNull(path.join(dir, name));
  return !st || Date.now() - st.mtimeMs >= everyMs;
}
export function stampTouch(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), new Date().toISOString() + "\n");
}

export function appendLog(file, line) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const st = lstatOrNull(file);
    if (st && st.size > 512 * 1024) fs.renameSync(file, `${file}.1`);
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch { /* logging never breaks a hook */ }
}

// One JSON object per line, rotated at 512 KB like hook.log (keeps one .1 file). Never throws.
export function appendJsonl(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const st = lstatOrNull(file);
    if (st && st.size > 512 * 1024) fs.renameSync(file, `${file}.1`);
    fs.appendFileSync(file, `${JSON.stringify(obj)}\n`, { mode: 0o600 });
  } catch { /* the event log never breaks a hook */ }
}
