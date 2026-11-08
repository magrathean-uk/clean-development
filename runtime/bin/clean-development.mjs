#!/usr/bin/env node
// clean-development CLI. Read-only unless a command says --apply, --write or sizes --refresh.
//   status [--json] [--sizes]        mode, roots, free space, sessions, dot-folders, unavailable external links
//   sizes [--refresh] [--json]       cached measurements; refresh explicitly writes state
//   doctor [--json] [--gui] [--no-gui] installation health; GUI checks opt in with --gui
//   housekeeping [--apply] [--json]  what the Stop hook does (forced, all throttles ignored); preview by default
//   reap [--apply] [--json]          finished-session cleanup only; preview by default
//   codex-trust [--hooks F] [--apply [--config F]]  print, or write into ~/.codex/config.toml, trusted_hash tables
//                                    for managed CD hooks; --all explicitly includes unrelated handlers
//   leases [list|create --path ABS [--path ABS] [--minutes N]|renew ID|release ID] [--apply]
//   publish --source FILE --destination FILE [--kind work|evidence] [--apply]
//   locks [--recover lifecycle|housekeeping|lock-recovery --apply]  no age-based takeover; reboot-orphaned locks auto-reclaim
//   init [--write] [DIR]             print (or write) a schema v2 .clean-development.json for DIR (default: cwd)
//   migrate [--write] [DIR]          convert a schema v1 .clean-development.json in DIR to v2
//   run [--session X] [--clean-env [--keep NAME]...] -- CMD [ARGS]
//                                    runs CMD; --clean-env passes only HOME/PATH/locale and the storage routing (no
//                                    CLAUDE_*, CODEX_*, OP_SESSION_*, tokens, keys or SSH agent), keeping the session's
//                                    TMPDIR and builds; --keep adds CODEX_HOME, CLAUDE_CONFIG_DIR or SSH_AUTH_SOCK
//   env --child [--format sh|json|null] [--keep NAME]...   print that clean child environment
//   prune --project DIR [--apply] [--json]   builds whose .owner.json names DIR; preview by default, honours leases
//   vm move colima|lima|tart [--from DIR] [--experimental --apply] [--json]   EXPERIMENTAL sparse move to the external lab
//   hook <session-start|stop|session-end> <claude|codex>   same as bin/cd-hook (stdin JSON)
//   version
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { randomUUID } from "node:crypto";
import { VERSION, homeDir, loadConf } from "../lib/conf.mjs";
import { detect, fmtGB, freeBytes, layout, rootExtras, rootFor } from "../lib/storage.mjs";
import { classify, readPin, reapAll, sessionKey } from "../lib/sessions.mjs";
import { stop } from "../lib/hook.mjs";
import { doctor } from "../lib/doctor.mjs";
import { applyTrust, managedTrustEntries, trustEntries, trustToml, verifyTrustEdit } from "../lib/codex-trust.mjs";
import { CONFIG, detectDirs, loadProjectConfig, migrateV1, SCHEMA_URL, sourceRepos } from "../lib/project.mjs";
import { dotReport } from "../lib/dots.mjs";
import { sizeBytes, writeFileAtomic } from "../lib/fsutil.mjs";
import { createLease, readLeases, updateLease } from "../lib/leases.mjs";
import { publishFile } from "../lib/publish.mjs";
import { inspectLocks, recoverLock, withLifecycleLock } from "../lib/locks.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0] || "status";
const flag = (f) => argv.includes(f);
const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const positional = argv.slice(1).filter((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--hooks");
const print = (obj, text) => console.log(flag("--json") ? JSON.stringify(obj, null, 1) : text);

function checkOptions(args, booleanFlags, valueFlags) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (booleanFlags.includes(a)) continue;
    if (valueFlags.includes(a)) {
      if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`${a} needs a value`);
      i++; continue;
    }
    throw new Error(`unknown argument: ${a}`);
  }
}

function status() {
  const lib = (name) => JSON.stringify(new URL(`../lib/${name}.mjs`, import.meta.url).href);
  const code = `
    import fs from "node:fs";
    import { VERSION, homeDir, loadConf } from ${lib("conf")};
    import { detect, freeBytes, internalFreeBytes, rootFor, workRoot } from ${lib("storage")};
    import { classify, readPin, sessionKey } from ${lib("sessions")};
    import { inventoryExtras } from ${lib("inventory")};
    import { readSizeCache } from ${lib("sizes")};
    import { dotReport } from ${lib("dots")};
    import { sourceRepos } from ${lib("project")};
    import { readLeases } from ${lib("leases")};
    import { inspectLocks } from ${lib("locks")};
    const deadline = Date.now() + 11000;
    const send = (stage, data) => console.log(JSON.stringify({ stage, data }));
    const conf = loadConf(), env = process.env, home = homeDir(), d = detect(conf, env, { probe: false, create: false });
    const inherited = env.CLEAN_DEV_SESSION && (env.CLEAN_DEV_STAMP || "").endsWith("|" + env.CLEAN_DEV_SESSION) ? env.CLEAN_DEV_SESSION : null;
    const currentKey = env.CLAUDE_CODE_SESSION_ID ? sessionKey("claude", env.CLAUDE_CODE_SESSION_ID) : env.CODEX_THREAD_ID ? sessionKey("codex", env.CODEX_THREAD_ID) : inherited;
    // Storage follows the drive: a shell started now routes by availability, whatever the session used before.
    const pin = currentKey ? readPin(env, currentKey) : null, mode = d.mode;
    const root = rootFor(conf, mode), cache = readSizeCache(env);
    send("base", { version: VERSION, mode, availableMode: d.mode, currentSession: currentKey,
      reason: pin?.mode ? "session started " + pin.mode + "; new shells use " + d.mode + ": " + d.reason : d.reason,
      root, free: freeBytes(root), internalFree: internalFreeBytes(conf, env), internalMinFreeGB: conf.INTERNAL_MIN_FREE_GB,
      work: workRoot(conf, d.mode, env), internalRoot: conf.internalRoot, externalCache: conf.externalCache,
      sd: conf.sdVolume && fs.existsSync("/Volumes/" + conf.sdVolume) ? "/Volumes/" + conf.sdVolume : null,
      sizes: ${flag("--sizes")} && cache ? Object.fromEntries(["deps", "builds", "scratch", "trash"].map((k) => [k, cache.roots[root]?.[k] ?? null])) : null,
      sizesMeasuredAt: cache?.measuredAt || null, sizesDurationMs: cache?.durationMs ?? null, confErrors: conf.errors });
    for (const [stage, inspect] of [
      ["extras", () => inventoryExtras(conf, env, { sizes: cache, deadline })],
      ["dots", () => dotReport(conf, home)],
      ["source", () => sourceRepos(home)],
      ["leases", () => readLeases(env)],
      ["locks", () => inspectLocks(env)],
      ["sessions", () => classify(conf, env, Date.now(), { deadline }).map((s) => ({ key: s.key, mode: s.mode,
        effectiveMode: d.mode, lastHookMode: s.meta?.mode || null,
        generation: s.meta?.generation || null, ownedRoots: s.meta?.ownedRoots || [], errors: s.errors, done: s.done, ended: s.ended,
        liveReason: s.liveReason, rejected: s.rejected, modeReason: s.meta?.modeReason || null, owner: s.meta?.owner || null,
        idleHours: Number.isFinite(s.idleMs) ? Math.round(s.idleMs / 36e5) : null }))]
    ]) {
      if (Date.now() >= deadline) { send("incomplete", stage); continue; }
      try { const data = inspect(); send(stage, data); if (Date.now() >= deadline || data?.incomplete) send("incomplete", stage); }
      catch { send("incomplete", stage); }
    }
  `;
  const stages = {}, incomplete = new Set(), expected = ["base", "extras", "dots", "source", "leases", "locks", "sessions"];
  let buffer = "", finished = false, timer;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", code], { env: process.env, stdio: ["ignore", "pipe", "ignore"] });
  child.stdout.setEncoding("utf8");
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    child.kill("SIGKILL"); child.stdout.destroy(); child.unref();
    for (const name of expected) if (!Object.hasOwn(stages, name)) incomplete.add(name);
    const obj = { version: VERSION, ...stages.base, sessions: stages.sessions || [], leases: stages.leases || null, locks: stages.locks || [],
      support: { claude: "native lifecycle", codex: "native lifecycle", opencode: "environment-only; native lifecycle not supported" },
      inventory: stages.extras || null, rootExtras: stages.extras?.[stages.base?.root === stages.base?.internalRoot ? "internal" : "external"] || [],
      dotFolders: stages.dots?.folders || [], dotFiles: stages.dots?.files || [], deadSourceLinks: stages.source?.dead || [], incomplete: [...incomplete] };
    const lines = [
      `clean-development ${VERSION}  mode=${obj.mode || "unknown"} (${obj.reason || "inspection incomplete"})`,
      obj.root ? `root ${obj.root}  free ${fmtGB(obj.free)}` : null,
      flag("--sizes") ? obj.sizesMeasuredAt ? `sizes from ${obj.sizesMeasuredAt} (${Math.max(0, Math.floor((Date.now() - Date.parse(obj.sizesMeasuredAt)) / 36e5))} h old)` : "sizes unknown: run clean-development sizes --refresh" : null,
      flag("--sizes") && obj.sizes ? `sizes: ${Object.entries(obj.sizes).map(([k, v]) => `${k} ${fmtGB(v)} (${v ?? "unknown"} bytes)`).join(", ")}` : null,
      `sessions: ${obj.sessions.length} (${obj.sessions.filter((s) => !s.done).length} live${(() => {
        const by = {}; for (const s of obj.sessions) if (!s.done && s.liveReason) { const k = s.liveReason.replace(/ \d+.*$|\s*\(.*$/, ""); by[k] = (by[k] || 0) + 1; }
        return Object.keys(by).length ? ": " + Object.entries(by).map(([k, n]) => `${n} ${k}`).join(", ") : ""; })()})`,
      obj.work ? `work root CLEAN_DEV_WORK=${obj.work} (worktrees, jobs, bundles)` : null,
      Number.isFinite(obj.internalFree) && obj.internalFree < obj.internalMinFreeGB * 1024 ** 3 ? `internal free space ${fmtGB(obj.internalFree)} is below the configured ${obj.internalMinFreeGB} GB warning threshold` : null,
      obj.sessions.some((s) => s.rejected) ? `rejected session keys (no new routing; reaped after 7 quiet days): ${obj.sessions.filter((s) => s.rejected).map((s) => s.key).join(" ")}` : null,
      obj.sessions.some((s) => !s.done && /^unobserved/.test(s.liveReason || "") && s.idleHours > 7 * 24) ? `unobserved for over 7 days (kept up to 30; inspect or lease): ${obj.sessions.filter((s) => !s.done && /^unobserved/.test(s.liveReason || "") && s.idleHours > 7 * 24).map((s) => s.key).join(" ")}` : null,
      obj.sd ? `optional slow storage: ${obj.sd} (not used for routing or backups)` : null,
      ...obj.rootExtras.map((x) => `unmanaged ${x.name}: ${x.bytes === null ? "size unknown" : `${fmtGB(x.bytes)} (${x.bytes} bytes)`}; owner ${typeof x.owner === "object" && x.owner ? JSON.stringify(x.owner) : x.owner || "unknown"}${x.misplaced ? " MISPLACED" : ""}${x.overCap ? " OVER 1 GB" : ""}`),
      obj.dotFolders.length ? `unexpected dot-folders: ${obj.dotFolders.join(" ")}` : "dot-folders: none unexpected",
      obj.dotFiles.length ? `unexpected dot-files: ${obj.dotFiles.join(" ")}` : null,
      obj.deadSourceLinks.length ? `dead links in ~/dev/source (external storage may be unavailable): ${obj.deadSourceLinks.map((x) => x.name).join(" ")}` : null,
      obj.confErrors?.length ? `storage.conf: ${obj.confErrors.join("; ")}` : null,
      incomplete.size ? `incomplete: ${[...incomplete].join(", ")}` : null
    ].filter(Boolean);
    print(obj, lines.join("\n"));
  };
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    if (buffer.length > 8 * 1024 ** 2) { incomplete.add("inspection output limit"); finish(); return; }
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      try { const item = JSON.parse(line); if (item.stage === "incomplete") incomplete.add(item.data); else stages[item.stage] = item.data; }
      catch { incomplete.add("inspection output"); }
    }
  });
  child.on("error", finish);
  child.on("close", finish);
  timer = setTimeout(finish, 13000);
}

function summarise(res) {
  if (res.locked) return "another housekeeping run holds the lock; nothing done";
  const r = res.result;
  if (r.skipped) return `cleanup skipped: ${r.skipped}`;
  const n = (a) => (a || []).length;
  const caps = r.caps.map((c) => `${c.root}: measured deps ${fmtGB(c.totalBytes)}, selected after ${fmtGB(c.afterBytes)} (cap ${fmtGB(c.capBytes)}, queued ${c.evicted.length}${c.skipped ? `; skipped: ${c.skipped}` : ""}); not a free-space receipt`);
  return [
    `session cleanup attempts ${n(r.reap.reaped)}, deferred/skipped ${r.reap.reaped.filter((s) => s.deferred || s.skipped).length}; live ${n(r.reap.live)}, orphan selections ${n(r.reap.orphans)}`,
    `build/repo selections: internal idle ${n(r.internalIdle)}, last-out ${n(r.lastOut)}, external >${loadConf().EXTERNAL_BUILD_DAYS}d ${n(r.external)}, repo dirs ${n(r.repos)}`,
    ...caps,
    `trash retries queued ${n(r.trash)}`,
    r.timedOut ? "budget exhausted; remaining cleanup deferred, not completed" : "",
    r.repoBlocked?.length ? `repo cleanup deferred: ${r.repoBlocked.map((r) => `${r.project}: ${r.reason}`).join("; ")}; retry remains due` : "",
    r.projectCleanupSkipped || ""
  ].join("\n");
}

async function main() {
  switch (cmd) {
    case "version": console.log(VERSION); return 0;
    case "status": status(); return 0;
    case "doctor": {
      const r = doctor(process.env, { gui: flag("--gui") && !flag("--no-gui") });
      print(r, r.results.map((x) => `${x.warn ? "WARN" : x.ok ? "ok  " : "FAIL"} ${x.name}: ${x.detail}`).join("\n"));
      return r.ok ? 0 : 1;
    }
    case "housekeeping": {
      const res = stop({}, "claude", process.env, { force: true, dryRun: !flag("--apply"), budgetMs: 30000 });
      const { inventoryExtras } = await import("../lib/inventory.mjs");
      const { readSizeCache, spawnSizeRefresh } = await import("../lib/sizes.mjs");
      const extras = inventoryExtras(loadConf(), process.env, { sizes: readSizeCache() });
      const lines = Object.values(extras).flat().map((x) => `${x.name}: ${x.bytes === null ? "size unknown" : fmtGB(x.bytes)}; owner ${typeof x.owner === "object" && x.owner ? JSON.stringify(x.owner) : x.owner || "unknown"}${x.misplaced ? " MISPLACED" : ""}${x.overCap ? " OVER 1 GB" : ""}`);
      print({ ...res, inventory: extras }, (flag("--apply") ? "" : "preview (add --apply):\n") + summarise(res) + (lines.length ? "\n" + lines.join("\n") : ""));
      if (flag("--apply")) spawnSizeRefresh();
      return 0;
    }
    case "sizes": {
      checkOptions(argv.slice(1), ["--refresh", "--json"], []);
      const { readSizeCache, refreshSizes } = await import("../lib/sizes.mjs");
      const cache = flag("--refresh") ? refreshSizes(loadConf(), process.env) : readSizeCache();
      if (!cache) { print(null, "sizes unknown: run clean-development sizes --refresh"); return 0; }
      const lines = [`sizes from ${cache.measuredAt} (${Math.max(0, Math.floor((Date.now() - Date.parse(cache.measuredAt)) / 36e5))} h old)`];
      for (const [root, row] of Object.entries(cache.roots)) {
        for (const k of ["deps", "builds", "scratch", "trash"]) lines.push(`${root}/${k}: ${fmtGB(row[k])} (${row[k] ?? "unknown"} bytes)`);
        for (const [name, n] of Object.entries(row.extras)) lines.push(`${root}/${name}: ${fmtGB(n)} (${n ?? "unknown"} bytes)`);
      }
      for (const [p, n] of Object.entries(cache.trash)) lines.push(`pending Trash ${p}: ${fmtGB(n)} (${n ?? "unknown"} bytes)`);
      print(cache, lines.join("\n")); return 0;
    }
    case "reap": {
      const conf = loadConf();
      const r = reapAll(conf, process.env, { dryRun: !flag("--apply") });
      print(r, `${flag("--apply") ? "" : "preview (add --apply): "}reaped ${r.reaped.length}, live ${r.live.length}, orphans ${r.orphans.length}`);
      return 0;
    }
    case "codex-trust": {
      checkOptions(argv.slice(1), ["--apply", "--all"], ["--hooks", "--config"]);
      const file = opt("--hooks") || path.join(homeDir(), ".codex", "hooks.json");
      const doc = JSON.parse(fs.readFileSync(file, "utf8"));
      const entries = flag("--all") ? trustEntries(file, doc) : managedTrustEntries(file, doc);
      if (!flag("--apply")) { process.stdout.write(trustToml(entries)); return 0; }
      if (!entries.length) { console.log("no managed handlers selected; nothing written (use --all only after explicit broader review)"); return 0; }
      const cfg = opt("--config") || path.join(homeDir(), ".codex", "config.toml");
      const st = fs.lstatSync(cfg);
      if (!st.isFile() || st.isSymbolicLink()) throw new Error("refusing a linked or non-regular config target");
      const before = fs.readFileSync(cfg, "utf8");
      const after = applyTrust(before, file, entries);
      if (after === before) { console.log("hook trust unchanged; nothing written"); return 0; }
      verifyTrustEdit(before, after, entries);
      const backup = path.join(homeDir(), "dev", "machine", "state", "clean-development", "backup", `config.toml.${randomUUID()}`);
      fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
      writeFileAtomic(backup, before, 0o600, { durable: true });
      if (fs.readFileSync(cfg, "utf8") !== before) throw new Error("config changed during trust review; nothing replaced, recovery copy retained");
      writeFileAtomic(cfg, after, st.mode & 0o777, { durable: true });
      console.log(`trusted ${entries.length} hook(s) from ${file} in ${cfg} (backup ${backup})`);
      return 0;
    }
    case "leases": {
      const action = argv[1] || "list";
      if (action === "list") {
        checkOptions(argv.slice(2), ["--json"], []);
        const r = readLeases(process.env); console.log(JSON.stringify(r, null, 2)); return r.errors.length ? 1 : 0;
      }
      if (!["create", "renew", "release"].includes(action)) throw new Error("usage: leases [list|create --path ABS [--path ABS] [--minutes N] [--owner LABEL]|renew ID [--minutes N]|release ID] --apply");
      checkOptions(argv.slice(action === "create" ? 2 : 3), action === "release" ? ["--apply", "--json", "--recovery-confirmed"] : ["--apply", "--json"], action === "create" ? ["--path", "--minutes", "--owner"] : action === "renew" ? ["--minutes"] : []);
      const minutes = Number(opt("--minutes") ?? 60);
      const paths = argv.flatMap((v, i) => v === "--path" ? [argv[i + 1]] : []);
      const perform = () => action === "create"
        ? createLease(loadConf(), process.env, paths, { minutes, owner: opt("--owner") || "manual job", dryRun: !flag("--apply") })
        : updateLease(process.env, argv[2], { release: action === "release", minutes, dryRun: !flag("--apply"), recoveryConfirmed: flag("--recovery-confirmed") });
      if (!flag("--apply")) { console.log(JSON.stringify(perform(), null, 2)); return 0; }
      const r = withLifecycleLock(process.env, perform);
      if (r.locked) throw new Error("lifecycle locked; lease was NOT acquired/renewed/released; do not start unprotected work");
      console.log(JSON.stringify(r.result, null, 2)); return 0;
    }
    case "publish": {
      checkOptions(argv.slice(1), ["--apply", "--json"], ["--source", "--destination", "--kind"]);
      const r = publishFile(loadConf(), process.env, opt("--source"), opt("--destination"), { kind: opt("--kind") || "evidence", apply: flag("--apply") });
      console.log(JSON.stringify(r, null, 2)); return 0;
    }
    case "locks": {
      checkOptions(argv.slice(1), ["--apply", "--json"], ["--recover"]);
      if (flag("--apply") && !opt("--recover")) throw new Error("--apply requires --recover NAME");
      const r = opt("--recover") ? recoverLock(process.env, opt("--recover"), { apply: flag("--apply") }) : inspectLocks(process.env);
      console.log(JSON.stringify(r, null, 2)); return 0;
    }
    case "init":
    case "migrate": {
      const dir = path.resolve(positional[0] || process.cwd());
      const existing = loadProjectConfig(dir);
      let config;
      if (cmd === "migrate") {
        if (!existing) { console.error(`no ${CONFIG} in ${dir}`); return 1; }
        if (existing.version === 2 && existing.ok) { console.log(`${existing.file} is already schema v2`); return 0; }
        if (existing.version !== 1 || !existing.ok) { console.error(`refusing migration of invalid or non-v1 ${existing.file}; repair it without losing existing settings`); return 1; }
        const raw = JSON.parse(fs.readFileSync(existing.file, "utf8"));
        config = migrateV1(raw, dir).config;
      } else {
        if (existing && flag("--write")) { console.error(`${existing.file} exists; use migrate`); return 1; }
        const det = detectDirs(dir);
        config = { $schema: SCHEMA_URL, schemaVersion: 2, enabled: true, heavy: false, buildDirs: det.buildDirs, depDirs: det.depDirs };
      }
      const text = JSON.stringify(config, null, 2) + "\n";
      if (flag("--write")) {
        if (cmd === "migrate") fs.copyFileSync(existing.file, `${existing.file}.v1-backup-${Date.now()}`, fs.constants.COPYFILE_EXCL);
        fs.writeFileSync(path.join(dir, CONFIG), text); console.log(`wrote ${path.join(dir, CONFIG)}`);
      }
      else process.stdout.write(text);
      return 0;
    }
    case "env": {
      checkOptions(argv.slice(1), ["--child"], ["--format", "--keep"]);
      if (!flag("--child")) throw new Error("usage: clean-development env --child [--format sh|json|null] [--keep NAME]...");
      const { childEnv, formatEnv } = await import("../lib/childenv.mjs");
      const clean = childEnv(process.env, { keep: argv.flatMap((v, i) => v === "--keep" ? [argv[i + 1]] : []) });
      if (clean.refused.length) console.error(`clean-development env: not passed to children: ${clean.refused.join(" ")}`);
      process.stdout.write(formatEnv(clean, opt("--format") || "sh"));
      return 0;
    }
    case "prune": {
      checkOptions(argv.slice(1), ["--apply", "--json"], ["--project"]);
      if (!opt("--project")) throw new Error("usage: clean-development prune --project DIR [--apply] [--json]");
      const { pruneProject } = await import("../lib/owners.mjs");
      const r = pruneProject(loadConf(), process.env, path.resolve(opt("--project")), { apply: flag("--apply"), deadline: Date.now() + 30000 });
      print(r, [`${flag("--apply") ? "" : "preview (add --apply): "}project ${r.repo}`,
        ...r.candidates.map((c) => `${flag("--apply") ? "selected" : "would move to trash"} ${c.path} (${c.key || "no key"})`),
        ...r.skipped.map((x) => `skipped ${x.path}: ${x.reason}`), flag("--apply") ? `queued ${r.removed.length}; deletion completes in the background (deletions.jsonl)` : ""].filter(Boolean).join("\n"));
      return 0;
    }
    case "vm": {
      if (argv[1] === "colima-rehome") {
        checkOptions(argv.slice(2), ["--apply", "--json"], ["--profile", "--rollback"]);
        const { colimaRehome, colimaRehomeRollback } = await import("../lib/vm.mjs");
        const r = opt("--rollback") ? colimaRehomeRollback(loadConf(), process.env, path.resolve(opt("--rollback")), { apply: flag("--apply") })
          : colimaRehome(loadConf(), process.env, { profile: opt("--profile") || null, apply: flag("--apply") });
        print(r, `vm colima-rehome (${r.status}):\n${JSON.stringify(r, null, 2)}`);
        return 0;
      }
      if (argv[1] !== "move" || !argv[2] || argv[2].startsWith("--")) throw new Error("usage: clean-development vm move colima|lima|tart [--from DIR] [--experimental --apply] [--json] | vm colima-rehome [--profile P] [--rollback MANIFEST] [--apply] [--json]");
      checkOptions(argv.slice(3), ["--apply", "--experimental", "--json"], ["--from"]);
      const { vmMove } = await import("../lib/vm.mjs");
      const r = vmMove(loadConf(), process.env, argv[2], { from: opt("--from") ? path.resolve(opt("--from")) : undefined, apply: flag("--apply"), experimental: flag("--experimental") });
      print(r, `EXPERIMENTAL vm move ${argv[2]}:\n${JSON.stringify(r, null, 2)}`);
      return 0;
    }
    case "run": {
      // Stale per-repo AGENTS.md text from 0.5.0 says `clean-development run --session session-only -- <command>`. The
      // routing comes from env.zsh, so the shim adds no policy; --clean-env (0.6.2) replaces a hand-rolled `env -i`.
      const sep = argv.indexOf("--");
      if (sep < 0 || sep === argv.length - 1) { console.error("usage: clean-development run [--session X] [--clean-env [--keep NAME]...] -- COMMAND [ARGS]"); return 2; }
      const before = argv.slice(1, sep);
      checkOptions(before, ["--clean-env"], ["--session", "--keep"]);
      let childEnvironment = process.env;
      if (before.includes("--clean-env")) {
        const { childEnv } = await import("../lib/childenv.mjs");
        childEnvironment = childEnv(process.env, { keep: before.flatMap((v, i) => v === "--keep" ? [before[i + 1]] : []) });
        if (childEnvironment.refused.length) console.error(`clean-development run: not passed to the child: ${childEnvironment.refused.join(" ")}`);
      }
      return await new Promise((resolve) => {
        const child = spawn(argv[sep + 1], argv.slice(sep + 2), { stdio: "inherit", env: childEnvironment });
        const forwards = new Map(["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => [signal, () => { child.kill(signal); }]));
        for (const [signal, forward] of forwards) process.on(signal, forward);
        const finish = (code) => { for (const [signal, forward] of forwards) process.removeListener(signal, forward); resolve(code); };
        child.once("error", (e) => { console.error(`clean-development run: ${e.message}`); finish(127); });
        child.once("close", (code, signal) => finish(code ?? (signal ? 128 + (constants.signals[signal] || 0) : 1)));
      });
    }
    case "hook": {
      process.argv = [process.argv[0], process.argv[1], ...argv.slice(1)];
      await import("./cd-hook.mjs");
      return null;
    }
    default:
      console.error(`unknown command ${cmd}; see the header of ${new URL(import.meta.url).pathname}`);
      return 2;
  }
}

try {
  const code = await main();
  if (code !== null) process.exitCode = code;
} catch (e) { console.error(`clean-development: ${e.message}`); process.exitCode = 1; }
