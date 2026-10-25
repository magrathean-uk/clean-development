// clean-development 0.6.0: housekeeping rules (Q30). Only paths inside the managed cache roots, the cargo registry
// caches and git-ignored declared repo directories are ever removed.
import path from "node:path";
import { canonicalPath, children, lastUsedMs, lstatOrNull, removeManaged, safeDirectory, sizeBytes, timeLeft } from "./fsutil.mjs";
import { GB, layout } from "./storage.mjs";
import { projectAgedDirs, sourceRepos } from "./project.mjs";

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// Units of the shared dependency caches for one root. Hugging Face is split per model/dataset so one large pull does not
// evict everything; its token files are never units. The cargo registry (CARGO_HOME is an internal toolchain home)
// counts toward the internal root's cap.
export function depsUnits(root, { cargoHome = null } = {}) {
  const l = layout(root);
  const units = [];
  const entries = (p) => children(p, 5000, { requireComplete: true });
  for (const d of entries(l.deps)) {
    const p = path.join(l.deps, d.name);
    if (d.name === "huggingface") {
      for (const c of entries(p)) {
        const cp = path.join(p, c.name);
        if (c.name === "hub") for (const m of entries(cp)) units.push(path.join(cp, m.name));
        else if (!/token/i.test(c.name)) units.push(cp);
      }
    } else if (d.name === "xdg") {
      for (const c of entries(p)) units.push(path.join(p, c.name));
    } else units.push(p);
  }
  if (cargoHome) {
    for (const sub of ["registry/cache", "registry/src", "git/checkouts", "git/db"]) {
      const p = path.join(cargoHome, sub);
      if (lstatOrNull(p)) units.push(p);
    }
  }
  return units;
}

export function capPrune(root, conf, { cargoHome = null, dryRun = false, log = () => {}, now = Date.now(), eventsFile = null, protect = () => false, deadline = Infinity } = {}) {
  const l = layout(root);
  const cap = conf.DEPS_CAP_GB * GB;
  const minIdle = conf.DEPS_MIN_IDLE_HOURS * HOUR;
  const empty = { root, capBytes: cap, totalBytes: null, afterBytes: null, unknownSizes: [], evicted: [], blocked: [] };
  if (!safeDirectory(root, l.deps, { missingAnchor: true }) || (cargoHome && lstatOrNull(cargoHome) && !safeDirectory(cargoHome, cargoHome))) return { ...empty, skipped: "unsafe dependency layout" };
  let paths;
  try { paths = depsUnits(root, { cargoHome }); } catch (e) { return { ...empty, skipped: `incomplete dependency inventory: ${e.message}` }; }
  const units = [];
  for (const p of paths) {
    if (!timeLeft(deadline)) break;
    units.push({ p, used: lastUsedMs(p, 2000, { deadline }), size: sizeBytes(p, Math.max(1, timeLeft(deadline, 1000))) });
  }
  let total = units.reduce((a, u) => a + (u.size ?? 0), 0);
  const report = { root, capBytes: cap, totalBytes: total, unknownSizes: units.filter((u) => u.size === null).map((u) => u.p), evicted: [], blocked: [] };
  if (units.length < paths.length || report.unknownSizes.length || !timeLeft(deadline)) return { ...report, skipped: "incomplete cache measurement", afterBytes: total };
  const allowed = [l.deps].concat(cargoHome ? [path.join(cargoHome, "registry"), path.join(cargoHome, "git")] : []);
  for (const u of units.sort((a, b) => a.used - b.used)) {
    if (!timeLeft(deadline)) break;
    if (total <= cap) break;
    if (now - u.used < minIdle || u.size === null) continue;
    const r = removeManaged(u.p, { anchor: u.p.startsWith(l.deps + path.sep) ? root : cargoHome,
      allowedRoots: allowed, trashDir: l.trash, trashAnchor: root, dryRun, log, eventsFile, protect });
    if (r.removed || r.wouldRemove) { total -= u.size; report.evicted.push({ path: u.p, bytes: u.size, idleHours: Math.round((now - u.used) / HOUR) }); }
    else report.blocked.push(r);
  }
  report.afterBytes = total;
  return report;
}

// Children of builds/ idle for longer than maxAgeMs; DerivedData is expanded per project and uses derivedDataMaxAgeMs
// (default: maxAgeMs). Session build dirs of live sessions are skipped.
export function agePruneBuilds(root, maxAgeMs, { liveKeys = new Set(), dryRun = false, log = () => {}, now = Date.now(), skipDerivedData = false, derivedDataMaxAgeMs = maxAgeMs, eventsFile = null, protect = () => false, deadline = Infinity } = {}) {
  const l = layout(root);
  const removed = [];
  if (!safeDirectory(root, l.builds, { missingAnchor: true })) return [{ path: l.builds, removed: false, reason: "unsafe managed layout" }];
  for (const d of children(l.builds)) {
    if (!timeLeft(deadline)) break;
    const p = path.join(l.builds, d.name);
    if (d.name === "DerivedData") {
      if (skipDerivedData) continue;
      for (const c of children(p)) {
        if (!timeLeft(deadline)) break;
        const cp = path.join(p, c.name);
        if (now - lastUsedMs(cp, 2000, { deadline }) > derivedDataMaxAgeMs) removed.push(removeManaged(cp, { anchor: root, allowedRoots: [l.builds], trashDir: l.trash, dryRun, log, eventsFile, protect }));
      }
      continue;
    }
    if (liveKeys.has(d.name)) continue;
    if (now - lastUsedMs(p, 2000, { deadline }) > maxAgeMs) removed.push(removeManaged(p, { anchor: root, allowedRoots: [l.builds], trashDir: l.trash, dryRun, log, eventsFile, protect }));
  }
  return removed;
}

// Internal mode, last session out: nothing internal is live any more, so every session build dir is removed. Xcode's
// DerivedData is the GUI's cache, not a session's build output (Q30): it is never wiped here and only ages out by
// EXTERNAL_BUILD_DAYS (agePruneBuilds derivedDataMaxAgeMs).
export function wipeInternalBuilds(conf, { liveKeys = new Set(), dryRun = false, log = () => {}, eventsFile = null, protect = () => false, deadline = Infinity } = {}) {
  const l = layout(conf.internalRoot);
  const removed = [];
  if (!safeDirectory(l.root, l.builds, { missingAnchor: true })) return [{ path: l.builds, removed: false, reason: "unsafe managed layout" }];
  for (const d of children(l.builds)) {
    if (!timeLeft(deadline)) break;
    if (d.name === "DerivedData" || liveKeys.has(d.name)) continue;
    removed.push(removeManaged(path.join(l.builds, d.name), { anchor: l.root, allowedRoots: [l.builds], trashDir: l.trash, dryRun, log, eventsFile, protect }));
  }
  return removed;
}

// Trash entries whose background delete did not finish are queued for bounded-worker retry after an hour.
export function sweepTrash(root, { dryRun = false, now = Date.now(), eventsFile = null, protect = () => false, deadline = Infinity } = {}) {
  const l = layout(root);
  if (!safeDirectory(root, l.trash)) return [];
  const swept = [];
  for (const d of children(l.trash)) {
    if (!timeLeft(deadline)) break;
    const p = path.join(l.trash, d.name);
    const st = lstatOrNull(p);
    if (st && now - st.ctimeMs > HOUR) {
      const r = removeManaged(p, { anchor: root, allowedRoots: [l.trash], dryRun, eventsFile, protect });
      if (r.queued || r.wouldRemove) swept.push(p);
    }
  }
  return swept;
}

// Repo-local declared build/dependency dirs (git-ignored) in repositories idle for EXTERNAL_BUILD_DAYS (Q16, Q30).
export function pruneRepos(home, conf, { dryRun = false, log = () => {}, now = Date.now(), liveProjects = new Set(), eventsFile = null, protect = () => false, deadline = Infinity, onBlocked = () => {} } = {}) {
  const { repos } = sourceRepos(home);
  const removed = [];
  const maxAge = conf.EXTERNAL_BUILD_DAYS * DAY;
  const trash = layout(conf.internalRoot).trash;
  for (const repo of repos) {
    if (!timeLeft(deadline)) { onBlocked({ project: repo, reason: "deadline" }); break; }
    if (liveProjects.has(canonicalPath(repo))) continue;
    for (const dir of projectAgedDirs(repo, maxAge, now, { deadline, onBlocked: (reason, rel) => onBlocked({ project: repo, path: path.join(repo, rel), reason }) })) {
      if (!timeLeft(deadline)) { onBlocked({ project: repo, reason: "deadline" }); break; }
      const result = removeManaged(dir, { anchor: repo, allowedRoots: [repo], trashDir: trash, trashAnchor: conf.internalRoot, dryRun, log, eventsFile, protect });
      removed.push(result);
      if (!result.removed && !result.wouldRemove && result.reason !== "absent") onBlocked({ project: repo, path: dir, reason: result.reason });
    }
  }
  return removed;
}

export { HOUR, DAY };
