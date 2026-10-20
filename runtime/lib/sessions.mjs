// clean-development 0.6.0: session pins (decided once per session) and reaping of ended sessions.
// Pin files in ~/dev/machine/state/clean-development/sessions/:
//   <key>.mode   one line, "external" or "internal" (also written by env.zsh when no hook ran)
//   <key>.json   metadata written by hooks (harness, session id, cwd, transcript, project, start time)
//   <key>.ended  SessionEnd marker;  <key>.lost  env.zsh saw the pinned external volume disappear
import fs from "node:fs";
import path from "node:path";
import { sessionsDir } from "./conf.mjs";
import { externalAvailable, layout } from "./storage.mjs";
import { children, exists, lastUsedMs, lstatOrNull, readJsonOrNull, removeManaged, writeFileAtomic } from "./fsutil.mjs";
import { projectBuildDirs } from "./project.mjs";

// Same derivation as env.zsh: harness letter + last 12 characters of the session id.
export function sessionKey(harness, id) {
  const h = harness === "claude" ? "c" : harness === "codex" ? "x" : null;
  if (!h || typeof id !== "string" || !id) return null;
  const tail = id.length <= 12 ? id : id.slice(-12);
  return /^[A-Za-z0-9_-]+$/.test(tail) ? `${h}-${tail}` : null;
}

const pinFile = (env, key, ext) => path.join(sessionsDir(env), `${key}.${ext}`);

export function readPin(env, key) {
  let mode = null;
  try { mode = fs.readFileSync(pinFile(env, key, "mode"), "utf8").split("\n")[0].trim() || null; } catch { /* none */ }
  if (mode !== "external" && mode !== "internal") mode = null;
  return { mode, meta: readJsonOrNull(pinFile(env, key, "json")), ended: exists(pinFile(env, key, "ended")), lost: exists(pinFile(env, key, "lost")) };
}

export function writePin(env, key, mode, meta) {
  fs.mkdirSync(sessionsDir(env), { recursive: true });
  writeFileAtomic(pinFile(env, key, "mode"), `${mode}\n`);
  if (meta) writeFileAtomic(pinFile(env, key, "json"), JSON.stringify(meta, null, 1) + "\n");
}

export function touchPin(env, key) {
  const f = pinFile(env, key, "json");
  const now = new Date();
  try { fs.utimesSync(f, now, now); } catch { /* no meta yet */ }
}

export function markEnded(env, key) {
  fs.mkdirSync(sessionsDir(env), { recursive: true });
  fs.writeFileSync(pinFile(env, key, "ended"), new Date().toISOString() + "\n");
}

export function dropPin(env, key) {
  for (const ext of ["mode", "json", "ended", "lost"]) { try { fs.unlinkSync(pinFile(env, key, ext)); } catch { /* gone */ } }
}

export function listSessions(env) {
  const keys = new Set();
  for (const d of children(sessionsDir(env))) {
    const m = d.name.match(/^([cx]-[A-Za-z0-9_-]+)\.(mode|json|ended|lost)$/);
    if (m) keys.add(m[1]);
  }
  return [...keys].sort().map((key) => ({ key, ...readPin(env, key) }));
}

// Newest activity of a session: pin files, transcript, its scratch and its builds.
export function sessionIdleMs(conf, env, s, now = Date.now()) {
  const roots = [conf.internalRoot].concat(externalAvailable(conf, env) ? [conf.externalCache] : []);
  const marks = [
    lstatOrNull(pinFile(env, s.key, "mode"))?.mtimeMs || 0,
    lstatOrNull(pinFile(env, s.key, "json"))?.mtimeMs || 0,
    s.meta?.transcriptPath ? lstatOrNull(s.meta.transcriptPath)?.mtimeMs || 0 : 0
  ];
  for (const r of roots) { const l = layout(r); marks.push(lastUsedMs(path.join(l.scratch, s.key)), lastUsedMs(path.join(l.builds, s.key))); }
  return now - Math.max(...marks);
}

export function classify(conf, env, now = Date.now()) {
  const staleMs = conf.SESSION_STALE_HOURS * 3600 * 1000;
  return listSessions(env).map((s) => {
    const idle = sessionIdleMs(conf, env, s, now);
    return { ...s, idleMs: idle, done: s.ended || idle > staleMs };
  });
}

// Removes what a finished session leaves (Q30): its scratch on both roots; its internal builds; in internal mode (or
// after the pinned external volume was lost) also the declared, git-ignored build dirs of its repo, unless another live
// session works there. External builds are kept for the 14-day prune. While the pinned external volume is absent the
// pin stays (with its .ended marker) so the external scratch is removed after reconnection.
export function reapSession(conf, env, s, { dryRun = false, log = () => {}, liveProjects = new Set() } = {}) {
  const mode = s.mode || "internal";
  const ext = externalAvailable(conf, env);
  const li = layout(conf.internalRoot);
  const removed = [];
  const rm = (p, l) => removed.push(removeManaged(p, { allowedRoots: [l.scratch, l.builds], trashDir: l.trash, dryRun, log }));
  rm(path.join(li.scratch, s.key), li);
  rm(path.join(li.builds, s.key), li);
  if (ext) rm(path.join(layout(conf.externalCache).scratch, s.key), layout(conf.externalCache));
  const pr = s.meta?.projectRoot;
  if ((mode === "internal" || s.lost) && pr && !liveProjects.has(pr)) {
    for (const dir of projectBuildDirs(pr)) removed.push(removeManaged(dir, { allowedRoots: [pr], trashDir: li.trash, dryRun, log }));
  }
  const deferred = mode === "external" && !ext;
  if (!dryRun && !deferred) dropPin(env, s.key);
  return { key: s.key, mode, deferred, removed: removed.filter((r) => r.removed || dryRun) };
}

export function reapAll(conf, env, { currentKey = null, dryRun = false, log = () => {}, budgetMs = Infinity } = {}) {
  const t0 = Date.now();
  const all = classify(conf, env);
  const reaped = [];
  const live = [];
  const liveProjects = new Set(all.filter((s) => s.key === currentKey || !s.done).map((s) => s.meta?.projectRoot).filter(Boolean));
  for (const s of all) {
    if (s.key === currentKey || !s.done) { live.push(s); continue; }
    if (Date.now() - t0 > budgetMs) { live.push(s); continue; }
    reaped.push(reapSession(conf, env, s, { dryRun, log, liveProjects }));
  }
  // Orphans: scratch directories without a pin (crashed sessions, pre-0.6.0 leftovers) and old plain-shell scratch.
  const staleMs = conf.SESSION_STALE_HOURS * 3600 * 1000;
  const known = new Set(all.map((s) => s.key));
  const roots = [conf.internalRoot].concat(externalAvailable(conf, env) ? [conf.externalCache] : []);
  const orphans = [];
  for (const root of roots) {
    const l = layout(root);
    for (const d of children(l.scratch)) {
      const p = path.join(l.scratch, d.name);
      if (d.name === "shell") {
        for (const c of children(p)) {
          const cp = path.join(p, c.name);
          if (Date.now() - lastUsedMs(cp) > staleMs) orphans.push(removeManaged(cp, { allowedRoots: [l.scratch], trashDir: l.trash, dryRun, log }));
        }
        continue;
      }
      if (known.has(d.name) || d.name === currentKey) continue;
      if (Date.now() - lastUsedMs(p) > staleMs) orphans.push(removeManaged(p, { allowedRoots: [l.scratch], trashDir: l.trash, dryRun, log }));
    }
  }
  return { reaped, live, orphans: orphans.filter((o) => o.removed || dryRun) };
}
