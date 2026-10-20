// clean-development 0.6.0: read-only health checks for the whole installation (exit 1 when any check fails).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { VERSION, homeDir, loadConf, runtimeRoot } from "./conf.mjs";
import { detect, fmtGB, layout, rootExtras } from "./storage.mjs";
import { lstatOrNull, readJsonOrNull } from "./fsutil.mjs";
import { readTrusted, trustEntries } from "./codex-trust.mjs";
import { dotReport } from "./dots.mjs";

const EVENTS = { SessionStart: "session-start", Stop: "stop", SessionEnd: "session-end" };

export function hookCommand(env, event, harness) {
  return `'${path.join(runtimeRoot(env), VERSION, "bin", "cd-hook")}' ${EVENTS[event]} ${harness}`;
}

function commandsIn(doc) {
  const out = [];
  for (const [event, groups] of Object.entries(doc?.hooks || {})) for (const g of groups || []) for (const h of g.hooks || []) {
    if (h?.type === "command") out.push({ event, command: String(h.command || "") });
  }
  return out;
}

function checkHooks(name, file, harness, env, results) {
  const doc = readJsonOrNull(file);
  if (!doc) { results.push({ name, ok: false, detail: `${file} missing or not JSON` }); return null; }
  const cmds = commandsIn(doc);
  const missing = Object.keys(EVENTS).filter((ev) => !cmds.some((c) => c.event === ev && c.command === hookCommand(env, ev, harness)));
  const legacy = cmds.filter((c) => /clean-development\/runtime\/(?!0\.6\.0\/)|Application Support\/clean-development/.test(c.command));
  results.push({ name, ok: missing.length === 0 && legacy.length === 0,
    detail: [missing.length ? `missing ${missing.join(", ")}` : "", legacy.length ? `${legacy.length} legacy clean-development hook(s)` : ""].filter(Boolean).join("; ") || "0.6.0 hooks present" });
  return doc;
}

const sh = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8", timeout: 10000 });

export function doctor(env = process.env, { gui = true } = {}) {
  const home = homeDir(env);
  const results = [];
  const conf = loadConf(env);
  results.push({ name: "storage.conf", ok: conf.valid, detail: conf.valid ? conf.file : conf.errors.join("; ") });
  const d = detect(conf, env, { probe: true, create: false });
  results.push({ name: "storage mode", ok: true, detail: `${d.mode}: ${d.reason}` });
  const envFile = path.join(home, "dev", "machine", "env.zsh");
  let envText = "";
  try { envText = fs.readFileSync(envFile, "utf8"); } catch { /* missing */ }
  results.push({ name: "env.zsh", ok: envText.includes(`CLEAN_DEV_VERSION=${VERSION}`), detail: envFile });
  let zshenv = "";
  try { zshenv = fs.readFileSync(path.join(home, ".zshenv"), "utf8"); } catch { /* missing */ }
  results.push({ name: "~/.zshenv", ok: zshenv.includes("dev/machine/env.zsh"), detail: zshenv.includes("dev/machine/env.zsh") ? "sources ~/dev/machine/env.zsh" : "does not source ~/dev/machine/env.zsh" });
  const rt = path.join(runtimeRoot(env), VERSION);
  results.push({ name: "runtime", ok: !!lstatOrNull(path.join(rt, "bin", "cd-hook")), detail: rt });
  const others = (() => { try { return fs.readdirSync(runtimeRoot(env)).filter((v) => v !== VERSION); } catch { return []; } })();
  const legacyDir = path.join(home, "Library", "Application Support", "clean-development");
  results.push({ name: "old runtimes", ok: others.length === 0 && !lstatOrNull(legacyDir), detail: [others.length ? `extra: ${others.join(" ")}` : "", lstatOrNull(legacyDir) ? `${legacyDir} still present` : ""].filter(Boolean).join("; ") || "none" });
  checkHooks("Claude hooks", path.join(home, ".claude", "settings.json"), "claude", env, results);
  const codexHooksFile = path.join(home, ".codex", "hooks.json");
  const codexDoc = checkHooks("Codex hooks", codexHooksFile, "codex", env, results);
  if (codexDoc) {
    let toml = "";
    try { toml = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8"); } catch { /* missing */ }
    const trusted = readTrusted(toml);
    const untrusted = trustEntries(codexHooksFile, codexDoc).filter((e) => trusted.get(e.key) !== e.hash);
    results.push({ name: "Codex hook trust", ok: untrusted.length === 0, detail: untrusted.length ? `untrusted: ${untrusted.map((e) => e.key.split(":").slice(-3).join(":")).join(", ")} (run clean-development codex-trust)` : "all hooks trusted" });
  }
  const shared = [path.join(home, "dev", "machine", "state", "claude-work", "shared", "settings.json"), path.join(home, "dev", "state", "claude-work", "shared", "settings.json")].find((p) => lstatOrNull(p));
  if (shared) checkHooks("claude-1..5 shared hooks", shared, "claude", env, results);
  else results.push({ name: "claude-1..5 shared hooks", ok: false, detail: "claude-work shared/settings.json not found" });
  const installed = readJsonOrNull(path.join(home, ".claude", "plugins", "installed_plugins.json"));
  const rows = Object.entries(installed?.plugins || {}).filter(([id]) => id.startsWith("clean-development@"));
  const versions = rows.flatMap(([id, list]) => (list || []).map((r) => `${id}=${r.version}`));
  results.push({ name: "Claude plugin pin", ok: versions.length === 1 && versions[0].endsWith(`=${VERSION}`), detail: versions.join(", ") || "not installed" });
  if (gui) {
    const g = (n) => (sh("/bin/launchctl", ["getenv", n]).stdout || "").trim();
    const guiCache = g("DEVCACHE");
    const guiTmp = g("TMPDIR");
    const expect = layout(d.root).root;
    results.push({ name: "GUI launchd env", ok: guiCache === expect && guiTmp === "", detail: `DEVCACHE=${guiCache || "(unset)"} expected ${expect}; TMPDIR=${guiTmp || "(unset, macOS default)"}` });
    const x = (sh("/usr/bin/defaults", ["read", "com.apple.dt.Xcode", "IDECustomDerivedDataLocation"]).stdout || "").trim();
    results.push({ name: "Xcode DerivedData", ok: x === layout(d.root).derivedData, detail: `${x || "(unset)"} expected ${layout(d.root).derivedData}` });
  }
  const dots = dotReport(conf, home);
  results.push({ name: "dot-folders", ok: true, detail: dots.folders.length ? `unexpected (report only): ${dots.folders.join(" ")}` : "none unexpected" });
  // Entries at the top level of a cache root that 0.6.0 does not manage are outside the 30 GB cap and every pruning rule.
  const extras = [["external", conf.externalCache], ["internal", conf.internalRoot]]
    .flatMap(([label, root]) => rootExtras(root).map((x) => `${label}:${x.name} (${fmtGB(x.bytes)})`));
  results.push({ name: "cache root extras", ok: true, detail: extras.length ? `unmanaged top-level entries (report only): ${extras.join(" ")}` : "none" });
  return { version: VERSION, ok: results.every((r) => r.ok), results };
}
