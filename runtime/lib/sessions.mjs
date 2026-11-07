// clean-development 0.6.2: session pins (registration, never routing: storage follows the drive per shell) and reaping
// of ended sessions. Pin files in ~/dev/machine/state/clean-development/sessions/:
//   <key>.mode   one line, "external" or "internal": the mode when last written (also by env.zsh when no hook ran)
//   <key>.json   metadata written by hooks (harness, session id, cwd, transcript, project, start time, ownedRoots)
//   <key>.ended  SessionEnd marker;  <key>.lost  env.zsh saw the external volume disappear after the session used it
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { deletionsPath, sessionsDir, stateDir } from "./conf.mjs";
import { externalAvailable, layout } from "./storage.mjs";
import { canonicalPath, children, exists, lastUsedMs, lstatOrNull, removeManaged, safeDirectory, timeLeft, writeFileAtomic } from "./fsutil.mjs";
import { projectBuildDirs } from "./project.mjs";
import { protections } from "./leases.mjs";
import { deepLastUsedMs, pidFileJobs, processAlive, UNOBSERVED_DAYS } from "./activity.mjs";
import { withLifecycleLock } from "./locks.mjs";

// Placeholder words and short ids are refused (same rule in env.zsh): `c--to-be-unset` and `x-KEY1` were shared by
// every process that inherited them. Deliberate stable hand-set ids of 12+ characters (x-maintree0001) stay valid.
// A placeholder is a whole "-"/"_"-delimited token, all lower or all upper case, so the shell can match it fork-free.
export const PLACEHOLDER_WORDS = ["unset", "placeholder", "changeme", "dummy", "example", "stub", "undefined", "null", "none", "todo"];
const placeholder = (s) => s.split(/[-_]/).some((t) => PLACEHOLDER_WORDS.includes(t) || PLACEHOLDER_WORDS.includes(t.toLowerCase()) && t === t.toUpperCase());
export function sessionIdProblem(id) {
  if (typeof id !== "string" || !id) return "missing";
  if (id.length < 12) return "shorter than 12 characters";
  if (placeholder(id)) return "placeholder value";
  if (!/^[A-Za-z0-9_-]+$/.test(id.slice(-12))) return "unsupported characters";
  return null;
}
// A pin key already on disk: only its 12-character tail is known.
export function keyProblem(key) {
  const tail = String(key).slice(2);
  return tail.length < 12 ? "shorter than 12 characters" : placeholder(tail) ? "placeholder value" : null;
}
// A pin is rejected when its key is, or when the full session id its metadata records is (a legacy `unset-<12 chars>`
// id derives a clean-looking key): such a key may be shared, so it gets the rejected-key window.
export function pinProblem(key, meta) {
  return keyProblem(key) || (typeof meta?.sessionId === "string" ? sessionIdProblem(meta.sessionId) : null);
}

// Same derivation as env.zsh: harness letter + last 12 characters of the session id.
export function sessionKey(harness, id) {
  return sessionIdProblem(id) ? null : derivedKey(harness, id);
}
// The derivation alone. A legacy pin written for an id 0.6.2 rejects still resolves to its key, so it gets the
// rejected-key window rather than "unresolved ownership", which is permanent.
function derivedKey(harness, id) {
  const h = harness === "claude" ? "c" : harness === "codex" ? "x" : null;
  return h && typeof id === "string" && id ? `${h}-${id.slice(-12)}` : null;
}

const pinFile = (env, key, ext) => path.join(sessionsDir(env), `${key}.${ext}`);
export const lifecycleLock = (env) => path.join(stateDir(env), "lifecycle.lock");
export const projectIdentity = (p) => p ? canonicalPath(p) : null;

export function assertOwner(pin, id) {
  if (pin.meta?.sessionId && pin.meta.sessionId !== id) throw new Error("session key collision; refusing to replace or delete another owner");
}

// Pin records are read only when they are small regular files: a FIFO or link planted in sessions/ must not block a
// hook that holds the lifecycle lock, nor redirect the read.
function readPinText(file) {
  let fd;
  try {
    // O_NOFOLLOW|O_NONBLOCK then fstat: no lstat/read race, a FIFO opens without blocking and is refused.
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > 65536) return null;
    return fs.readFileSync(fd, "utf8");
  } catch { return null; } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } } }
}
const readPinJson = (file) => { const t = readPinText(file); try { return t === null ? null : JSON.parse(t); } catch { return null; } };

export function readPin(env, key) {
  const errors = [];
  let mode = (readPinText(pinFile(env, key, "mode")) ?? "").split("\n")[0].trim() || null;
  if (mode !== "external" && mode !== "internal") mode = null;
  const meta = readPinJson(pinFile(env, key, "json"));
  if (exists(pinFile(env, key, "mode")) && !mode) errors.push("invalid mode pin");
  if (exists(pinFile(env, key, "json")) && (!meta || typeof meta !== "object" || Array.isArray(meta)
    || derivedKey(meta.harness, meta.sessionId) !== key
    || (meta.projectRoot !== undefined && meta.projectRoot !== null && (typeof meta.projectRoot !== "string" || !path.isAbsolute(meta.projectRoot))))) errors.push("invalid ownership metadata");
  if (meta && ((meta.mode !== undefined && !["external", "internal"].includes(meta.mode))
    || (meta.root !== undefined && (typeof meta.root !== "string" || !path.isAbsolute(meta.root)))
    || (meta.ownedRoots !== undefined && (!Array.isArray(meta.ownedRoots) || !meta.ownedRoots.every((r) => typeof r === "string" && path.isAbsolute(r)))))) errors.push("invalid ownership placement");
  if (meta?.stateVersion !== undefined && (meta.stateVersion !== 1 || !["live", "ended"].includes(meta.phase) || typeof meta.generation !== "string")) errors.push("unsupported ownership state");
  const marker = readPinJson(pinFile(env, key, "ended"));
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

// Storage follows the drive, so a session can write to either root during its life: the Stop hook adds the root in use
// now to ownedRoots, which reap uses to keep a pin until every root the session used can be cleaned. Rewrites only on a
// new root. A shell that switched mid-turn is recorded at that turn's Stop; anything missed is an orphan to the reaper.
export function recordRoot(env, key, root) {
  const pin = readPin(env, key);
  if (pin.errors.length || !pin.meta || (pin.meta.ownedRoots || []).includes(root)) return false;
  writeFileAtomic(pinFile(env, key, "json"), JSON.stringify({ ...pin.meta, ownedRoots: [...(pin.meta.ownedRoots || []), root] }, null, 1) + "\n", 0o600, { durable: true });
  return true;
}
// Roots a session may hold scratch or builds on: recorded roots, the root its pin names, and the external cache when a
// shell saw the external volume disappear after the session used it (.lost).
export function sessionRoots(conf, s) {
  const roots = new Set(s.meta?.ownedRoots || []);
  if (s.mode === "external" || s.lost) roots.add(conf.externalCache);
  if (s.mode === "internal") roots.add(conf.internalRoot);
  return roots;
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
  return [...keys].sort().map((key) => { const pin = readPin(env, key); return { key, ...pin, rejected: pinProblem(key, pin.meta) }; });
}

// Our own stamps are not activity (written once at creation; the pin's mtime already records that).
export const ACTIVITY_IGNORE = new Set([".owner.json"]);

// Newest activity of a session: pin files, transcript, its scratch and its builds.
// idleMs from every mark that could be observed; incomplete when a shallow listing could not be completed (more than
// 2000 direct children, unreadable, deadline). Incomplete is weak evidence, not permanent activity.
export function sessionIdleMs(conf, env, s, now = Date.now(), options = {}) { return sessionActivity(conf, env, s, now, options).idleMs; }
export function sessionActivity(conf, env, s, now = Date.now(), { roots, deadline = Infinity } = {}) {
  roots ??= [conf.internalRoot].concat(externalAvailable(conf, env) ? [conf.externalCache] : []);
  const marks = [
    lstatOrNull(pinFile(env, s.key, "mode"))?.mtimeMs || 0,
    lstatOrNull(pinFile(env, s.key, "json"))?.mtimeMs || 0,
    s.meta?.transcriptPath ? lstatOrNull(s.meta.transcriptPath)?.mtimeMs || 0 : 0
  ];
  for (const r of roots) {
    const l = layout(r);
    for (const dir of [l.scratch, l.builds]) marks.push(safeDirectory(r, dir, { missingAnchor: true }) ? lastUsedMs(path.join(dir, s.key), 2000, { deadline, ignore: ACTIVITY_IGNORE }) : Infinity);
  }
  const finite = marks.filter(Number.isFinite);
  return { idleMs: now - Math.max(0, ...finite), incomplete: finite.length < marks.length };
}

// Liveness (0.6.2). Always live: unresolved ownership, recent shallow activity, an explicit lease, or a running job whose
// *.pid file sits in the session's scratch or builds. Weak evidence keeps a session for at most WEAK_EVIDENCE_DAYS of
// shallow idleness: an alive harness process (pid plus start time; a long-lived app can host many threads) and a
// .mode-only stub, which has no ownership metadata at all. An observation that could not complete (tree too large or
// deep, unreadable, deadline, ps unreadable) keeps it for at most UNOBSERVED_DAYS. Deep recency covers
// scratch and builds. Jobs quiet for longer than that must hold a lease. A rejected (placeholder or short) key may be
// shared by several shells, so one user's .ended or quiet day says nothing about the others: it stays until every
// signal has been quiet for WEAK_EVIDENCE_DAYS; 0.6.2 routes nothing new to it. Codex threads are resumable (`codex
// exec resume`): an ended Codex session keeps its scratch until idle for SESSION_STALE_HOURS (F1).
export const WEAK_EVIDENCE_DAYS = 7;
export function sessionLiveness(conf, env, s, { now = Date.now(), roots, deadline = Infinity, protect = null } = {}) {
  const day = 24 * 3600 * 1000, staleMs = conf.SESSION_STALE_HOURS * 3600 * 1000, weakMs = Math.max(staleMs, WEAK_EVIDENCE_DAYS * day);
  const unobservedMs = Math.max(weakMs, UNOBSERVED_DAYS * day);
  roots ??= [conf.internalRoot].concat(externalAvailable(conf, env) ? [conf.externalCache] : []);
  if (s.errors?.length) return { live: true, reason: "unresolved ownership", idleMs: -Infinity };
  if (!timeLeft(deadline)) return { live: true, reason: "unobserved (deadline)", idleMs: -Infinity };
  const rejected = !!s.rejected, ended = s.ended && !rejected, quietMs = rejected ? weakMs : staleMs;
  const { idleMs, incomplete } = sessionActivity(conf, env, s, now, { roots, deadline });
  const stub = !s.meta;
  if (!ended && idleMs <= (stub || rejected ? weakMs : staleMs)) return { live: true, idleMs,
    reason: rejected ? `rejected key (${s.rejected}); 7-day window` : stub && idleMs > staleMs ? "mode-only stub (7-day window)" : "recent activity" };
  if (!ended && incomplete && idleMs <= unobservedMs) return { live: true, reason: "unobserved (directory too large to list)", idleMs };
  const scratch = roots.map((r) => path.join(layout(r).scratch, s.key)).filter((d) => lstatOrNull(d));
  const builds = roots.map((r) => path.join(layout(r).builds, s.key)).filter((d) => lstatOrNull(d));
  if (protect && scratch.concat(builds).some((d) => protect(d))) return { live: true, reason: "explicit lease", idleMs };
  const job = scratchJob(scratch.concat(builds), deadline);
  if (job?.running) return { live: true, reason: job.reason, idleMs };
  const weak = (reason) => idleMs <= weakMs ? { live: true, reason, idleMs } : null;
  const unobserved = (reason) => idleMs <= unobservedMs ? { live: true, reason, idleMs } : null;
  if (job) { const w = unobserved(`unobserved (${job.reason})`); if (w) return w; }
  const harness = s.meta?.harness || (s.key.startsWith("x-") ? "codex" : "claude");
  if (ended) {
    if (harness === "codex" && idleMs <= staleMs) return { live: true, reason: "ended; Codex resume window", idleMs };
    return { live: false, reason: "ended", idleMs };
  }
  if (s.meta?.owner) {
    const alive = processAlive(s.meta.owner, { deadline });
    const w = alive === true ? weak(`harness process ${s.meta.owner.pid}`) : alive === null ? unobserved("unobserved (harness process unknown)") : null;
    if (w) return w;
  }
  // Deep recency over scratch and builds (a detached builder appending to builds/<key>/target/... without a pid file).
  const deep = Math.max(0, ...scratch.concat(builds).map((d) => deepLastUsedMs(d, { deadline, ignore: ACTIVITY_IGNORE })));
  // Infinity means a walk was incomplete: unobserved (capped), never "recent activity".
  if (!Number.isFinite(deep)) return unobserved("unobserved (tree too large, too deep or deadline)") || { live: false, reason: `idle (unobserved past ${UNOBSERVED_DAYS} days)`, idleMs };
  if (now - deep <= quietMs) return { live: true, reason: "deep activity", idleMs };
  return { live: false, reason: "idle", idleMs };
}

// Evidence from *.pid files in these dirs: { running: true, reason } for a verified running job, { running: false,
// reason } when an inspection was incomplete or a job unverifiable, null when every dir was inspected and no job runs.
export function scratchJob(dirs, deadline = Infinity) {
  let incomplete = null;
  for (const d of dirs) {
    const r = pidFileJobs(d, { deadline });
    const j = r.jobs[0], reason = j && `job pid ${j.pid} (${path.relative(d, j.file)})${j.unknown ? ", unverifiable" : ""}`;
    if (j && !j.unknown) return { running: true, reason };
    // ps unreadable: the pid exists but its start time is unknown. Unobserved (capped), never permanent.
    if (j) incomplete ??= { running: false, reason };
    else if (!r.complete) incomplete ??= { running: false, reason: r.reason };
  }
  return incomplete;
}

export function classify(conf, env, now = Date.now(), { deadline = Infinity, protect = null } = {}) {
  const roots = [conf.internalRoot].concat(externalAvailable(conf, env) ? [conf.externalCache] : []);
  protect ??= protections(env).protect;
  return listSessions(env).map((s) => {
    const lv = sessionLiveness(conf, env, s, { now, roots, deadline, protect });
    return { ...s, idleMs: lv.idleMs, liveReason: lv.live ? lv.reason : null, done: !lv.live };
  });
}

// Removes what a finished session leaves (Q30): its scratch on both roots; its internal builds; when it ran internal (or
// lost the external volume) also the declared, git-ignored build dirs of its repo, unless another live session works
// there. External builds are kept for the 14-day prune. While a root the session used is absent the pin stays (with its
// .ended marker) so its scratch there is removed after reconnection.
export function reapSession(conf, env, s, options = {}) {
  const { dryRun = false, log = () => {}, deadline = Infinity, locked = false } = options;
  if (!conf.valid) return { key: s.key, skipped: "invalid storage configuration", removed: [] };
  if (!dryRun && !locked) {
    const r = withLifecycleLock(env, () => reapSession(conf, env, s, { ...options, locked: true }));
    return r.locked ? { key: s.key, skipped: "lifecycle locked", removed: [] } : r.result;
  }
  const current = readPin(env, s.key);
  if (current.errors.length) return { key: s.key, skipped: "invalid ownership state", removed: [] };
  if (!s.revision || s.revision !== current.revision) return { key: s.key, skipped: "ownership changed", removed: [] };
  if (!timeLeft(deadline)) return { key: s.key, deferred: true, skipped: "deadline", removed: [] };
  const protect = options.protect || protections(env).protect;
  const lv = sessionLiveness(conf, env, { key: s.key, ...current, rejected: pinProblem(s.key, current.meta) }, { deadline, protect });
  if (lv.live) return { key: s.key, skipped: `session live (${lv.reason})`, retained: lv.reason, removed: [] };
  const peers = options.liveProjects ? null : classify(conf, env, Date.now(), { deadline, protect }).filter((x) => x.key !== s.key && !x.done);
  const liveProjects = options.liveProjects || new Set(peers.map((p) => projectIdentity(p.meta?.projectRoot)).filter(Boolean));
  const projectCleanupAllowed = options.projectCleanupAllowed ?? peers?.every((p) => p.meta && !p.errors.length) ?? true;
  const mode = s.mode || "internal";
  const ext = externalAvailable(conf, env);
  const li = layout(conf.internalRoot);
  const removed = [];
  const rm = (p, l) => removed.push(removeManaged(p, { anchor: l.root, allowedRoots: [l.scratch, l.builds], trashDir: l.trash, dryRun, log, protect, eventsFile: deletionsPath(env) }));
  rm(path.join(li.scratch, s.key), li);
  rm(path.join(li.builds, s.key), li);
  if (ext) rm(path.join(layout(conf.externalCache).scratch, s.key), layout(conf.externalCache));
  const pr = projectIdentity(s.meta?.projectRoot);
  let projectBlocked = false;
  // Ran internal at any point (recorded roots, pin, or a lost external volume): its repo build output sits on the internal disk.
  const ranInternal = s.lost || current.lost || mode === "internal" || s.meta?.mode === "internal" || sessionRoots(conf, { ...s, ...current }).has(conf.internalRoot);
  if (projectCleanupAllowed && ranInternal && pr && !liveProjects.has(pr)) {
    for (const dir of projectBuildDirs(pr, { deadline, onBlocked: () => { projectBlocked = true; } })) removed.push(removeManaged(dir, { anchor: pr, allowedRoots: [pr], trashDir: li.trash, trashAnchor: li.root, dryRun, log, protect, eventsFile: deletionsPath(env) }));
  }
  const blocked = removed.filter((r) => !r.removed && !r.wouldRemove && r.reason !== "absent");
  // Keep the pin (with its .ended marker) while a root the session used is away, so its scratch there is removed after
  // reconnection.
  const deferred = (!ext && sessionRoots(conf, { ...s, ...current }).has(conf.externalCache)) || blocked.length > 0 || projectBlocked || !timeLeft(deadline);
  if (!dryRun && !deferred) dropPin(env, s.key);
  return { key: s.key, mode, deferred, blocked, projectBlocked, removed: removed.filter((r) => r.removed || r.wouldRemove) };
}

// An unpinned scratch dir can still host a detached job (0.6.0 trashed tmp/m204c-fix2 while it ran). An incomplete
// observation keeps it for at most UNOBSERVED_DAYS.
function orphanIdle(p, staleMs, deadline) {
  // Too many entries to list (or unreadable): unobserved, with the directory's own mtime as the retention clock.
  const listed = lastUsedMs(p, 2000, { ignore: ACTIVITY_IGNORE }), complete = Number.isFinite(listed);
  const shallow = Date.now() - (complete ? listed : lstatOrNull(p)?.mtimeMs ?? Date.now());
  const unobserved = shallow <= UNOBSERVED_DAYS * 24 * 3600 * 1000;
  if (complete ? shallow <= staleMs : unobserved) return false;
  const job = scratchJob([p], deadline);
  if (job?.running || (job && unobserved)) return false;
  const deep = deepLastUsedMs(p, { deadline, ignore: ACTIVITY_IGNORE });
  return Number.isFinite(deep) ? Date.now() - deep > staleMs : !unobserved;
}

export function reapAll(conf, env, options = {}) {
  const { currentKey = null, dryRun = false, log = () => {}, budgetMs = Infinity, locked = false } = options;
  if (!conf.valid) return { reaped: [], live: [], orphans: [], skipped: "invalid storage configuration" };
  if (!dryRun && !locked) {
    const r = withLifecycleLock(env, () => reapAll(conf, env, { ...options, locked: true }));
    return r.locked ? { reaped: [], live: [], orphans: [], skipped: "lifecycle locked" } : r.result;
  }
  const t0 = Date.now();
  const deadline = Math.min(options.deadline ?? Infinity, t0 + budgetMs);
  const protect = options.protect || protections(env).protect;
  const all = classify(conf, env, Date.now(), { deadline, protect });
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
          if (orphanIdle(cp, staleMs, deadline)) orphans.push(removeManaged(cp, { anchor: root, allowedRoots: [l.scratch], trashDir: l.trash, dryRun, log, protect, eventsFile: deletionsPath(env) }));
        }
        continue;
      }
      if (known.has(d.name) || d.name === currentKey) continue;
      // An unpinned scratch dir can still host a detached job (0.6.0 trashed tmp/m204c-fix2 while it ran).
      if (orphanIdle(p, staleMs, deadline))
        orphans.push(removeManaged(p, { anchor: root, allowedRoots: [l.scratch], trashDir: l.trash, dryRun, log, protect, eventsFile: deletionsPath(env) }));
    }
  }
  return { reaped, live, timedOut: !timeLeft(deadline), orphans: orphans.filter((o) => o.removed || o.wouldRemove) };
}
