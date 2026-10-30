// clean-development 0.6.0: read-only health checks for the whole installation (exit 1 when any check fails).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { VERSION, homeDir, loadConf, runtimeRoot, stateDir } from "./conf.mjs";
import { detect, layout, rootExtras } from "./storage.mjs";
import { children, lstatOrNull, readJsonOrNull, safeDirectory } from "./fsutil.mjs";
import { managedTrustEntries, readHookStates } from "./codex-trust.mjs";
import { dotReport } from "./dots.mjs";
import { readLeases } from "./leases.mjs";
import { inspectLocks } from "./locks.mjs";
import { DIGEST_ALGORITHM, treeDigest } from "./release.mjs";
import { listSessions } from "./sessions.mjs";

const EVENTS = { SessionStart: "session-start", Stop: "stop", SessionEnd: "session-end" };

export function hookCommand(env, event, harness) {
  return `'${path.join(runtimeRoot(env), VERSION, "bin", "cd-hook")}' ${EVENTS[event]} ${harness}`;
}

function commandsIn(doc) {
  const out = [];
  for (const [event, groups] of Object.entries(doc?.hooks || {})) for (const g of groups || []) for (const h of g.hooks || []) {
    if (h?.type === "command") out.push({ event, command: String(h.command || ""), matcher: g.matcher, timeout: h.timeout, async: h.async === true });
  }
  return out;
}

function checkHooks(name, file, harness, env, results) {
  const doc = readJsonOrNull(file);
  if (!doc) { results.push({ name, ok: false, detail: `${file} missing or not JSON` }); return null; }
  const cmds = commandsIn(doc);
  const owned = cmds.filter((c) => /\/runtime\/clean-development\/|clean-development\/runtime\/|Application Support\/clean-development/.test(c.command));
  const problems = [];
  for (const ev of Object.keys(EVENTS)) {
    const handlers = owned.filter((c) => c.event === ev && c.command === hookCommand(env, ev, harness));
    if (handlers.length !== 1) { problems.push(`${ev}: expected exactly one current handler, found ${handlers.length}`); continue; }
    const h = handlers[0];
    if (ev === "SessionStart" && h.matcher !== "startup|resume|clear|compact|fork") problems.push("SessionStart matcher differs");
    if ((ev === "Stop") !== h.async) problems.push(`${ev} async differs`);
    const timeout = ev === "Stop" ? 300 : ev === "SessionStart" ? 30 : harness === "codex" ? 3 : 15;
    if (h.timeout !== timeout) problems.push(`${ev} timeout differs`);
  }
  const legacy = owned.filter((c) => !Object.keys(EVENTS).some((ev) => c.event === ev && c.command === hookCommand(env, ev, harness)));
  if (legacy.length) problems.push(`${legacy.length} stale/legacy clean-development handler(s)`);
  results.push({ name, ok: problems.length === 0, detail: problems.join("; ") || `${VERSION} configured; dispatch/completion not tested` });
  return doc;
}

const sh = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8", timeout: 10000 });

export function doctor(env = process.env, { gui = true } = {}) {
  const home = homeDir(env);
  const results = [];
  const conf = loadConf(env);
  results.push({ name: "storage.conf", ok: conf.valid, detail: conf.valid ? conf.file : conf.errors.join("; ") });
  const d = detect(conf, env, { probe: false, create: false });
  results.push({ name: "storage mode", ok: true, detail: `${d.mode}: ${d.reason}` });
  const roots = [conf.internalRoot].concat(d.mode === "external" ? [conf.externalCache] : []);
  const unsafe = roots.flatMap((root) => [root, ...["deps", "builds", "scratch", "trash"].map((k) => layout(root)[k])].filter((p) => !safeDirectory(root, p, { missingAnchor: true })));
  if (d.mounted && !safeDirectory(conf.mountPoint, conf.externalCache)) unsafe.push(conf.externalCache);
  results.push({ name: "cache layout", ok: !unsafe.length, detail: unsafe.length ? `unsupported redirection/non-directory: ${unsafe.join(" ")}` : "anchors/layout/trash accepted; hostile path-swap races not tested" });
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
  results.push({ name: "retained runtimes", ok: true, detail: [others.length ? `retained (never automatically removed): ${others.join(" ")}` : "", lstatOrNull(legacyDir) ? `legacy bytes retained: ${legacyDir}; references checked separately` : ""].filter(Boolean).join("; ") || "none" });
  const receiptRoot = path.join(stateDir(env), "installations");
  const receipts = children(receiptRoot).map((d) => readJsonOrNull(path.join(receiptRoot, d.name, "receipt.json"))).filter(Boolean);
  const pending = receipts.filter((r) => !["committed", "rolled-back"].includes(r.status));
  const latest = receipts.filter((r) => r.status === "committed" && r.version === VERSION && r.runtime === rt).sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)))[0];
  let parity = null;
  if (latest) { try { parity = latest.digestAlgorithm === DIGEST_ALGORITHM && treeDigest(rt) === latest.digest; } catch { parity = false; } }
  results.push({ name: "deployment receipts", ok: !pending.length && parity !== false,
    detail: `${pending.length} unfinished recovery transaction(s); ${parity === null ? "no matching current receipt; parity unverified" : parity ? "current runtime matches receipt" : "current runtime differs from receipt"}` });
  checkHooks("Claude hooks", path.join(home, ".claude", "settings.json"), "claude", env, results);
  const codexHooksFile = path.join(home, ".codex", "hooks.json");
  const codexDoc = checkHooks("Codex hooks", codexHooksFile, "codex", env, results);
  if (codexDoc) {
    let toml = "";
    try { toml = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8"); } catch { /* missing */ }
    const states = readHookStates(toml), entries = managedTrustEntries(codexHooksFile, codexDoc);
    const disabled = entries.filter((e) => states.get(e.key)?.enabled === false);
    const untrusted = entries.filter((e) => states.get(e.key)?.enabled !== false && states.get(e.key)?.hash !== e.hash);
    results.push({ name: "Codex hook trust", ok: untrusted.length === 0,
      configured: entries.length, disabled: disabled.length, trustedEnabled: entries.length - disabled.length - untrusted.length,
      detail: [`${disabled.length} explicitly disabled (preserved)`, untrusted.length ? `untrusted: ${untrusted.map((e) => e.key.split(":").slice(-3).join(":")).join(", ")} (review clean-development codex-trust)` : "enabled managed hooks trusted", "dispatch/completion not tested"].join("; ") });
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
  const locks = inspectLocks(env);
  results.push({ name: "cleanup locks", ok: locks.every((l) => l.alive === true), detail: locks.length ? locks.map((l) => `${l.name}: ${l.alive === true ? "active owner" : "dead/unverifiable owner; explicit recovery required"}`).join("; ") : "none held" });
  const leases = readLeases(env);
  results.push({ name: "job leases", ok: leases.errors.length === 0, detail: leases.errors.join("; ") || `${leases.leases.length} active explicit protection(s), ${leases.leases.filter((l) => l.status === "held").length} non-expiring publication hold(s); expiry is not job completion` });
  results.push({ name: "harness support", ok: true, detail: "Claude/Codex native lifecycle; OpenCode environment-only, server environment and native lifecycle NOT TESTED" });
  const owners = listSessions(env), invalid = owners.filter((s) => s.errors.length);
  results.push({ name: "ownership records", ok: !invalid.length, detail: invalid.length ? invalid.map((s) => `${s.key}: ${s.errors.join(", ")}`).join("; ") : `${owners.length} readable record(s); mode-only owners defer project cleanup` });
  const queues = roots.filter((r) => safeDirectory(r, layout(r).trash)).flatMap((r) => children(layout(r).trash)
    .filter((f) => /^\.cd-delete-[a-f0-9-]+\.json$/.test(f.name)).map((f) => path.join(layout(r).trash, f.name)));
  const oldQueues = queues.filter((p) => Date.now() - (lstatOrNull(p)?.mtimeMs || Date.now()) > 3600000);
  results.push({ name: "deletion queues", ok: !oldQueues.length, detail: `${queues.length} pending/unverified manifest(s), ${oldQueues.length} over one hour; correlate deletions.jsonl completion, not hook entry` });
  results.push({ name: "dot-folders", ok: true, detail: dots.folders.length ? `unexpected (report only): ${dots.folders.join(" ")}` : "none unexpected" });
  // Entries at the top level of a cache root that 0.6.0 does not manage are outside the 30 GB cap and every pruning rule.
  const extras = [["internal", conf.internalRoot]].concat(d.mode === "external" ? [["external", conf.externalCache]] : [])
    .filter(([, root]) => safeDirectory(root, root, { missingAnchor: true }))
    .flatMap(([label, root]) => rootExtras(root, { sizes: false }).map((x) => `${label}:${x.name}`));
  results.push({ name: "cache root extras", ok: true, detail: extras.length ? `unmanaged top-level entries (report only): ${extras.join(" ")}` : "none" });
  return { version: VERSION, ok: results.every((r) => r.ok), results };
}
