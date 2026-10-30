// clean-development 0.6.0: session pins (decided once per session) and reaping of ended sessions.
// Pin files in ~/dev/machine/state/clean-development/sessions/:
//   <key>.mode   one line, "external" or "internal" (also written by env.zsh when no hook ran)
//   <key>.json   metadata written by hooks (harness, session id, cwd, transcript, project, start time)
//   <key>.ended  SessionEnd marker;  <key>.lost  env.zsh saw the pinned external volume disappear
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { deletionsPath, sessionsDir, stateDir } from "./conf.mjs";
import { externalAvailable, layout } from "./storage.mjs";
import { canonicalPath, children, exists, lastUsedMs, lstatOrNull, readJsonOrNull, removeManaged, safeDirectory, timeLeft, withLock, writeFileAtomic } from "./fsutil.mjs";
import { projectBuildDirs } from "./project.mjs";
import { protections } from "./leases.mjs";

// Same derivation as env.zsh: harness letter + last 12 characters of the session id.
export function sessionKey(harness, id) {
  const h = harness === "claude" ? "c" : harness === "codex" ? "x" : null;
  if (!h || typeof id !== "string" || !id) return null;
  const tail = id.length <= 12 ? id : id.slice(-12);
  return /^[A-Za-z0-9_-]+$/.test(tail) ? `${h}-${tail}` : null;
}

const pinFile = (env, key, ext) => path.join(sessionsDir(env), `${key}.${ext}`);
export const lifecycleLock = (env) => path.join(stateDir(env), "lifecycle.lock");
export const projectIdentity = (p) => p ? canonicalPath(p) : null;

export function assertOwner(pin, id) {
  if (pin.meta?.sessionId && pin.meta.sessionId !== id) throw new Error("session key collision; refusing to replace or delete another owner");
}

export function readPin(env, key) {
  const errors = [];
  let mode = null;
  try { mode = fs.readFileSync(pinFile(env, key, "mode"), "utf8").split("\n")[0].trim() || null; } catch { /* none */ }
  if (mode !== "external" && mode !== "internal") mode = null;
  const meta = readJsonOrNull(pinFile(env, key, "json"));
  if (exists(pinFile(env, key, "mode")) && !mode) errors.push("invalid mode pin");
  if (exists(pinFile(env, key, "json")) && (!meta || typeof meta !== "object" || Array.isArray(meta)
    || sessionKey(meta.harness, meta.sessionId) !== key
    || (meta.projectRoot !== undefined && meta.projectRoot !== null && (typeof meta.projectRoot !== "string" || !path.isAbsolute(meta.projectRoot))))) errors.push("invalid ownership metadata");
  if (meta && ((meta.mode !== undefined && !["external", "internal"].includes(meta.mode))
    || (meta.root !== undefined && (typeof meta.root !== "string" || !path.isAbsolute(meta.root)))
    || (meta.ownedRoots !== undefined && (!Array.isArray(meta.ownedRoots) || !meta.ownedRoots.every((r) => typeof r === "string" && path.isAbsolute(r)))))) errors.push("invalid ownership placement");
  if (meta?.stateVersion !== undefined && (meta.stateVersion !== 1 || !["live", "ended"].includes(meta.phase) || typeof meta.generation !== "string")) errors.push("unsupported ownership state");
  const marker = readJsonOrNull(pinFile(env, key, "ended"));
  // New records are authoritative; legacy .ended files remain readable until the next supported start.
  const ended = meta?.stateVersion === 1 ? meta.phase === "ended"
    : exists(pinFile(env, key, "ended")) && (!marker?.generation || marker.generation === meta?.generation);
  const revision = ["mode", "json", "ended", "lost"].map((ext) => {
    const st = lstatOrNull(pinFile(env, key, ext));
    return st ? `${st.dev}:${st.ino}:${st.mtimeMs}:${st.ctimeMs}:${st.size}` : "-";
  }).join("|");
  return { mode, meta, ended, lost: exists(pinFile(env, key, "lost")), revision, errors };
}

export function writePin(env, key, mode, meta, { reopen = false } = {}) {
  const previous = readPin(env, key);
  if (previous.errors.length) throw new Error(`invalid ownership state; preserve and inspect ${key}: ${previous.errors.join("; ")}`);
  if (meta) assertOwner(previous, meta.sessionId);
  fs.mkdirSync(sessionsDir(env), { recursive: true });
  writeFileAtomic(pinFile(env, key, "mode"), `${mode}\n`);
  if (meta) writeFileAtomic(pinFile(env, key, "json"), JSON.stringify({
    ...meta, stateVersion: 1, phase: "live", generation: reopen || !previous.meta?.generation ? randomUUID() : previous.meta.generation
  }, null, 1) + "\n", 0o600, { durable: true });
  if (reopen) for (const ext of ["ended", "lost"]) {
    try { fs.unlinkSync(pinFile(env, key, ext)); } catch (e) { if (e.code !== "ENOENT") throw e; }
  }
}

export function touchPin(env, key) {
  const f = pinFile(env, key, "json");
  const now = new Date();
  try { fs.utimesSync(f, now, now); } catch { /* no meta yet */ }
}

export function markEnded(env, key, { generation } = {}) {
  const pin = readPin(env, key);
  if (pin.errors.length) return false;
  if (generation && pin.meta?.generation !== generation) return false;
  fs.mkdirSync(sessionsDir(env), { recursive: true });
  if (pin.meta?.stateVersion === 1) writeFileAtomic(pinFile(env, key, "json"), JSON.stringify({ ...pin.meta, phase: "ended", endedAt: new Date().toISOString() }) + "\n", 0o600, { durable: true });
  writeFileAtomic(pinFile(env, key, "ended"), JSON.stringify({ generation: pin.meta?.generation || null, endedAt: new Date().toISOString() }) + "\n", 0o600, { durable: true });
  return true;
}

export function dropPin(env, key) {
  for (const ext of ["mode", "json", "ended", "lost"]) { try { fs.unlinkSync(pinFile(env, key, ext)); } catch { /* gone */ } }
}

export function listSessions(env) {
  const keys = new Set();
  let entries;
  try { entries = fs.readdirSync(sessionsDir(env), { withFileTypes: true }); } catch (e) { if (e.code === "ENOENT") return []; throw e; }
  if (entries.length > 20000) throw new Error("session inventory exceeds safe inspection limit; cleanup skipped");
  for (const d of entries) {
    const m = d.name.match(/^([cx]-[A-Za-z0-9_-]+)\.(mode|json|ended|lost)$/);
    if (m) keys.add(m[1]);
  }
  return [...keys].sort().map((key) => ({ key, ...readPin(env, key) }));
}

// Newest activity of a session: pin files, transcript, its scratch and its builds.
export function sessionIdleMs(conf, env, s, now = Date.now(), { roots, deadline = Infinity } = {}) {
  roots ??= [conf.internalRoot].concat(externalAvailable(conf, env) ? [conf.externalCache] : []);
  const marks = [
    lstatOrNull(pinFile(env, s.key, "mode"))?.mtimeMs || 0,
    lstatOrNull(pinFile(env, s.key, "json"))?.mtimeMs || 0,
    s.meta?.transcriptPath ? lstatOrNull(s.meta.transcriptPath)?.mtimeMs || 0 : 0
  ];
  for (const r of roots) {
    const l = layout(r);
    for (const dir of [l.scratch, l.builds]) marks.push(safeDirectory(r, dir, { missingAnchor: true }) ? lastUsedMs(path.join(dir, s.key), 2000, { deadline }) : Infinity);
  }
  return now - Math.max(...marks);
}

export function classify(conf, env, now = Date.now(), { deadline = Infinity } = {}) {
  const staleMs = conf.SESSION_STALE_HOURS * 3600 * 1000;
  const roots = [conf.internalRoot].concat(externalAvailable(conf, env) ? [conf.externalCache] : []);
  return listSessions(env).map((s) => {
    const observed = timeLeft(deadline) > 0;
    const idle = observed ? sessionIdleMs(conf, env, s, now, { roots, deadline }) : -Infinity;
    return { ...s, idleMs: idle, done: observed && s.errors.length === 0 && (s.ended || idle > staleMs) };
  });
}

// Removes what a finished session leaves (Q30): its scratch on both roots; its internal builds; in internal mode (or
// after the pinned external volume was lost) also the declared, git-ignored build dirs of its repo, unless another live
// session works there. External builds are kept for the 14-day prune. While the pinned external volume is absent the
// pin stays (with its .ended marker) so the external scratch is removed after reconnection.
export function reapSession(conf, env, s, options = {}) {
  const { dryRun = false, log = () => {}, deadline = Infinity, locked = false } = options;
  if (!conf.valid) return { key: s.key, skipped: "invalid storage configuration", removed: [] };
  if (!dryRun && !locked) {
    const r = withLock(lifecycleLock(env), () => reapSession(conf, env, s, { ...options, locked: true }));
    return r.locked ? { key: s.key, skipped: "lifecycle locked", removed: [] } : r.result;
  }
  const current = readPin(env, s.key);
  if (current.errors.length) return { key: s.key, skipped: "invalid ownership state", removed: [] };
  if (!s.revision || s.revision !== current.revision) return { key: s.key, skipped: "ownership changed", removed: [] };
  if (!timeLeft(deadline)) return { key: s.key, deferred: true, skipped: "deadline", removed: [] };
  if (!current.ended && sessionIdleMs(conf, env, { key: s.key, ...current }, Date.now(), { deadline }) <= conf.SESSION_STALE_HOURS * 3600000)
    return { key: s.key, skipped: "session live", removed: [] };
  const peers = options.liveProjects ? null : classify(conf, env, Date.now(), { deadline }).filter((x) => x.key !== s.key && !x.done);
  const liveProjects = options.liveProjects || new Set(peers.map((p) => projectIdentity(p.meta?.projectRoot)).filter(Boolean));
  const projectCleanupAllowed = options.projectCleanupAllowed ?? peers?.every((p) => p.meta && !p.errors.length) ?? true;
  const mode = s.mode || "internal";
  const protect = options.protect || protections(env).protect;
  const ext = externalAvailable(conf, env);
  const li = layout(conf.internalRoot);
  const removed = [];
  const rm = (p, l) => removed.push(removeManaged(p, { anchor: l.root, allowedRoots: [l.scratch, l.builds], trashDir: l.trash, dryRun, log, protect, eventsFile: deletionsPath(env) }));
  rm(path.join(li.scratch, s.key), li);
  rm(path.join(li.builds, s.key), li);
  if (ext) rm(path.join(layout(conf.externalCache).scratch, s.key), layout(conf.externalCache));
  const pr = projectIdentity(s.meta?.projectRoot);
  let projectBlocked = false;
  if (projectCleanupAllowed && (mode === "internal" || s.lost || s.meta?.mode === "internal") && pr && !liveProjects.has(pr)) {
    for (const dir of projectBuildDirs(pr, { deadline, onBlocked: () => { projectBlocked = true; } })) removed.push(removeManaged(dir, { anchor: pr, allowedRoots: [pr], trashDir: li.trash, trashAnchor: li.root, dryRun, log, protect, eventsFile: deletionsPath(env) }));
  }
  const blocked = removed.filter((r) => !r.removed && !r.wouldRemove && r.reason !== "absent");
  const deferred = (mode === "external" && !ext) || blocked.length > 0 || projectBlocked || !timeLeft(deadline);
  if (!dryRun && !deferred) dropPin(env, s.key);
  return { key: s.key, mode, deferred, blocked, projectBlocked, removed: removed.filter((r) => r.removed || r.wouldRemove) };
}

export function reapAll(conf, env, options = {}) {
  const { currentKey = null, dryRun = false, log = () => {}, budgetMs = Infinity, locked = false } = options;
  if (!conf.valid) return { reaped: [], live: [], orphans: [], skipped: "invalid storage configuration" };
  if (!dryRun && !locked) {
    const r = withLock(lifecycleLock(env), () => reapAll(conf, env, { ...options, locked: true }));
    return r.locked ? { reaped: [], live: [], orphans: [], skipped: "lifecycle locked" } : r.result;
  }
  const t0 = Date.now();
  const deadline = Math.min(options.deadline ?? Infinity, t0 + budgetMs);
  const protect = options.protect || protections(env).protect;
  const all = classify(conf, env, Date.now(), { deadline });
  const reaped = [];
  const live = [];
  const liveProjects = new Set(all.filter((s) => s.key === currentKey || !s.done).map((s) => projectIdentity(s.meta?.projectRoot)).filter(Boolean));
  const projectCleanupAllowed = all.filter((s) => s.key === currentKey || !s.done).every((s) => s.meta && !s.errors.length);
  for (const s of all) {
    if (s.key === currentKey || !s.done) { live.push(s); continue; }
    if (!timeLeft(deadline)) { live.push(s); continue; }
    reaped.push(reapSession(conf, env, s, { dryRun, log, liveProjects, projectCleanupAllowed, deadline, protect, locked: true }));
  }
  // Orphans: scratch directories without a pin (crashed sessions, pre-0.6.0 leftovers) and old plain-shell scratch.
  const staleMs = conf.SESSION_STALE_HOURS * 3600 * 1000;
  const known = new Set(all.map((s) => s.key));
  const roots = [conf.internalRoot].concat(externalAvailable(conf, env) ? [conf.externalCache] : []);
  const orphans = [];
  for (const root of roots) {
    const l = layout(root);
    if (!safeDirectory(root, l.scratch, { missingAnchor: true })) continue;
    for (const d of children(l.scratch)) {
      if (!timeLeft(deadline)) break;
      const p = path.join(l.scratch, d.name);
      if (d.name === "shell") {
        for (const c of children(p)) {
          const cp = path.join(p, c.name);
          if (!timeLeft(deadline)) break;
          if (Date.now() - lastUsedMs(cp) > staleMs) orphans.push(removeManaged(cp, { anchor: root, allowedRoots: [l.scratch], trashDir: l.trash, dryRun, log, protect, eventsFile: deletionsPath(env) }));
        }
        continue;
      }
      if (known.has(d.name) || d.name === currentKey) continue;
      if (Date.now() - lastUsedMs(p) > staleMs) orphans.push(removeManaged(p, { anchor: root, allowedRoots: [l.scratch], trashDir: l.trash, dryRun, log, protect, eventsFile: deletionsPath(env) }));
    }
  }
  return { reaped, live, timedOut: !timeLeft(deadline), orphans: orphans.filter((o) => o.removed || o.wouldRemove) };
}
