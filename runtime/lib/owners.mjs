import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { deletionsPath, ownersDir, stateDir } from "./conf.mjs";
import { canonicalPath, children, lstatOrNull, readJsonOrNull, removeManaged, safeDirectory, writeFileAtomic } from "./fsutil.mjs";
import { protections } from "./leases.mjs";
import { classify, readPin, scratchJob } from "./sessions.mjs";
import { externalAvailable, layout } from "./storage.mjs";
import { withLifecycleLock } from "./locks.mjs";

export const OWNER_FILE = ".owner.json";
export const OWNER_CONFLICT_FILE = ".owner-conflict";
const absoluteOrNull = (p) => p === null || (typeof p === "string" && path.isAbsolute(p) && !p.includes("\0"));

export function ownerRecord({ repo = null, cwd = null, harness, key = null, created = new Date().toISOString(), externalUsed = null }) {
  if (!absoluteOrNull(repo) || !absoluteOrNull(cwd)) throw new Error("owner repo and cwd must be absolute paths or null");
  if (!["claude", "codex", "shell"].includes(harness)) throw new Error("invalid owner harness");
  if (key !== null && (typeof key !== "string" || !/^[cx]-[A-Za-z0-9_-]{12}$/.test(key))) throw new Error("invalid owner key");
  if (typeof created !== "string" || !Number.isFinite(Date.parse(created)) || new Date(created).toISOString() !== created) throw new Error("owner created must be an ISO timestamp");
  if (externalUsed !== null && typeof externalUsed !== "boolean") throw new Error("externalUsed must be true, false or null");
  return { schemaVersion: 1, repo, cwd, harness, key, created, ...(externalUsed === null ? {} : { externalUsed }) };
}

export function readOwner(dir) {
  try {
    dir = path.resolve(dir);
    const st = fs.lstatSync(dir), file = path.join(dir, OWNER_FILE);
    if (!st.isDirectory() || st.isSymbolicLink()) return null;
    if (lstatOrNull(path.join(dir, OWNER_CONFLICT_FILE))) return null;
    const f = fs.lstatSync(file);
    if (!f.isFile() || f.isSymbolicLink()) return null;
    const raw = readJsonOrNull(file);
    if (!raw || Array.isArray(raw) || raw.schemaVersion !== 1
      || !["repo", "cwd", "harness", "key", "created"].every((k) => Object.hasOwn(raw, k))) return null;
    return ownerRecord({ ...raw, externalUsed: Object.hasOwn(raw, "externalUsed") ? raw.externalUsed : null });
  } catch { return null; }
}

export function writeOwner(dir, info) {
  let tmp;
  try {
    const record = ownerRecord(info);
    dir = path.resolve(dir);
    const st = lstatOrNull(dir);
    if (st && (!st.isDirectory() || st.isSymbolicLink())) throw new Error("owner directory is not a real directory");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!safeDirectory(dir, dir)) throw new Error("unsafe owner directory");
    const file = path.join(dir, OWNER_FILE);
    const existing = () => {
      const owner = readOwner(dir);
      if (!owner) return { written: false, error: "unreadable or invalid owner file" };
      if (owner.key !== record.key) return { written: false, conflict: true };
      if (owner.repo !== record.repo) return { written: false, conflict: true, projectChanged: true };
      // Once a session has used external storage, preserve that fact so owner-index cleanup can wait for that root.
      // A legacy record with unknown history is not downgraded to internal-only by a later internal resume.
      if (record.externalUsed === true && owner.externalUsed !== true) {
        writeFileAtomic(file, JSON.stringify({ ...owner, externalUsed: true }) + "\n", 0o600, { durable: true });
        return { written: true, updated: true };
      }
      return { written: false };
    };
    if (lstatOrNull(file)) return existing();
    tmp = path.join(dir, `.owner-${randomUUID()}.tmp`);
    writeFileAtomic(tmp, JSON.stringify(record) + "\n", 0o600);
    // link publishes the complete file exclusively; rename would replace a competing owner.
    try { fs.linkSync(tmp, file); } catch (e) { if (e.code === "EEXIST") return existing(); throw e; }
    return { written: true };
  } catch (e) { return { written: false, error: e.code || e.message }; }
  finally { if (tmp) { try { fs.unlinkSync(tmp); } catch { /* absent */ } } }
}

export function hasOwnerConflict(dir) {
  return !!lstatOrNull(path.join(path.resolve(dir), OWNER_CONFLICT_FILE));
}

// A session key can be resumed in a different project while its build directory still contains both projects'
// outputs. Keep the existing owner record intact and add a no-clobber marker so neither project's prune can claim it.
export function markOwnerConflict(dir) {
  try {
    dir = path.resolve(dir);
    const st = lstatOrNull(dir);
    if (!st?.isDirectory() || st.isSymbolicLink() || !safeDirectory(dir, dir))
      return { written: false, error: "unsafe owner directory" };
    const marker = path.join(dir, OWNER_CONFLICT_FILE);
    if (lstatOrNull(marker)) return { written: false, conflict: true };
    fs.writeFileSync(marker, "", { flag: "wx", mode: 0o600 });
    return { written: true };
  } catch (e) {
    return e.code === "EEXIST" ? { written: false, conflict: true } : { written: false, error: e.code || e.message };
  }
}

export function pruneProject(conf, env, repo, { apply = false, now = Date.now(), deadline = Infinity } = {}) {
  if (typeof repo !== "string" || !path.isAbsolute(repo)) throw new Error("project must be an existing absolute directory");
  repo = canonicalPath(repo);
  if (!repo || !lstatOrNull(repo)?.isDirectory()) throw new Error("project must be an existing absolute directory");
  const empty = () => ({ repo, candidates: [], skipped: [], removed: [] });
  if (!conf.valid) return { ...empty(), skipped: [{ path: repo, reason: "invalid storage configuration" }] };
  const state = () => {
    const leases = protections(env);
    const live = new Set(classify(conf, env, now, { deadline }).filter((s) => !s.done).map((s) => s.key));
    return { ...leases, live };
  };
  const inspect = (p, root, current) => {
    if (Date.now() >= deadline) return { reason: "deadline" };
    if (!safeDirectory(root, p)) return { reason: "symlink or unsafe build directory" };
    // Builds dirs are not stamped (0.6.2): ownership comes from an in-dir stamp a tool wrote, the durable index
    // (state/clean-development/owners/<key>), or the pin.s projectRoot. Unknown ownership is skipped, never guessed.
    const key = /^[cx]-[A-Za-z0-9_-]{12}$/.test(path.basename(p)) ? path.basename(p) : null;
    const pin = key ? readPin(env, key) : null;
    const ownerIndex = key ? path.join(ownersDir(env), key) : null;
    if (hasOwnerConflict(p)) return { reason: "ambiguous project ownership" };
    if (ownerIndex && !safeDirectory(stateDir(env), ownerIndex, { missingAnchor: true })) return { reason: "unsafe owner index" };
    if (ownerIndex && hasOwnerConflict(ownerIndex)) return { reason: "ambiguous project ownership" };
    const owner = readOwner(p) || (ownerIndex && readOwner(ownerIndex))
      || (key && pin && !pin.errors.length && pin.meta?.projectRoot && path.isAbsolute(pin.meta.projectRoot)
        ? ownerRecord({ repo: pin.meta.projectRoot, cwd: pin.meta.cwd ?? null, harness: pin.meta.harness, key, created: pin.meta.startedAt || new Date(0).toISOString() }) : null);
    if (!owner) return { reason: "unknown owner" };
    if (!owner.repo || canonicalPath(owner.repo) !== repo) return { other: true };
    if (current.errors.length) return { reason: "uncertain lease registry" };
    if (current.live.has(owner.key) || current.live.has(path.basename(p))) return { reason: "session live" };
    if (current.protect(p)) return { reason: "active lease" };
    const job = scratchJob([p], deadline);
    if (job) return { reason: job.running ? job.reason : `not fully inspected (${job.reason})` };
    return { candidate: { path: p, root, key: owner.key, reason: "project build ownership" }, owner };
  };
  const run = () => {
    const out = empty();
    let current;
    try { current = state(); } catch (e) { out.skipped.push({ path: repo, reason: `cannot inspect session or lease registry: ${e.code || e.message}` }); return out; }
    const roots = [...new Set([conf.internalRoot, ...(externalAvailable(conf, env) ? [conf.externalCache] : [])])];
    for (const root of roots) {
      const l = layout(root);
      if (!safeDirectory(root, l.builds, { missingAnchor: true })) { out.skipped.push({ path: l.builds, reason: "symlink or unsafe builds root" }); continue; }
      let entries;
      try { entries = children(l.builds, 5000, { requireComplete: true }); }
      catch (e) { out.skipped.push({ path: l.builds, reason: `cannot inspect builds: ${e.code || e.message}` }); continue; }
      for (const d of entries) {
        const p = path.join(l.builds, d.name);
        if (d.name === "DerivedData") continue;
        let checked;
        try { checked = inspect(p, root, current); }
        catch (e) { checked = { reason: `cannot inspect ownership: ${e.code || e.message}` }; }
        if (checked.other) continue;
        if (checked.reason) { out.skipped.push({ path: p, reason: checked.reason }); continue; }
        if (!apply) { out.candidates.push(checked.candidate); continue; }
        let fresh;
        try { current = state(); fresh = inspect(p, root, current); }
        catch (e) { fresh = { reason: `cannot re-check ownership: ${e.code || e.message}` }; }
        if (!fresh.candidate || JSON.stringify(fresh.owner) !== JSON.stringify(checked.owner)) {
          out.skipped.push({ path: p, reason: fresh.reason || "ownership changed" }); continue;
        }
        out.candidates.push(fresh.candidate);
        const r = removeManaged(p, { anchor: root, allowedRoots: [l.builds], trashDir: l.trash, protect: current.protect, eventsFile: deletionsPath(env) });
        if (r.removed || r.queued) out.removed.push(r);
        else out.skipped.push({ path: p, reason: r.reason });
      }
    }
    return out;
  };
  if (!apply) return run();
  const locked = withLifecycleLock(env, run);
  return locked.locked ? { ...empty(), skipped: [{ path: repo, reason: "lifecycle locked" }] } : locked.result;
}
