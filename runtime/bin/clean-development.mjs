#!/usr/bin/env node
// clean-development 0.6.0 CLI. Read-only unless a command says --apply or --write.
//   status [--json] [--sizes]        mode, roots, free space, sessions, dot-folders, dead 4TB links
//   doctor [--json] [--no-gui]       installation health; exit 1 on any failure
//   housekeeping [--apply] [--json]  what the Stop hook does (forced, all throttles ignored); preview by default
//   reap [--apply] [--json]          finished-session cleanup only; preview by default
//   codex-trust [--hooks F] [--apply [--config F]]  print, or write into ~/.codex/config.toml, trusted_hash tables
//                                    for every hook in ~/.codex/hooks.json (no /hooks review click needed)
//   init [--write] [DIR]             print (or write) a schema v2 .clean-development.json for DIR (default: cwd)
//   migrate [--write] [DIR]          convert a schema v1 .clean-development.json in DIR to v2
//   run [--session X] -- CMD [ARGS]  compatibility shim for 0.5.0-era repo docs: ignores --session and execs CMD unchanged
//   hook <session-start|stop|session-end> <claude|codex>   same as bin/cd-hook (stdin JSON)
//   version
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { VERSION, homeDir, loadConf } from "../lib/conf.mjs";
import { detect, fmtGB, freeBytes, layout, rootExtras } from "../lib/storage.mjs";
import { classify, reapAll } from "../lib/sessions.mjs";
import { stop } from "../lib/hook.mjs";
import { doctor } from "../lib/doctor.mjs";
import { applyTrust, trustEntries, trustToml } from "../lib/codex-trust.mjs";
import { CONFIG, detectDirs, loadProjectConfig, migrateV1, SCHEMA_URL, sourceRepos } from "../lib/project.mjs";
import { dotReport } from "../lib/dots.mjs";
import { sizeBytes } from "../lib/fsutil.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0] || "status";
const flag = (f) => argv.includes(f);
const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const positional = argv.slice(1).filter((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--hooks");
const print = (obj, text) => console.log(flag("--json") ? JSON.stringify(obj, null, 1) : text);

function status() {
  const conf = loadConf();
  const home = homeDir();
  const d = detect(conf, process.env, { probe: false, create: false });
  const l = layout(d.root);
  const sessions = classify(conf, process.env);
  const dots = dotReport(conf, home);
  const { dead } = sourceRepos(home);
  const sd = conf.sdVolume && fs.existsSync(`/Volumes/${conf.sdVolume}`) ? `/Volumes/${conf.sdVolume}` : null;
  const sizes = flag("--sizes") ? Object.fromEntries(["deps", "builds", "scratch", "trash"].map((k) => [k, sizeBytes(l[k])])) : null;
  const extras = rootExtras(d.root, { sizes: flag("--sizes") });
  const obj = { version: VERSION, mode: d.mode, reason: d.reason, root: d.root, free: freeBytes(d.root), internalRoot: conf.internalRoot,
    externalCache: conf.externalCache, sd, sizes, sessions: sessions.map((s) => ({ key: s.key, mode: s.mode, done: s.done, ended: s.ended, idleHours: Math.round(s.idleMs / 36e5) })),
    rootExtras: extras, dotFolders: dots.folders, dotFiles: dots.files, deadSourceLinks: dead, confErrors: conf.errors };
  const lines = [
    `clean-development ${VERSION}  mode=${d.mode} (${d.reason})`,
    `root ${d.root}  free ${fmtGB(obj.free)}`,
    sizes ? `sizes: ${Object.entries(sizes).map(([k, v]) => `${k} ${fmtGB(v)}`).join(", ")}` : null,
    `sessions: ${sessions.length} (${sessions.filter((s) => !s.done).length} live)`,
    sd ? `optional slow storage: ${sd} (not used for routing or backups)` : null,
    extras.length ? `unmanaged entries at the top of ${d.root} (outside the cap and pruning): ${extras.map((x) => (x.bytes === null ? x.name : `${x.name} (${fmtGB(x.bytes)})`)).join(" ")}` : null,
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
  const n = (a) => (a || []).length;
  const caps = r.caps.map((c) => `${c.root}: ${fmtGB(c.totalBytes)} -> ${fmtGB(c.afterBytes)} (cap ${fmtGB(c.capBytes)}, evict ${c.evicted.length})`);
  return [
    `sessions reaped ${n(r.reap.reaped)}, live ${n(r.reap.live)}, orphan scratch ${n(r.reap.orphans)}`,
    `internal idle builds ${n(r.internalIdle)}, last-out wipe ${n(r.lastOut)}, external builds >${loadConf().EXTERNAL_BUILD_DAYS}d ${n(r.external)}, repo dirs ${n(r.repos)}`,
    ...caps,
    `trash swept ${n(r.trash)}`
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
      const res = stop({}, "claude", process.env, { force: true, dryRun: !flag("--apply") });
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
      const file = opt("--hooks") || path.join(homeDir(), ".codex", "hooks.json");
      const doc = JSON.parse(fs.readFileSync(file, "utf8"));
      const entries = trustEntries(file, doc);
      if (!flag("--apply")) { process.stdout.write(trustToml(entries)); return 0; }
      const cfg = opt("--config") || path.join(homeDir(), ".codex", "config.toml");
      const before = fs.readFileSync(cfg, "utf8");
      const backup = path.join(homeDir(), "dev", "machine", "state", "clean-development", "backup", `config.toml.${Date.now()}`);
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.writeFileSync(backup, before, { mode: 0o600 });
      const after = applyTrust(before, file, entries);
      const tmp = `${cfg}.cd-${process.pid}`;
      fs.writeFileSync(tmp, after, { mode: fs.statSync(cfg).mode & 0o777 });
      fs.renameSync(tmp, cfg);
      console.log(`trusted ${entries.length} hook(s) from ${file} in ${cfg} (backup ${backup})`);
      return 0;
    }
    case "init":
    case "migrate": {
      const dir = path.resolve(positional[0] || process.cwd());
      const existing = loadProjectConfig(dir);
      let config;
      if (cmd === "migrate") {
        if (!existing) { console.error(`no ${CONFIG} in ${dir}`); return 1; }
        if (existing.version === 2 && existing.ok) { console.log(`${existing.file} is already schema v2`); return 0; }
        const raw = JSON.parse(fs.readFileSync(existing.file, "utf8"));
        config = migrateV1(raw, dir).config;
      } else {
        if (existing && flag("--write")) { console.error(`${existing.file} exists; use migrate`); return 1; }
        const det = detectDirs(dir);
        config = { $schema: SCHEMA_URL, schemaVersion: 2, enabled: true, heavy: false, buildDirs: det.buildDirs, depDirs: det.depDirs };
      }
      const text = JSON.stringify(config, null, 2) + "\n";
      if (flag("--write")) { fs.writeFileSync(path.join(dir, CONFIG), text); console.log(`wrote ${path.join(dir, CONFIG)}`); }
      else process.stdout.write(text);
      return 0;
    }
    case "run": {
      // Stale per-repo AGENTS.md text from 0.5.0 says `clean-development run --session session-only -- <command>`. The
      // routing now comes from env.zsh, so the shim only runs the command; it adds no policy.
      const sep = argv.indexOf("--");
      if (sep < 0 || sep === argv.length - 1) { console.error("usage: clean-development run [--session X] -- COMMAND [ARGS]"); return 2; }
      const r = spawnSync(argv[sep + 1], argv.slice(sep + 2), { stdio: "inherit" });
      if (r.error) { console.error(`clean-development run: ${r.error.message}`); return 127; }
      return r.status ?? (r.signal ? 128 : 1);
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

const code = await main();
if (code !== null) process.exitCode = code;
