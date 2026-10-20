// clean-development 0.6.0: hook handlers shared by Claude Code and Codex.
//   session-start  decide the mode once (strict probe), pin it, prepare scratch, reap finished sessions (time-boxed),
//                  report mode, roots, the 5 GB rule and unexpected dot-folders as additional context.
//   stop           per turn (async): heartbeat, then throttled housekeeping under a cross-session lock.
//   session-end    mark ended and remove this session's scratch (and, internal mode, its builds) at once.
// Hooks never fail a session: errors are logged to ~/dev/machine/state/clean-development/hook.log and exit 0.
import fs from "node:fs";
import path from "node:path";
import { VERSION, homeDir, loadConf, logPath, stampsDir, stateDir } from "./conf.mjs";
import { detect, ensureLayout, externalAvailable, fmtGB, freeBytes, GB, layout, rootFor } from "./storage.mjs";
import { appendLog, stampDue, stampTouch, withLock } from "./fsutil.mjs";
import { classify, markEnded, readPin, reapAll, reapSession, sessionKey, touchPin, writePin } from "./sessions.mjs";
import { agePruneBuilds, capPrune, DAY, HOUR, pruneRepos, sweepTrash, wipeInternalBuilds } from "./prune.mjs";
import { dotReport } from "./dots.mjs";
import { findProjectRoot, loadProjectConfig, sourceRepos } from "./project.mjs";

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
  const conf = loadConf(env);
  const home = homeDir(env);
  const key = sessionKey(harness, input?.session_id);
  const d = decideMode(conf, env, key);
  const root = rootFor(conf, d.mode);
  const l = ensureLayout(root);
  const cwd = typeof input?.cwd === "string" ? input.cwd : null;
  const projectRoot = findProjectRoot(cwd, home);
  if (key) {
    const prev = readPin(env, key).meta;
    fs.mkdirSync(path.join(l.scratch, key, "tmp"), { recursive: true, mode: 0o700 });
    writePin(env, key, d.lost ? "external" : d.mode, {
      version: VERSION, key, harness, sessionId: input.session_id, mode: d.mode, root,
      cwd, projectRoot, transcriptPath: input?.transcript_path || null, source: input?.source || null,
      startedAt: prev?.startedAt || new Date().toISOString(), lastSeen: new Date().toISOString()
    });
  }
  let reap = { reaped: [], live: [], orphans: [] };
  try { reap = reapAll(conf, env, { currentKey: key, budgetMs: 400, log: (m) => appendLog(logPath(env), m) }); } catch (e) { appendLog(logPath(env), `reap: ${e.message}`); }
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
    lines.push(`Before any download, model pull, VM image or build likely over ${c.BIG_DOWNLOAD_GB} GB: stop, tell G and suggest waiting for the ${c.externalVolume}; continue only if G says so. The VM lab (${c.labRoot}), ${c.modelsRoot} and 4TB-only projects are unavailable.`);
    if (r.free !== null && r.free < c.INTERNAL_MIN_FREE_GB * GB) lines.push(`Warning: internal free space ${fmtGB(r.free)} is below ${c.INTERNAL_MIN_FREE_GB} GB.`);
  }
  lines.push("Caches are routed by ~/dev/machine/env.zsh ($DEVCACHE, npm/pnpm/uv/pip/go/HF/... variables); never override them, never write caches, builds or temp files into ~ or into repos outside their git-ignored build dirs.");
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

export function stop(input, harness, env = process.env, { force = false, dryRun = false } = {}) {
  const conf = loadConf(env);
  const home = homeDir(env);
  const key = sessionKey(harness, input?.session_id);
  if (key) touchPin(env, key);
  const log = (m) => appendLog(logPath(env), m);
  const stamps = stampsDir(env);
  const lock = path.join(stateDir(env), "housekeeping.lock");
  const res = withLock(lock, () => {
    const out = { reap: null, internalIdle: [], lastOut: [], external: [], caps: [], trash: [], repos: [] };
    out.reap = reapAll(conf, env, { currentKey: key, dryRun, log });
    const sessions = classify(conf, env);
    const live = sessions.filter((s) => s.key === key || !s.done);
    const liveKeys = new Set(live.map((s) => s.key));
    const liveProjects = new Set(live.map((s) => s.meta?.projectRoot).filter(Boolean));
    const liveInternal = live.filter((s) => (s.mode || "internal") === "internal" && !s.lost);
    // Internal builds: idle prune hourly (DerivedData only after EXTERNAL_BUILD_DAYS); session build dirs wiped when no internal session is live (Q30).
    if (force || stampDue(stamps, "internal-builds", HOUR)) {
      out.internalIdle = agePruneBuilds(conf.internalRoot, conf.INTERNAL_BUILD_IDLE_HOURS * HOUR, { liveKeys, dryRun, log, derivedDataMaxAgeMs: conf.EXTERNAL_BUILD_DAYS * DAY });
      if (liveInternal.length === 0) out.lastOut = wipeInternalBuilds(conf, { dryRun, log });
      if (!dryRun) stampTouch(stamps, "internal-builds");
    }
    const ext = externalAvailable(conf, env);
    // External builds: kept, entries older than EXTERNAL_BUILD_DAYS pruned at most every EXTERNAL_PRUNE_EVERY_DAYS.
    if (ext && (force || stampDue(stamps, "external-builds", conf.EXTERNAL_PRUNE_EVERY_DAYS * DAY))) {
      out.external = agePruneBuilds(conf.externalCache, conf.EXTERNAL_BUILD_DAYS * DAY, { liveKeys, dryRun, log });
      if (!dryRun) stampTouch(stamps, "external-builds");
    }
    // Repo-local declared build/dependency dirs in repos idle for EXTERNAL_BUILD_DAYS (weekly).
    if (force || stampDue(stamps, "repos", conf.EXTERNAL_PRUNE_EVERY_DAYS * DAY)) {
      out.repos = pruneRepos(home, conf, { dryRun, log, liveProjects });
      if (!dryRun) stampTouch(stamps, "repos");
    }
    // Shared dependency caches: LRU cap per root, hourly.
    if (force || stampDue(stamps, "caps", HOUR)) {
      out.caps.push(capPrune(conf.internalRoot, conf, { cargoHome: cargoHome(env), dryRun, log }));
      if (ext) out.caps.push(capPrune(conf.externalCache, conf, { dryRun, log }));
      if (!dryRun) stampTouch(stamps, "caps");
    }
    out.trash.push(...sweepTrash(conf.internalRoot, { dryRun }));
    if (ext) out.trash.push(...sweepTrash(conf.externalCache, { dryRun }));
    return out;
  });
  return res;
}

export function sessionEnd(input, harness, env = process.env) {
  const conf = loadConf(env);
  const key = sessionKey(harness, input?.session_id);
  if (!key) return { key: null };
  markEnded(env, key);
  const s = { key, ...readPin(env, key) };
  const others = classify(conf, env).filter((x) => x.key !== key && !x.done);
  const liveProjects = new Set(others.map((x) => x.meta?.projectRoot).filter(Boolean));
  const r = reapSession(conf, env, s, { log: (m) => appendLog(logPath(env), m), liveProjects });
  return { key, ...r };
}

export { layout };
