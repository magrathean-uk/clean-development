// clean-development 0.6.0: housekeeping rules (Q30). Only paths inside the managed cache roots, the cargo registry
// caches and git-ignored declared repo directories are ever removed.
import path from "node:path";
import { children, lastUsedMs, lstatOrNull, removeManaged, sizeBytes, deleteNow } from "./fsutil.mjs";
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
  for (const d of children(l.deps)) {
    const p = path.join(l.deps, d.name);
    if (d.name === "huggingface") {
      for (const c of children(p)) {
        const cp = path.join(p, c.name);
        if (c.name === "hub") for (const m of children(cp)) units.push(path.join(cp, m.name));
        else if (!/token/i.test(c.name)) units.push(cp);
      }
    } else if (d.name === "xdg") {
      for (const c of children(p)) units.push(path.join(p, c.name));
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

export function capPrune(root, conf, { cargoHome = null, dryRun = false, log = () => {}, now = Date.now() } = {}) {
  const l = layout(root);
  const cap = conf.DEPS_CAP_GB * GB;
  const minIdle = conf.DEPS_MIN_IDLE_HOURS * HOUR;
  const units = depsUnits(root, { cargoHome }).map((p) => ({ p, used: lastUsedMs(p), size: sizeBytes(p) ?? 0 }));
  let total = units.reduce((a, u) => a + u.size, 0);
  const report = { root, capBytes: cap, totalBytes: total, evicted: [] };
  const allowed = [l.deps].concat(cargoHome ? [path.join(cargoHome, "registry"), path.join(cargoHome, "git")] : []);
  for (const u of units.sort((a, b) => a.used - b.used)) {
    if (total <= cap) break;
    if (now - u.used < minIdle) continue;
    const r = removeManaged(u.p, { allowedRoots: allowed, trashDir: u.p.startsWith(l.deps) ? l.trash : null, dryRun, log });
    if (r.removed || dryRun) { total -= u.size; report.evicted.push({ path: u.p, bytes: u.size, idleHours: Math.round((now - u.used) / HOUR) }); }
  }
  report.afterBytes = total;
  return report;
}

// Children of builds/ idle for longer than maxAgeMs; DerivedData is expanded per project and uses derivedDataMaxAgeMs
// (default: maxAgeMs). Session build dirs of live sessions are skipped.
export function agePruneBuilds(root, maxAgeMs, { liveKeys = new Set(), dryRun = false, log = () => {}, now = Date.now(), skipDerivedData = false, derivedDataMaxAgeMs = maxAgeMs } = {}) {
  const l = layout(root);
  const removed = [];
  for (const d of children(l.builds)) {
    const p = path.join(l.builds, d.name);
    if (d.name === "DerivedData") {
      if (skipDerivedData) continue;
      for (const c of children(p)) {
        const cp = path.join(p, c.name);
        if (now - lastUsedMs(cp) > derivedDataMaxAgeMs) removed.push(removeManaged(cp, { allowedRoots: [l.builds], trashDir: l.trash, dryRun, log }));
      }
      continue;
    }
    if (liveKeys.has(d.name)) continue;
    if (now - lastUsedMs(p) > maxAgeMs) removed.push(removeManaged(p, { allowedRoots: [l.builds], trashDir: l.trash, dryRun, log }));
  }
  return removed.filter((r) => r.removed || dryRun);
}

// Internal mode, last session out: nothing internal is live any more, so every session build dir is removed. Xcode's
// DerivedData is the GUI's cache, not a session's build output (Q30): it is never wiped here and only ages out by
// EXTERNAL_BUILD_DAYS (agePruneBuilds derivedDataMaxAgeMs).
export function wipeInternalBuilds(conf, { dryRun = false, log = () => {} } = {}) {
  const l = layout(conf.internalRoot);
  const removed = [];
  for (const d of children(l.builds)) {
    if (d.name === "DerivedData") continue;
    removed.push(removeManaged(path.join(l.builds, d.name), { allowedRoots: [l.builds], trashDir: l.trash, dryRun, log }));
  }
  return removed.filter((r) => r.removed || dryRun);
}

// Trash entries whose background delete did not finish (killed, crashed) are deleted synchronously after an hour.
export function sweepTrash(root, { dryRun = false, now = Date.now() } = {}) {
  const l = layout(root);
  const swept = [];
  for (const d of children(l.trash)) {
    const p = path.join(l.trash, d.name);
    const st = lstatOrNull(p);
    if (st && now - st.ctimeMs > HOUR) { if (!dryRun) deleteNow(p); swept.push(p); }
  }
  return swept;
}

// Repo-local declared build/dependency dirs (git-ignored) in repositories idle for EXTERNAL_BUILD_DAYS (Q16, Q30).
export function pruneRepos(home, conf, { dryRun = false, log = () => {}, now = Date.now(), liveProjects = new Set() } = {}) {
  const { repos } = sourceRepos(home);
  const removed = [];
  const maxAge = conf.EXTERNAL_BUILD_DAYS * DAY;
  const trash = layout(conf.internalRoot).trash;
  for (const repo of repos) {
    if (liveProjects.has(repo)) continue;
    for (const dir of projectAgedDirs(repo, maxAge, now)) removed.push(removeManaged(dir, { allowedRoots: [repo], trashDir: trash, dryRun, log }));
  }
  return removed.filter((r) => r.removed || dryRun);
}

export { HOUR, DAY };
