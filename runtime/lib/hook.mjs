// clean-development 0.6.0: hook handlers shared by Claude Code and Codex.
//   session-start  decide the mode once (strict probe), pin it, prepare scratch, reap finished sessions (time-boxed),
//                  report mode, roots, the 5 GB rule and unexpected dot-folders as additional context.
//   stop           per turn (async): heartbeat, then throttled housekeeping under a cross-session lock.
//   session-end    mark ended and remove this session's scratch (and, internal mode, its builds) at once.
// Hooks never fail a session: errors are logged to ~/dev/machine/state/clean-development/hook.log and exit 0.
import fs from "node:fs";
import path from "node:path";
import { VERSION, deletionsPath, homeDir, loadConf, logPath, stampsDir } from "./conf.mjs";
import { detect, ensureLayout, externalAvailable, fmtGB, freeBytes, GB, layout, rootFor } from "./storage.mjs";
import { appendLog, stampDue, stampTouch, timeLeft, withLock } from "./fsutil.mjs";
import { assertOwner, classify, lifecycleLock, markEnded, projectIdentity, readPin, reapAll, reapSession, sessionKey, touchPin, writePin } from "./sessions.mjs";
import { agePruneBuilds, capPrune, DAY, HOUR, pruneRepos, sweepTrash, wipeInternalBuilds } from "./prune.mjs";
import { dotReport } from "./dots.mjs";
import { findProjectRoot, loadProjectConfig, sourceRepos } from "./project.mjs";
import { protections } from "./leases.mjs";

const cargoHome = (env) => path.join(homeDir(env), "dev", "machine", "toolchains", "rust", "cargo");

export function decideMode(conf, env, key) {
  const pin = key ? readPin(env, key) : { mode: null };
  const strict = detect(conf, env);
  if (pin.mode === "internal") return { mode: "internal", pinned: true, reason: "pinned at session start", detect: strict };
  if (pin.mode === "external") {
    if (strict.mode === "external") return { mode: "external", pinned: true, reason: "pinned at session start", detect: strict };
    return { mode: "internal", pinned: true, lost: true, reason: `pinned external, but ${strict.reason}`, detect: strict };
  }
  return { mode: strict.mode, pinned: false, reason: strict.reason, detect: strict };
}

export function sessionStart(input, harness, env = process.env) {
  const r = withLock(lifecycleLock(env), () => startLocked(input, harness, env));
  if (r.locked) throw new Error("lifecycle lock busy; routing remains active, cleanup skipped; run doctor");
  return r.result;
}

function startLocked(input, harness, env) {
  const conf = loadConf(env);
  const home = homeDir(env);
  const key = sessionKey(harness, input?.session_id);
  const pin = key ? readPin(env, key) : null;
  if (pin) assertOwner(pin, input.session_id);
  const d = decideMode(conf, env, key);
  const root = rootFor(conf, d.mode);
  const l = ensureLayout(root);
  const cwd = typeof input?.cwd === "string" ? input.cwd : null;
  const projectRoot = findProjectRoot(cwd, home);
  if (key) {
    const prev = pin.meta;
    fs.mkdirSync(path.join(l.scratch, key, "tmp"), { recursive: true, mode: 0o700 });
    writePin(env, key, d.lost ? "external" : d.mode, {
      version: VERSION, key, harness, sessionId: input.session_id, mode: d.mode, root,
      cwd, projectRoot, transcriptPath: input?.transcript_path || prev?.transcriptPath || null, source: input?.source || null,
      ownedRoots: [...new Set([...(prev?.ownedRoots || []), root])],
      startedAt: prev?.startedAt || new Date().toISOString(), lastSeen: new Date().toISOString()
    }, { reopen: pin.ended });
  }
  let reap = { reaped: [], live: [], orphans: [] };
  if (key) try { reap = reapAll(conf, env, { currentKey: key, budgetMs: 400, locked: true, log: (m) => appendLog(logPath(env), m) }); } catch (e) { appendLog(logPath(env), `reap: ${e.message}`); }
  const dots = dotReport(conf, home);
  const { dead } = sourceRepos(home);
  const pc = loadProjectConfig(projectRoot);
  return { conf, key, decision: d, root, layout: l, dots, dead, project: pc, projectRoot, reap, free: freeBytes(root) };
}

export function contextText(r) {
  const c = r.conf;
  const lines = [];
  const scratch = r.key ? path.join(r.layout.scratch, r.key, "tmp") : null;
  const builds = r.key ? path.join(r.layout.builds, r.key) : r.layout.builds;
  if (r.decision.mode === "external") {
    lines.push(`clean-development ${VERSION}: mode=external (${c.externalVolume} attached). Cache root ${r.root} (${fmtGB(r.free)} free).`);
    lines.push(`Session scratch: TMPDIR=${scratch || "(no session key)"}, deleted when the session ends. Throwaway build output: ${builds} (kept, pruned after ${c.EXTERNAL_BUILD_DAYS} days).`);
  } else {
    const why = r.decision.lost ? `the ${c.externalVolume} volume disappeared after this session pinned it` : `${c.externalVolume} not available: ${r.decision.reason}`;
    lines.push(`clean-development ${VERSION}: mode=internal (${why}). Cache root ${r.root} on the internal disk (${fmtGB(r.free)} free).`);
    lines.push(`Session scratch TMPDIR=${scratch || "(no session key)"} and build output ${builds} are deleted when the session ends.`);
    lines.push(`Before any download, model pull, VM image or build likely over ${c.BIG_DOWNLOAD_GB} GB: stop, tell G and suggest waiting for the ${c.externalVolume}; continue only if G says so. External-only projects/stores may be unavailable. Lab/model paths are configured as ${c.labRoot} and ${c.modelsRoot}; honour approved policy overrides rather than assuming both are external.`);
    if (r.free !== null && r.free < c.INTERNAL_MIN_FREE_GB * GB) lines.push(`Warning: internal free space ${fmtGB(r.free)} is below ${c.INTERNAL_MIN_FREE_GB} GB.`);
  }
  lines.push("Caches are routed by ~/dev/machine/env.zsh ($DEVCACHE, npm/pnpm/uv/pip/go/HF/... variables); never override them, never write caches, builds or temp files into ~ or into repos outside their git-ignored build dirs.");
  lines.push("Scratch/builds are disposable: keep unique work, rollback state and final/partial evidence in a durable project directory before ending. Native lifecycle support: Claude/Codex; OpenCode is environment-only.");
  lines.push("Protect long/quiet jobs with explicit renewable path leases. Verified publish creates a source hold until completion; failed/incomplete publication stays protected until recovery is confirmed, not merely until a TTL expires.");
  if (r.dead.length && r.decision.mode === "internal") lines.push(`Unavailable while the ${c.externalVolume} is away: ${r.dead.map((x) => `~/dev/source/${x.name}`).join(", ")}.`);
  if (r.project && !r.project.ok) lines.push(`Project ${r.project.file}: invalid (${r.project.errors.join("; ")}); fix it to schema v2.`);
  else if (r.project?.migrate) lines.push(`Project ${r.project.file} is schema v1; run: clean-development migrate --write ${path.dirname(r.project.file)}`);
  if (r.project?.config?.heavy && r.decision.mode === "internal") lines.push("This project is marked heavy: expect large builds or downloads; check with G before starting them.");
  if (r.dots.folders.length) {
    const shown = r.dots.folders.slice(0, 10).join(" ");
    lines.push(`Unexpected dot-folders (policy: none outside the allowlist in ~/dev/machine/storage.conf; report to G, never delete): ${shown}${r.dots.folders.length > 10 ? ` (+${r.dots.folders.length - 10} more)` : ""}.`);
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
  const log = (m) => appendLog(logPath(env), m);
  const stamps = stampsDir(env);
  const run = () => {
    const out = { reap: null, internalIdle: [], lastOut: [], external: [], caps: [], trash: [], repos: [], repoBlocked: [] };
    if (!key && !force) return { ...out, skipped: "missing session identity", reap: { reaped: [], live: [], orphans: [] } };
    if (!conf.valid) return { ...out, skipped: "invalid storage configuration", reap: { reaped: [], live: [], orphans: [] } };
    if (key && !dryRun) touchPin(env, key);
    const protectedState = protections(env);
    if (protectedState.errors.length) return { ...out, skipped: "uncertain lease registry", leaseErrors: protectedState.errors, reap: { reaped: [], live: [], orphans: [] } };
    const protect = protectedState.protect;
    out.reap = reapAll(conf, env, { currentKey: key, dryRun, log, locked: true, protect, deadline });
    const sessions = classify(conf, env, Date.now(), { deadline });
    const live = sessions.filter((s) => s.key === key || !s.done);
    const liveKeys = new Set(live.map((s) => s.key));
    const liveProjects = new Set(live.map((s) => projectIdentity(s.meta?.projectRoot)).filter(Boolean));
    const projectCleanupAllowed = live.every((s) => s.meta && !s.errors.length);
    // Initial mode is not ownership: an external pin may own active internal fallback builds.
    const liveInternal = live.filter((s) => s.mode === "internal" || s.lost || s.meta?.mode === "internal");
    const eventsFile = deletionsPath(env);
    // Internal builds: idle prune hourly (DerivedData only after EXTERNAL_BUILD_DAYS); session build dirs wiped when no internal session is live (Q30).
    if (force || stampDue(stamps, "internal-builds", HOUR)) {
      out.internalIdle = agePruneBuilds(conf.internalRoot, conf.INTERNAL_BUILD_IDLE_HOURS * HOUR, { liveKeys, dryRun, log, eventsFile, protect, deadline, derivedDataMaxAgeMs: conf.EXTERNAL_BUILD_DAYS * DAY });
      if (liveInternal.length === 0) out.lastOut = wipeInternalBuilds(conf, { liveKeys, dryRun, log, eventsFile, protect, deadline });
      if (!dryRun && timeLeft(deadline)) stampTouch(stamps, "internal-builds");
    }
    const ext = externalAvailable(conf, env);
    // External builds: kept, entries older than EXTERNAL_BUILD_DAYS pruned at most every EXTERNAL_PRUNE_EVERY_DAYS.
    if (ext && (force || stampDue(stamps, "external-builds", conf.EXTERNAL_PRUNE_EVERY_DAYS * DAY))) {
      out.external = agePruneBuilds(conf.externalCache, conf.EXTERNAL_BUILD_DAYS * DAY, { liveKeys, dryRun, log, eventsFile, protect, deadline });
      if (!dryRun && timeLeft(deadline)) stampTouch(stamps, "external-builds");
    }
    // Repo-local declared build/dependency dirs in repos idle for EXTERNAL_BUILD_DAYS (weekly).
    if (projectCleanupAllowed && (force || stampDue(stamps, "repos", conf.EXTERNAL_PRUNE_EVERY_DAYS * DAY))) {
      out.repos = pruneRepos(home, conf, { dryRun, log, liveProjects, eventsFile, protect, deadline, onBlocked: (r) => {
        out.repoBlocked.push(r); if (!dryRun) log(`repo cleanup deferred for ${r.project}: ${r.reason}`);
      } });
      if (!dryRun && timeLeft(deadline) && !out.repoBlocked.length) stampTouch(stamps, "repos");
    }
    // Shared dependency caches: LRU cap per root, hourly.
    if (force || stampDue(stamps, "caps", HOUR)) {
      out.caps.push(capPrune(conf.internalRoot, conf, { cargoHome: cargoHome(env), dryRun, log, eventsFile, protect, deadline }));
      if (ext) out.caps.push(capPrune(conf.externalCache, conf, { dryRun, log, eventsFile, protect, deadline }));
      if (!dryRun && timeLeft(deadline) && out.caps.every((c) => !c.skipped)) stampTouch(stamps, "caps");
    }
    out.trash.push(...sweepTrash(conf.internalRoot, { dryRun, eventsFile, protect, deadline }));
    if (ext) out.trash.push(...sweepTrash(conf.externalCache, { dryRun, eventsFile, protect, deadline }));
    out.timedOut = !timeLeft(deadline);
    out.deferred = out.repoBlocked.length > 0;
    if (!projectCleanupAllowed) out.projectCleanupSkipped = "a live project's ownership is unresolved";
    return out;
  };
  // Preview does not heartbeat, lock, stamp, probe-write or create state.
  return dryRun ? { locked: false, result: run() } : withLock(lifecycleLock(env), run);
}

export function sessionEnd(input, harness, env = process.env) {
  const deadline = Date.now() + 1200;
  const conf = loadConf(env);
  const key = sessionKey(harness, input?.session_id);
  if (!key) return { key: null, skipped: "missing session identity" };
  const observed = readPin(env, key);
  assertOwner(observed, input.session_id);
  if (!observed.mode) return { key, skipped: "unknown session" };
  const result = withLock(lifecycleLock(env), () => {
    const pin = readPin(env, key);
    if (pin.revision !== observed.revision || (input.generation && input.generation !== pin.meta?.generation)) return { key, skipped: "ownership changed" };
    if (!conf.valid) return { key, skipped: "invalid storage configuration" };
    if (!markEnded(env, key, { generation: pin.meta?.generation })) return { key, skipped: "invalid or changed ownership state" };
    const s = { key, ...readPin(env, key) };
    const others = classify(conf, env, Date.now(), { deadline }).filter((x) => x.key !== key && !x.done);
    const liveProjects = new Set(others.map((x) => projectIdentity(x.meta?.projectRoot)).filter(Boolean));
    return reapSession(conf, env, s, { locked: true, deadline, projectCleanupAllowed: others.every((s) => s.meta && !s.errors.length), log: (m) => appendLog(logPath(env), m), liveProjects });
  });
  return result.locked ? { key, skipped: "lifecycle locked" } : { key, ...result.result };
}

export { layout };
