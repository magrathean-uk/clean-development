// clean-development 0.6.2: hook handlers shared by Claude Code and Codex.
//   session-start  decide the mode once (strict probe), pin it, prepare scratch, reap finished sessions (time-boxed),
//                  report mode, roots, the 5 GB rule and unexpected dot-folders as additional context.
//   stop           per turn (synchronous): heartbeat, then throttled housekeeping under a cross-session lock.
//   session-end    mark ended and remove this session's scratch (and, internal mode, its builds) at once; a Codex
//                  thread keeps its scratch for its resume window, and running *.pid jobs keep theirs.
// Hooks never fail a session: errors are logged to ~/dev/machine/state/clean-development/hook.log and exit 0.
import fs from "node:fs";
import path from "node:path";
import { VERSION, deletionsPath, homeDir, loadConf, logPath, ownersDir, stampsDir, stateDir } from "./conf.mjs";
import { detect, ensureLayout, externalAvailable, fmtGB, freeBytes, GB, internalFreeBytes, layout, rootFor, workRoot } from "./storage.mjs";
import { appendLog, children, lstatOrNull, safeDirectory, stampDue, stampTouch, timeLeft } from "./fsutil.mjs";
import { withLifecycleLock } from "./locks.mjs";
import { assertOwner, classify, markEnded, projectIdentity, readPin, reapAll, reapSession, recordRoot, sessionIdProblem, sessionKey, touchPin, writePin } from "./sessions.mjs";
import { harnessProcess } from "./activity.mjs";
import { OWNER_CONFLICT_FILE, OWNER_FILE, hasOwnerConflict, markOwnerConflict, readOwner, writeOwner } from "./owners.mjs";
import { spawnSizeRefresh } from "./sizes.mjs";
import { agePruneBuilds, capPrune, DAY, HOUR, pruneRepos, sweepTrash, wipeInternalBuilds } from "./prune.mjs";
import { dotReport } from "./dots.mjs";
import { findProjectRoot, loadProjectConfig, sourceRepos } from "./project.mjs";
import { protections } from "./leases.mjs";

// Cargo toolchain homes are host-managed by default. Only prune one when the owner explicitly opts in.
const cargoCacheHome = (env) => env.CLEAN_DEV_CARGO_CACHE_HOME && path.isAbsolute(env.CLEAN_DEV_CARGO_CACHE_HOME)
  ? env.CLEAN_DEV_CARGO_CACHE_HOME : null;

// Storage follows the configured external volume: every shell probes it for each session start and resume. The
// pin's first line only says what the session used before; `lost` marks a session that used the external volume and
// now finds it gone (its external scratch waits for the drive).
export function decideMode(conf, env, key, preflight = null) {
  const pin = key ? readPin(env, key) : { mode: null };
  const strict = preflight || detect(conf, env);
  // The two-write probe can wait five seconds, so sessionStart performs it before taking the shared lifecycle lock.
  // Recheck mount, directory topology and access under the lock; external routing requires both checks to pass.
  const current = detect(conf, env, { probe: false, create: false });
  const observed = strict.mode === "external" && current.mode === "external"
    ? { ...current, attempts: strict.attempts }
    : strict.mode === "external" ? current : strict;
  const mode = strict.mode === "external" && current.mode === "external" ? "external" : "internal";
  const usedExternal = pin.mode === "external" || (pin.meta?.ownedRoots || []).includes(conf.externalCache);
  return { mode, pinned: !!pin.mode, lost: mode === "internal" && usedExternal, reason: observed.reason, detect: observed };
}

export function sessionStart(input, harness, env = process.env) {
  const conf = loadConf(env);
  const preflight = detect(conf, env);
  const r = withLifecycleLock(env, () => startLocked(input, harness, env, conf, preflight));
  if (r.locked) throw new Error(`lifecycle lock busy${r.reclaim ? ` (reboot reclaim refused: ${r.reclaim.reason})` : ""}; routing remains active, cleanup skipped; run doctor`);
  return r.result;
}

function startLocked(input, harness, env, conf, preflight) {
  const home = homeDir(env);
  const key = sessionKey(harness, input?.session_id);
  const pin = key ? readPin(env, key) : null;
  if (pin) assertOwner(pin, input.session_id);
  const d = decideMode(conf, env, key, preflight);
  const root = rootFor(conf, d.mode);
  const l = ensureLayout(root);
  const cwd = typeof input?.cwd === "string" ? input.cwd : null;
  const projectRoot = findProjectRoot(cwd, home);
  if (key) {
    const prev = pin.meta;
    fs.mkdirSync(path.join(l.scratch, key, "tmp"), { recursive: true, mode: 0o700 });
    writePin(env, key, d.mode, {
      version: VERSION, key, harness, sessionId: input.session_id, mode: d.mode, root,
      modeReason: d.reason, probeAttempts: d.detect?.attempts ?? null, owner: harnessProcess(process.ppid, env) || prev?.owner || null,
      cwd, projectRoot, transcriptPath: input?.transcript_path || prev?.transcriptPath || null, source: input?.source || null,
      ownedRoots: [...new Set([...(prev?.ownedRoots || []), root])],
      startedAt: prev?.startedAt || new Date().toISOString(), lastSeen: new Date().toISOString()
    }, { reopen: pin.ended });
    // Ownership for prune --project goes to the durable index, never into builds/<key>: a file there would make
    // $CLEAN_DEV_BUILDS non-empty and break `git clone URL "$CLEAN_DEV_BUILDS"`, and scratch disappears at session end.
    const priorRoots = prev?.ownedRoots;
    const externalUsed = root === conf.externalCache || priorRoots?.includes(conf.externalCache) ? true
      : Array.isArray(priorRoots) || pin.revision === "-|-|-|-" ? false : null;
    stampOwner(env, ownersDir(env), path.join(ownersDir(env), key), { repo: projectRoot, cwd, harness, key, externalUsed });
  }
  let reap = { reaped: [], live: [], orphans: [] };
  if (key) try { reap = reapAll(conf, env, { currentKey: key, budgetMs: 400, locked: true, log: (m) => appendLog(logPath(env), m) }); } catch (e) { appendLog(logPath(env), `reap: ${e.message}`); }
  const dots = dotReport(conf, home);
  const { dead } = sourceRepos(home);
  const pc = loadProjectConfig(projectRoot);
  const idProblem = key ? null : input?.session_id ? sessionIdProblem(input.session_id) : null;
  return { conf, key, idProblem, decision: d, root, layout: l, dots, dead, project: pc, projectRoot, reap, free: freeBytes(root),
    internalFree: internalFreeBytes(conf, env), work: workRoot(conf, d.mode, env) };
}

function stampOwner(env, anchor, dir, info) {
  if (!safeDirectory(stateDir(env), anchor, { missingAnchor: true }) || !safeDirectory(anchor, dir, { missingAnchor: true }) || hasOwnerConflict(dir)) return;
  const w = writeOwner(dir, { ...info, created: new Date().toISOString() });
  if (w.projectChanged) {
    const marked = markOwnerConflict(dir);
    appendLog(logPath(env), `owner stamp ${dir}: project changed; pruning disabled${marked.error ? ` (${marked.error})` : ""}`);
  } else if (w.conflict || w.error) appendLog(logPath(env), `owner stamp ${dir}: ${w.conflict ? "another key owns it" : w.error}`);
}

function noteOwnerExternal(env, key) {
  const dir = path.join(ownersDir(env), key), owner = readOwner(dir);
  if (owner && owner.externalUsed !== true) {
    const r = writeOwner(dir, { ...owner, externalUsed: true });
    if (r.error) appendLog(logPath(env), `owner stamp ${dir}: ${r.error}`);
  }
}

// Index entries hold .owner.json and, after a project switch, an optional .owner-conflict marker. Internal-only
// entries can be removed once their internal build path and pin are gone; external-used or legacy-unknown entries
// wait until the external root is available and every build path can be checked.
function pruneOwnerIndex(env, conf, { roots, external, deadline, log }) {
  const dir = ownersDir(env);
  if (!safeDirectory(stateDir(env), dir)) return;
  for (const d of children(dir, 20000)) {
    if (!timeLeft(deadline)) return;
    const p = path.join(dir, d.name), names = d.isDirectory() && !d.isSymbolicLink() ? children(p, 20000, { requireComplete: true }).map((entry) => entry.name) : null;
    if (!/^[cx]-[A-Za-z0-9_-]{12}$/.test(d.name) || !names || names.some((n) => ![OWNER_FILE, OWNER_CONFLICT_FILE].includes(n))) continue;
    const st = lstatOrNull(path.join(p, OWNER_FILE));
    if (!st?.isFile() || Date.now() - st.mtimeMs < conf.EXTERNAL_BUILD_DAYS * DAY) continue;
    const owner = readOwner(p);
    // When external storage is away, retire only entries created with explicit internal-only ownership.
    // Legacy or external-used entries remain until every root can be inspected.
    if (!external && owner?.externalUsed !== false) continue;
    if (readPin(env, d.name).mode || readPin(env, d.name).meta || roots.some((r) => lstatOrNull(path.join(layout(r).builds, d.name)))) continue;
    try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { log(`owner index ${p}: ${e.code || e.message}`); }
  }
}

export function contextText(r) {
  const c = r.conf;
  const lines = [];
  const scratch = r.key ? path.join(r.layout.scratch, r.key, "tmp") : null;
  const builds = r.key ? path.join(r.layout.builds, r.key) : r.layout.builds;
  if (r.decision.mode === "external") {
    lines.push(`clean-development ${VERSION}: mode=external (${c.externalVolume} attached). Cache root ${r.root} (${fmtGB(r.free)} free). Work root CLEAN_DEV_WORK=${r.work}.`);
    lines.push(`Session scratch: TMPDIR=${scratch || "(no session key)"}, deleted when the session ends. Throwaway build output: ${builds} (kept, pruned after ${c.EXTERNAL_BUILD_DAYS} days).`);
  } else {
    const why = r.decision.lost ? `the ${c.externalVolume} volume is not available now; this session's ${c.externalVolume} scratch and builds wait for it` : `${c.externalVolume} volume not available: ${r.decision.reason}`;
    lines.push(`clean-development ${VERSION}: mode=internal (${why}). Cache root ${r.root} on the internal disk (${fmtGB(r.free)} free). Work root CLEAN_DEV_WORK=${r.work}.`);
    lines.push(`Session scratch TMPDIR=${scratch || "(no session key)"} and build output ${builds} are deleted when the session ends.`);
    lines.push(`All development runs on the internal disk: builds, test suites, gates, installs, worktrees (under $CLEAN_DEV_WORK/worktrees) and simulators. Only VMs, models, datasets and ${c.externalVolume}-only projects wait for the drive (lab ${c.labRoot}, models ${c.modelsRoot}).`);
  }
  lines.push(`Storage follows the configured external volume per shell: use it when mounted and writable, and the internal disk otherwise. Do not override routing. Before any download over ${c.BIG_DOWNLOAD_GB} GB, make sure the configured external volume is available.`);
  if (r.internalFree !== null && r.internalFree < c.INTERNAL_MIN_FREE_GB * GB) lines.push(`Internal free space ${fmtGB(r.internalFree)} is below the configured ${c.INTERNAL_MIN_FREE_GB} GB warning threshold.`);
  if (r.idProblem) lines.push(`Session id rejected (${r.idProblem}): no session scratch, pin or cleanup ownership; this session routes like a plain shell. Check the host session id.`);
  lines.push("Clean Development routes its cache variables ($DEVCACHE, npm_config_cache, pnpm_config_store_dir, YARN_CACHE_FOLDER, UV_CACHE_DIR, PIP_CACHE_DIR, HF_HUB_CACHE, HF_ASSETS_CACHE, GOCACHE and GOMODCACHE); preserve these routes and keep work in git-ignored project build directories.");
  lines.push("Scratch/builds are disposable: keep unique work, rollback state and final/partial evidence in a durable project directory before ending. Native lifecycle support: Claude/Codex; OpenCode is environment-only.");
  lines.push("Protect long/quiet jobs with explicit renewable path leases. Verified publish creates a source hold until completion; failed/incomplete publication stays protected until recovery is confirmed, not merely until a TTL expires.");
  if (r.dead.length && r.decision.mode === "internal") lines.push(`Unavailable while the ${c.externalVolume} is away: ${r.dead.map((x) => `~/dev/source/${x.name}`).join(", ")}.`);
  if (r.project && !r.project.ok) lines.push(`Project ${r.project.file}: invalid (${r.project.errors.join("; ")}); fix it to schema v2.`);
  else if (r.project?.migrate) lines.push(`Project ${r.project.file} is schema v1; run: clean-development migrate --write ${path.dirname(r.project.file)}`);
  if (r.project?.config?.heavy && r.decision.mode === "internal") lines.push(`This project is marked heavy: expect large builds or downloads on the internal disk; watch free space and the ${c.BIG_DOWNLOAD_GB} GB download rule.`);
  if (r.dots.folders.length) {
    const shown = r.dots.folders.slice(0, 10).join(" ");
    lines.push(`Unexpected dot-folders (policy: none outside the allowlist in ~/dev/machine/storage.conf; report them, never delete): ${shown}${r.dots.folders.length > 10 ? ` (+${r.dots.folders.length - 10} more)` : ""}.`);
  }
  if (!c.valid) lines.push(`storage.conf problems: ${c.errors.join("; ")}.`);
  lines.push("Load the clean-development skill for storage, download or cleanup decisions.");
  return lines.join("\n");
}

export function stop(input, harness, env = process.env, { force = false, dryRun = false, budgetMs = 1500 } = {}) {
  const deadline = Date.now() + budgetMs;
  const conf = loadConf(env);
  const home = homeDir(env);
  const key = sessionKey(harness, input?.session_id);
  if (key) assertOwner(readPin(env, key), input.session_id);
  const log = dryRun ? () => {} : (m) => appendLog(logPath(env), m);
  const stamps = stampsDir(env);
  const run = () => {
    const out = { reap: null, internalIdle: [], lastOut: [], external: [], caps: [], trash: [], repos: [], repoBlocked: [], errors: [] };
    // Each stage is isolated: one failing stage (an unremovable trash entry, a bad repo) never skips the others.
    const stage = (name, fn) => { try { fn(); } catch (e) { out.errors.push(`${name}: ${e.code || e.message}`); log(`stop ${name}: ${e.stack || e.message}`); } };
    if (!key && !force) return { ...out, skipped: "missing session identity", reap: { reaped: [], live: [], orphans: [] } };
    if (!conf.valid) return { ...out, skipped: "invalid storage configuration", reap: { reaped: [], live: [], orphans: [] } };
    if (key && !dryRun) {
      touchPin(env, key);
      const root = rootFor(conf, externalAvailable(conf, env) ? "external" : "internal");
      recordRoot(env, key, root);
      if (root === conf.externalCache) noteOwnerExternal(env, key);
    }
    const protectedState = protections(env);
    if (protectedState.errors.length) return { ...out, skipped: "uncertain lease registry", leaseErrors: protectedState.errors, reap: { reaped: [], live: [], orphans: [] } };
    const protect = protectedState.protect;
    stage("reap", () => { out.reap = reapAll(conf, env, { currentKey: key, dryRun, log, locked: true, protect, deadline }); });
    out.reap ??= { reaped: [], live: [], orphans: [] };
    const sessions = classify(conf, env, Date.now(), { deadline, protect });
    const live = sessions.filter((s) => s.key === key || !s.done);
    const liveKeys = new Set(live.map((s) => s.key));
    const liveProjects = new Set(live.map((s) => projectIdentity(s.meta?.projectRoot)).filter(Boolean));
    const projectCleanupAllowed = live.every((s) => s.meta && !s.errors.length);
    // Initial mode is not ownership: an external pin may own active internal fallback builds.
    // Ended sessions retained for a resume window or a job keep their own dirs through liveKeys; they no longer hold
    // back the last-out wipe of everyone else's internal builds.
    // Storage follows the drive: while the external volume is away every live session may be writing internal builds.
    const extNow = externalAvailable(conf, env);
    const liveInternal = live.filter((s) => !s.ended && (!extNow || s.mode === "internal" || s.lost || s.meta?.mode === "internal"
      || (s.meta?.ownedRoots || []).includes(conf.internalRoot)));
    const eventsFile = deletionsPath(env);
    // Internal builds: idle prune hourly (DerivedData only after EXTERNAL_BUILD_DAYS); session build dirs are wiped when no internal session is live.
    if (force || stampDue(stamps, "internal-builds", HOUR)) stage("internal builds", () => {
      out.internalIdle = agePruneBuilds(conf.internalRoot, conf.INTERNAL_BUILD_IDLE_HOURS * HOUR, { liveKeys, dryRun, log, eventsFile, protect, deadline, derivedDataMaxAgeMs: conf.EXTERNAL_BUILD_DAYS * DAY });
      if (liveInternal.length === 0) out.lastOut = wipeInternalBuilds(conf, { liveKeys, dryRun, log, eventsFile, protect, deadline });
      if (!dryRun && timeLeft(deadline)) stampTouch(stamps, "internal-builds");
    });
    const ext = externalAvailable(conf, env);
    // External builds: kept, entries older than EXTERNAL_BUILD_DAYS pruned at most every EXTERNAL_PRUNE_EVERY_DAYS.
    if (ext && (force || stampDue(stamps, "external-builds", conf.EXTERNAL_PRUNE_EVERY_DAYS * DAY))) stage("external builds", () => {
      out.external = agePruneBuilds(conf.externalCache, conf.EXTERNAL_BUILD_DAYS * DAY, { liveKeys, dryRun, log, eventsFile, protect, deadline });
      if (!dryRun && timeLeft(deadline)) stampTouch(stamps, "external-builds");
    });
    // Repo-local declared build/dependency dirs in repos idle for EXTERNAL_BUILD_DAYS (weekly).
    if (projectCleanupAllowed && (force || stampDue(stamps, "repos", conf.EXTERNAL_PRUNE_EVERY_DAYS * DAY))) stage("repos", () => {
      out.repos = pruneRepos(home, conf, { dryRun, log, liveProjects, eventsFile, protect, deadline, onBlocked: (r) => {
        out.repoBlocked.push(r); if (!dryRun) log(`repo cleanup deferred for ${r.project}: ${r.reason}`);
      } });
      if (!dryRun && timeLeft(deadline) && !out.repoBlocked.length) stampTouch(stamps, "repos");
    });
    // Shared dependency caches: LRU cap per root, hourly.
    if (force || stampDue(stamps, "caps", HOUR)) stage("caps", () => {
      out.caps.push(capPrune(conf.internalRoot, conf, { cargoHome: cargoCacheHome(env), dryRun, log, eventsFile, protect, deadline }));
      if (ext) out.caps.push(capPrune(conf.externalCache, conf, { dryRun, log, eventsFile, protect, deadline }));
      if (!dryRun && timeLeft(deadline) && out.caps.every((c) => !c.skipped)) stampTouch(stamps, "caps");
    });
    stage("internal trash", () => out.trash.push(...sweepTrash(conf.internalRoot, { dryRun, eventsFile, protect, deadline, log })));
    if (ext) stage("external trash", () => out.trash.push(...sweepTrash(conf.externalCache, { dryRun, eventsFile, protect, deadline, log })));
    // Weekly: drop ownership index entries whose session is gone and whose builds no root holds any more.
    if (!dryRun && (force || stampDue(stamps, "owners", conf.EXTERNAL_PRUNE_EVERY_DAYS * DAY))) stage("owner index", () => {
      pruneOwnerIndex(env, conf, { roots: [conf.internalRoot].concat(ext ? [conf.externalCache] : []), external: ext, deadline, log });
      if (timeLeft(deadline)) stampTouch(stamps, "owners");
    });
    // Daily detached size measurement for `status --sizes`, doctor and housekeeping; the CLI refreshes on --apply.
    if (!dryRun && !force && stampDue(stamps, "sizes", DAY)) stage("sizes", () => { spawnSizeRefresh(env); stampTouch(stamps, "sizes"); });
    out.timedOut = !timeLeft(deadline);
    out.deferred = out.repoBlocked.length > 0 || out.errors.length > 0;
    if (!projectCleanupAllowed) out.projectCleanupSkipped = "a live project's ownership is unresolved";
    return out;
  };
  // Preview does not heartbeat, lock, stamp, probe-write or create state.
  const res = dryRun ? { locked: false, result: run() } : withLifecycleLock(env, run);
  return res;
}

export function sessionEnd(input, harness, env = process.env) {
  const deadline = Date.now() + 1200;
  const conf = loadConf(env);
  const key = sessionKey(harness, input?.session_id);
  if (!key) return { key: null, skipped: "missing session identity" };
  const observed = readPin(env, key);
  assertOwner(observed, input.session_id);
  if (!observed.mode) return { key, skipped: "unknown session" };
  const result = withLifecycleLock(env, () => {
    const pin = readPin(env, key);
    if (pin.revision !== observed.revision || (input.generation && input.generation !== pin.meta?.generation)) return { key, skipped: "ownership changed" };
    if (!conf.valid) return { key, skipped: "invalid storage configuration" };
    if ((observed.meta?.ownedRoots || []).includes(conf.externalCache) || externalAvailable(conf, env)) noteOwnerExternal(env, key);
    if (!markEnded(env, key, { generation: pin.meta?.generation })) return { key, skipped: "invalid or changed ownership state" };
    const s = { key, ...readPin(env, key) };
    const protect = protections(env).protect;
    const others = classify(conf, env, Date.now(), { deadline, protect }).filter((x) => x.key !== key && !x.done);
    const liveProjects = new Set(others.map((x) => projectIdentity(x.meta?.projectRoot)).filter(Boolean));
    const r = reapSession(conf, env, s, { locked: true, deadline, protect, projectCleanupAllowed: others.every((s) => s.meta && !s.errors.length), log: (m) => appendLog(logPath(env), m), liveProjects });
    // Ended and recorded; cleanup waits for the Codex resume window or a running *.pid job (retried by later Stops).
    return r.retained ? { key, ended: true, retained: r.retained, removed: [] } : r;
  });
  return result.locked ? { key, skipped: "lifecycle locked" } : { key, ...result.result };
}

export { layout };
