#!/usr/bin/env node
// clean-development CLI. Read-only unless a command says --apply or --write.
//   status [--json] [--sizes]        mode, roots, free space, sessions, dot-folders, dead 4TB links
//   doctor [--json] [--no-gui]       installation health; exit 1 on any failure
//   housekeeping [--apply] [--json]  what the Stop hook does (forced, all throttles ignored); preview by default
//   reap [--apply] [--json]          finished-session cleanup only; preview by default
//   codex-trust [--hooks F] [--apply [--config F]]  print, or write into ~/.codex/config.toml, trusted_hash tables
//                                    for managed CD hooks; --all explicitly includes unrelated handlers
//   leases [list|create --path ABS [--path ABS] [--minutes N]|renew ID|release ID] [--apply]
//   publish --source FILE --destination FILE [--kind work|evidence] [--apply]
//   locks [--recover lifecycle|housekeeping --apply]     no age-based lock takeover
//   init [--write] [DIR]             print (or write) a schema v2 .clean-development.json for DIR (default: cwd)
//   migrate [--write] [DIR]          convert a schema v1 .clean-development.json in DIR to v2
//   run [--session X] -- CMD [ARGS]  compatibility shim for 0.5.0-era repo docs: ignores --session and execs CMD unchanged
//   hook <session-start|stop|session-end> <claude|codex>   same as bin/cd-hook (stdin JSON)
//   version
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { randomUUID } from "node:crypto";
import { VERSION, homeDir, loadConf } from "../lib/conf.mjs";
import { detect, fmtGB, freeBytes, layout, rootExtras, rootFor } from "../lib/storage.mjs";
import { classify, lifecycleLock, readPin, reapAll, sessionKey } from "../lib/sessions.mjs";
import { stop } from "../lib/hook.mjs";
import { doctor } from "../lib/doctor.mjs";
import { applyTrust, managedTrustEntries, trustEntries, trustToml } from "../lib/codex-trust.mjs";
import { CONFIG, detectDirs, loadProjectConfig, migrateV1, SCHEMA_URL, sourceRepos } from "../lib/project.mjs";
import { dotReport } from "../lib/dots.mjs";
import { sizeBytes, withLock, writeFileAtomic } from "../lib/fsutil.mjs";
import { createLease, readLeases, updateLease } from "../lib/leases.mjs";
import { publishFile } from "../lib/publish.mjs";
import { inspectLocks, recoverLock } from "../lib/locks.mjs";

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
  const conf = loadConf();
  const home = homeDir();
  const d = detect(conf, process.env, { probe: false, create: false });
  const currentKey = process.env.CLAUDE_CODE_SESSION_ID ? sessionKey("claude", process.env.CLAUDE_CODE_SESSION_ID) : sessionKey("codex", process.env.CODEX_THREAD_ID);
  const pin = currentKey ? readPin(process.env, currentKey) : null;
  const mode = pin?.mode === "internal" ? "internal" : d.mode;
  const root = rootFor(conf, mode), reason = pin?.mode ? `pinned ${pin.mode}; availability now ${d.mode}: ${d.reason}` : d.reason;
  const l = layout(root);
  const sessions = classify(conf, process.env);
  const dots = dotReport(conf, home);
  const { dead } = sourceRepos(home);
  const sd = conf.sdVolume && fs.existsSync(`/Volumes/${conf.sdVolume}`) ? `/Volumes/${conf.sdVolume}` : null;
  const sizes = flag("--sizes") ? Object.fromEntries(["deps", "builds", "scratch", "trash"].map((k) => [k, sizeBytes(l[k])])) : null;
  const extras = rootExtras(root, { sizes: flag("--sizes") });
  const obj = { version: VERSION, mode, availableMode: d.mode, currentSession: currentKey, reason, root, free: freeBytes(root), internalRoot: conf.internalRoot,
    externalCache: conf.externalCache, sd, sizes, sessions: sessions.map((s) => ({ key: s.key, mode: s.mode, effectiveMode: s.mode === "internal" ? "internal" : d.mode, lastHookMode: s.meta?.mode || null,
      generation: s.meta?.generation || null, ownedRoots: s.meta?.ownedRoots || [], errors: s.errors, done: s.done, ended: s.ended,
      idleHours: Number.isFinite(s.idleMs) ? Math.round(s.idleMs / 36e5) : null })),
    leases: readLeases(process.env), locks: inspectLocks(process.env),
    support: { claude: "native lifecycle", codex: "native lifecycle", opencode: "environment-only; native lifecycle not supported" },
    rootExtras: extras, dotFolders: dots.folders, dotFiles: dots.files, deadSourceLinks: dead, confErrors: conf.errors };
  const lines = [
    `clean-development ${VERSION}  mode=${mode} (${reason})`,
    `root ${root}  free ${fmtGB(obj.free)}`,
    sizes ? `sizes: ${Object.entries(sizes).map(([k, v]) => `${k} ${fmtGB(v)}`).join(", ")}` : null,
    `sessions: ${sessions.length} (${sessions.filter((s) => !s.done).length} live)`,
    sd ? `optional slow storage: ${sd} (not used for routing or backups)` : null,
    extras.length ? `unmanaged entries at the top of ${root} (outside the cap and pruning): ${extras.map((x) => (x.bytes === null ? x.name : `${x.name} (${fmtGB(x.bytes)})`)).join(" ")}` : null,
    dots.folders.length ? `unexpected dot-folders: ${dots.folders.join(" ")}` : "dot-folders: none unexpected",
    dots.files.length ? `unexpected dot-files: ${dots.files.join(" ")}` : null,
    dead.length ? `dead links in ~/dev/source (expected while the 4TB is away): ${dead.map((x) => x.name).join(" ")}` : null,
    conf.errors.length ? `storage.conf: ${conf.errors.join("; ")}` : null
  ].filter(Boolean);
  print(obj, lines.join("\n"));
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
      const r = doctor(process.env, { gui: !flag("--no-gui") });
      print(r, r.results.map((x) => `${x.ok ? "ok  " : "FAIL"} ${x.name}: ${x.detail}`).join("\n"));
      return r.ok ? 0 : 1;
    }
    case "housekeeping": {
      const res = stop({}, "claude", process.env, { force: true, dryRun: !flag("--apply"), budgetMs: 30000 });
      print(res, (flag("--apply") ? "" : "preview (add --apply):\n") + summarise(res));
      return 0;
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
      const r = withLock(lifecycleLock(process.env), perform);
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
    case "run": {
      // Stale per-repo AGENTS.md text from 0.5.0 says `clean-development run --session session-only -- <command>`. The
      // routing now comes from env.zsh, so the shim only runs the command; it adds no policy.
      const sep = argv.indexOf("--");
      if (sep < 0 || sep === argv.length - 1) { console.error("usage: clean-development run [--session X] -- COMMAND [ARGS]"); return 2; }
      return await new Promise((resolve) => {
        const child = spawn(argv[sep + 1], argv.slice(sep + 2), { stdio: "inherit" });
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
