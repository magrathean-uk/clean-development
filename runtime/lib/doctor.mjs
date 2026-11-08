// Read-only installation health; warnings never change the exit code.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sessionsDir, VERSION, RELEASE_DIR, homeDir, hookShimPath, hookShimText, shimRelease, loadConf, runtimeRoot, stateDir } from "./conf.mjs";
import { detect, externalWorkRoot, fmtGB, GB, internalFreeBytes, layout } from "./storage.mjs";
import { children, lstatOrNull, readJsonOrNull, safeDirectory } from "./fsutil.mjs";
import { hookDocumentProblems, managedHookCommand, managedTrustEntries, readHookStates, trustEntries } from "./codex-trust.mjs";
import { claudeProfiles, claudeSettings, codexHomes, inventoryExtras, policyInventory, scanLiteralCachePaths, worktreeInventory } from "./inventory.mjs";
import { readSizeCache, trashPaths } from "./sizes.mjs";
import { dotReport } from "./dots.mjs";
import { readLeases } from "./leases.mjs";
import { inspectLocks } from "./locks.mjs";
import { DIGEST_ALGORITHM, treeDigest } from "./release.mjs";
import { listSessions } from "./sessions.mjs";
import { sourceRepos } from "./project.mjs";
import { colimaHomeMatches, vmHome } from "./vm.mjs";

const EVENTS = { SessionStart: "session-start", Stop: "stop", SessionEnd: "session-end" };

export function hookCommand(env, event, harness) {
  return `\"$HOME/dev/machine/runtime/clean-development/active/bin/cd-hook\" ${EVENTS[event] || event} ${harness}`;
}

export function hookCommandMatches(env, event, harness, command) {
  const parsed = managedHookCommand(command);
  const expectedEvent = Object.hasOwn(EVENTS, event) ? event : Object.keys(EVENTS).find((name) => EVENTS[name] === event) || event;
  if (!parsed || parsed.event !== expectedEvent || parsed.harness !== harness) return false;
  return parsed.fromHome && command === hookCommand(env, event, harness)
    || !parsed.fromHome && parsed.file === hookShimPath(env);
}

function commandsIn(doc) {
  const out = [];
  for (const [event, groups] of Object.entries(doc?.hooks || {})) for (const g of Array.isArray(groups) ? groups : []) for (const h of Array.isArray(g?.hooks) ? g.hooks : []) {
    if (h?.type === "command") out.push({ event, command: String(h.command || ""), matcher: g.matcher, timeout: h.timeout, async: h.async === true });
  }
  return out;
}

function checkHooks(name, file, harness, env, results) {
  const doc = readJsonOrNull(file);
  if (!doc) { results.push({ name, ok: false, detail: `${file} missing or not JSON` }); return null; }
  const shapeProblems = hookDocumentProblems(doc);
  const cmds = commandsIn(doc);
  const owned = cmds.filter((c) => /\/runtime\/clean-development\/|clean-development\/runtime\/|Application Support\/clean-development/.test(c.command));
  const problems = [];
  for (const ev of Object.keys(EVENTS)) {
    const handlers = owned.filter((c) => c.event === ev && hookCommandMatches(env, ev, harness, c.command));
    if (handlers.length !== 1) { problems.push(`${ev}: expected exactly one current handler, found ${handlers.length}`); continue; }
    const h = handlers[0];
    if (ev === "SessionStart" && h.matcher !== "startup|resume|clear|compact|fork") problems.push("SessionStart matcher differs");
    // Both harnesses must await managed hooks. A one-shot exit can kill an
    // asynchronous Stop while its lifecycle lock is held.
    if (h.async) problems.push(`${ev} async differs`);
    const timeout = ev === "Stop" ? 5 : ev === "SessionStart" ? 30 : harness === "codex" ? 3 : 15;
    if (h.timeout !== timeout) problems.push(`${ev} timeout differs`);
  }
  const legacy = owned.filter((c) => !Object.keys(EVENTS).some((ev) => c.event === ev && hookCommandMatches(env, ev, harness, c.command)));
  if (legacy.length) problems.push(`${legacy.length} stale/legacy clean-development handler(s)`);
  const allProblems = [...shapeProblems, ...problems];
  results.push({ name, ok: allProblems.length === 0, detail: allProblems.join("; ") || `${VERSION} configured; dispatch/completion not tested` });
  return doc;
}

const sh = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8", timeout: 10000 });

export function doctor(env = process.env, { gui = false, internalWarnBytes = 1024 ** 3 } = {}) {
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
  const shell = path.basename(env.SHELL || "zsh");
  const startupNames = shell === "bash" ? [".bash_profile", ".bash_login", ".profile", ".bashrc"]
    : shell === "zsh" ? [".zshenv"] : [];
  const startupFiles = startupNames.map((name) => path.join(home, name));
  const sourcesEnv = startupFiles.some((file) => { try { return fs.readFileSync(file, "utf8").includes("dev/machine/env.zsh"); } catch { return false; } });
  results.push({ name: "shell startup", ok: startupNames.length === 0 || sourcesEnv, ...(startupNames.length === 0 ? { warn: true } : {}),
    detail: startupNames.length === 0 ? shell + " startup configuration is outside the supported zsh/bash check"
      : sourcesEnv ? "sources ~/dev/machine/env.zsh" : "does not source ~/dev/machine/env.zsh in " + startupNames.join(", ") });
  const rt = path.join(runtimeRoot(env), VERSION);
  results.push({ name: "runtime", ok: !!lstatOrNull(path.join(rt, "bin", "cd-hook")), detail: rt });
  const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
  const nodeSupported = nodeMajor > 20 || (nodeMajor === 20 && nodeMinor >= 12);
  results.push({ name: "Node.js runtime", ok: nodeSupported, detail: process.version + " (" + process.execPath + "); requires 20.12 or later" });
  const cliLauncher = path.join(home, "dev", "machine", "bin", "clean-development");
  const cliExecutable = (p) => { try { return lstatOrNull(p)?.isFile() === true && (fs.accessSync(p, fs.constants.X_OK), true); } catch { return false; } };
  results.push({ name: "CLI launcher", ok: cliExecutable(cliLauncher), detail: cliLauncher });
  const shim = hookShimPath(env);
  let shimText = "";
  try { if (lstatOrNull(shim)?.isFile()) shimText = fs.readFileSync(shim, "utf8"); } catch { /* unreadable */ }
  const release = shimRelease(shimText, env);
  // Hosts exec the shim, and the shim execs the release launcher: both must be executable, not merely present.
  const executable = (p) => { try { return lstatOrNull(p)?.isFile() === true && (fs.accessSync(p, fs.constants.X_OK), true); } catch { return false; } };
  const shimExec = executable(shim), launcherExec = executable(path.join(rt, "bin", "cd-hook"));
  results.push({ name: "hook shim", ok: shimText === hookShimText(env, VERSION) && release === VERSION && shimExec && launcherExec,
    detail: `${shim}: ${release || "missing, unreadable or not a managed shim"}${release && !shimExec ? "; shim not executable" : ""}${release && !launcherExec ? "; release bin/cd-hook missing or not executable" : ""}; expected ${VERSION} with an executable bin/cd-hook` });
  const others = (() => { try { return fs.readdirSync(runtimeRoot(env)).filter((v) => RELEASE_DIR.test(v) && v !== VERSION); } catch { return []; } })();
  const legacyDir = path.join(home, "Library", "Application Support", "clean-development");
  results.push({ name: "retained runtimes", ok: true, detail: [others.length ? `retained (never automatically removed): ${others.join(" ")}` : "", lstatOrNull(legacyDir) ? `legacy bytes retained: ${legacyDir}; references checked separately` : ""].filter(Boolean).join("; ") || "none" });
  const receiptRoot = path.join(stateDir(env), "installations");
  const receipts = children(receiptRoot).map((d) => readJsonOrNull(path.join(receiptRoot, d.name, "receipt.json"))).filter(Boolean);
  const pending = receipts.filter((r) => !["committed", "rolled-back", "recovered-preserving-conflicts"].includes(r.status));
  const latest = receipts.filter((r) => r.status === "committed" && r.version === VERSION && r.runtime === rt).sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)))[0];
  let parity = null;
  if (latest) { try { parity = latest.digestAlgorithm === DIGEST_ALGORITHM && treeDigest(rt) === latest.digest; } catch { parity = false; } }
  results.push({ name: "deployment receipts", ok: !pending.length && parity !== false,
    detail: `${pending.length} unfinished recovery transaction(s); ${parity === null ? "no matching current receipt; parity unverified" : parity ? "current runtime matches receipt" : "current runtime differs from receipt"}` });
  const claude = claudeSettings(env);
  results.push({ name: "Claude settings", ok: !claude.errors.length, warn: !claude.errors.length && (!claude.files.length || claude.optionalMissing.length > 0),
    detail: claude.errors.join("; ") || claude.files.length + " configured settings file(s)" + (claude.optionalMissing.length ? "; optional absent: " + claude.optionalMissing.join(", ") : "") });
  for (const file of claude.files) {
    const label = file === path.join(home, ".claude", "settings.json") ? "Claude hooks" : `Claude hooks (${path.basename(path.dirname(file))})`;
    checkHooks(label, file, "claude", env, results);
  }
  const profiles = claudeProfiles(env);
  results.push({ name: "Claude profiles", ok: !profiles.errors.length, warn: !profiles.errors.length && profiles.optionalMissing.length > 0,
    detail: profiles.errors.join("; ") || profiles.files.length + " profile settings file(s)" + (profiles.optionalMissing.length ? "; optional absent: " + profiles.optionalMissing.join(", ") : "") });
  for (const file of profiles.files) {
    const doc = readJsonOrNull(file), seatHandlers = commandsIn(doc).filter((c) => /clean-development/.test(c.command));
    const stale = seatHandlers.filter((c) => !hookCommandMatches(env, c.event, "claude", c.command));
    const asynchronous = seatHandlers.filter((c) => c.async), invalid = !doc;
    results.push({ name: `Claude profile hooks (${path.relative(home, file) || file})`, ok: !stale.length && !asynchronous.length && !invalid,
      detail: invalid ? `${file} unreadable or not JSON` : stale.length ? `${file}: ${stale.length} stale per-profile clean-development handler(s); use current shared shim commands` : asynchronous.length ? `${file}: ${asynchronous.length} async per-profile clean-development handler(s); use synchronous hooks` : "inherits shared hooks" });
  }
  const registry = codexHomes(env);
  results.push({ name: "Codex homes", ok: !registry.errors.length, warn: !registry.errors.length && (!registry.homes.length || registry.optionalMissing.length > 0),
    detail: registry.errors.join("; ") || registry.homes.length + " configured home(s)" + (registry.optionalMissing.length ? "; optional absent: " + registry.optionalMissing.join(", ") : "") });
  for (const codexHome of registry.homes) {
    const hasConfig = fs.existsSync(path.join(codexHome, "config.toml")) && (() => { try { return fs.statSync(path.join(codexHome, "config.toml")).isFile(); } catch { return false; } })();
    const hasHooks = fs.existsSync(path.join(codexHome, "hooks.json")) && (() => { try { return fs.statSync(path.join(codexHome, "hooks.json")).isFile(); } catch { return false; } })();
    if (!hasConfig && !hasHooks && registry.explicit?.has(codexHome)) {
      results.push({ name: `Codex hooks (${path.basename(codexHome)})`, ok: false, detail: `${codexHome} is listed in codex-homes.list but has no config.toml or hooks.json; fix or remove the entry` });
      continue;
    }
    // Keep the default-home row concise and label additional configured homes.
    const label = codexHome === path.join(home, ".codex") ? "" : ` (${path.basename(codexHome)})`, codexHooksFile = path.join(codexHome, "hooks.json");
    const remedy = `merge fragments/codex-hooks.json into ${codexHooksFile} using the installation guide, then run clean-development codex-trust --hooks ${codexHooksFile} --config ${path.join(codexHome, "config.toml")} --apply`;
    const codexDoc = checkHooks(`Codex hooks${label}`, codexHooksFile, "codex", env, results);
    if (!results.at(-1).ok) results.at(-1).detail += `; remedy: ${remedy}`;
    if (!codexDoc) { results.push({ name: `Codex hook trust${label}`, ok: false, detail: `cannot inspect missing/invalid hooks; ${remedy}` }); continue; }
    let toml = "";
    try { toml = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"); } catch { /* missing */ }
    const states = readHookStates(toml), managed = managedTrustEntries(codexHooksFile, codexDoc, env);
    const currentKeys = new Set(trustEntries(codexHooksFile, codexDoc).filter((e) => {
      const parts = e.key.slice(codexHooksFile.length + 1).split(":");
      const event = Object.keys(EVENTS).find((ev) => EVENTS[ev].replaceAll("-", "_") === parts[0]);
      return event && hookCommandMatches(env, event, "codex", codexDoc.hooks[event]?.[Number(parts[1])]?.hooks?.[Number(parts[2])]?.command);
    }).map((e) => e.key));
    const entries = trustEntries(codexHooksFile, codexDoc).filter((e) => currentKeys.has(e.key) || managed.some((m) => m.key === e.key));
    const disabled = entries.filter((e) => states.get(e.key)?.enabled === false);
    const untrusted = entries.filter((e) => states.get(e.key)?.enabled !== false && states.get(e.key)?.hash !== e.hash);
    results.push({ name: `Codex hook trust${label}`, ok: untrusted.length === 0,
      configured: entries.length, disabled: disabled.length, trustedEnabled: entries.length - disabled.length - untrusted.length,
      detail: [`${disabled.length} explicitly disabled (preserved)`, untrusted.length ? `untrusted: ${untrusted.map((e) => e.key.split(":").slice(-3).join(":")).join(", ")} (review clean-development codex-trust)` : "enabled managed hooks trusted", "dispatch/completion not tested"].join("; ") });
  }
  const installed = readJsonOrNull(path.join(home, ".claude", "plugins", "installed_plugins.json"));
  const rows = Object.entries(installed?.plugins || {}).filter(([id]) => id.startsWith("clean-development@"));
  const versions = rows.flatMap(([id, list]) => (list || []).map((r) => `${id}=${r.version}`));
  results.push({ name: "Claude plugin pin", ok: versions.length === 0 || (versions.length === 1 && versions[0].endsWith("=" + VERSION)),
    ...(versions.length === 0 ? { warn: true } : {}), detail: versions.join(", ") || "not installed (optional guidance plugin)" });
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
  // A lock with another boot's id heals itself on the next lifecycle run (warn); so does a shared recovery guard with
  // another boot's id (next recovery), and an earlier boot's outer guard is never used again. Installer locks,
  // same-boot dead or unverifiable owners, legacy records and a dead owner of a guard stay FAIL with their route.
  const sharedGuard = locks.find((l) => l.name === "lock-recovery"), outerGuard = locks.find((l) => l.guardBoot && !l.staleGuard && !l.guardUnknown);
  // Live guards are a recovery in progress; a reboot-orphaned shared guard is reclaimed under the outer guard.
  const blocker = outerGuard && outerGuard.alive !== true ? outerGuard
    : sharedGuard && !sharedGuard.orphanedByReboot && (sharedGuard.alive !== true || sharedGuard.legacyBeforeBoot) ? sharedGuard : null;
  const lockState = (l) => l.guardUnknown ? "boot identity unreadable here (sandbox?), so this outer guard's state is unknown; run doctor outside the sandbox"
    : l.inspectionIncomplete ? "state directory over 5000 entries; earlier-boot guards not listed (this boot's guard was inspected)"
    : l.staleGuard ? `outer guard of earlier boot ${l.guardBoot}; never used again, harmless (remove by hand if wanted: ${l.file})`
    : l.reclaimable ? `orphaned by reboot (${l.orphanedByReboot}); ${blocker ? `auto-reclaim blocked by ${blocker.name}` : "auto-reclaimed on next lifecycle run"}`
    : l === sharedGuard && l.orphanedByReboot ? `orphaned by reboot (${l.orphanedByReboot}); reclaimed by the next recovery`
    : l.orphanedByReboot ? `orphaned by reboot (${l.orphanedByReboot}); explicit recovery required`
    : l.legacyBeforeBoot && l.alive === true ? `acquired before this boot by the wall clock (no boot id recorded) but pid ${l.owner.pid} is live now (pid reuse or a clock step); explicit recovery refuses a live pid: check ps -p ${l.owner.pid}`
    : l.alive === true ? (l === outerGuard || l === sharedGuard ? "active owner (a recovery is running)" : "active owner")
    : l === outerGuard ? "dead/unverifiable owner of this boot's outer recovery guard; blocks reboot reclaim and explicit recovery until the next boot (no recovery command)"
    : l === sharedGuard ? (l.alive === false
      ? `${l.legacyBeforeBoot ? "dead owner acquired before this boot by the wall clock (no boot id recorded, so not proof)" : "dead owner"}; explicit recovery: clean-development locks --recover lock-recovery --apply`
      : "unverifiable owner (empty or unreadable record); explicit recovery refuses it: inspect the file before acting")
    : l.legacyBeforeBoot ? "dead owner acquired before this boot by the wall clock (no boot id recorded, so not proof); explicit recovery required"
    : "dead/unverifiable owner; explicit recovery required";
  const lockOk = (l) => l.inspectionIncomplete || l.staleGuard || l.reclaimable || (l === sharedGuard && !!l.orphanedByReboot) || (l.alive === true && !l.orphanedByReboot && !l.legacyBeforeBoot && !l.guardUnknown);
  results.push({ name: "cleanup locks", ok: locks.every(lockOk), ...(locks.length && locks.every(lockOk) && locks.some((l) => l.reclaimable || l.staleGuard || l.inspectionIncomplete || l.orphanedByReboot) ? { warn: true } : {}),
    detail: locks.length ? locks.map((l) => `${l.name}: ${lockState(l)}`).join("; ") : "none held" });
  const leases = readLeases(env);
  results.push({ name: "job leases", ok: leases.errors.length === 0, detail: leases.errors.join("; ") || `${leases.leases.length} active explicit protection(s), ${leases.leases.filter((l) => l.status === "held").length} non-expiring publication hold(s); expiry is not job completion` });
  results.push({ name: "harness support", ok: true, detail: "Claude/Codex native lifecycle; OpenCode environment-only, server environment and native lifecycle NOT TESTED" });
  const owners = listSessions(env), invalid = owners.filter((s) => s.errors.length);
  results.push({ name: "ownership records", ok: !invalid.length, detail: invalid.length ? invalid.map((s) => `${s.key}: ${s.errors.join(", ")}`).join("; ") : `${owners.length} readable record(s); mode-only owners defer project cleanup` });
  // 0.6.2 report-only rows: rejected placeholder/short keys and sessions pinned internal while external is usable now.
  for (const x of owners.filter((x) => x.rejected)) results.push({ name: `rejected session key ${x.key}`, ok: true, warn: true,
    detail: `${x.rejected}; 0.6.2 routes nothing new to it; reaped once every signal has been quiet for 7 days (pins ${path.join(sessionsDir(env), x.key)}.*)` });
  // Storage follows the configured external volume per shell; no session pin decides routing. The internal
  // disk carries all development while the external volume is away: report when its free space drops below the floor.
  const internalFree = internalFreeBytes(conf, env);
  if (internalFree !== null && internalFree < conf.INTERNAL_MIN_FREE_GB * GB) results.push({ name: "internal free space", ok: true, warn: true,
    detail: `${fmtGB(internalFree)} free on the internal disk, below the configured ${conf.INTERNAL_MIN_FREE_GB} GB warning threshold` });
  const queues = roots.filter((r) => safeDirectory(r, layout(r).trash)).flatMap((r) => children(layout(r).trash)
    .filter((f) => /^\.cd-delete-[a-f0-9-]+\.json$/.test(f.name)).map((f) => path.join(layout(r).trash, f.name)));
  const oldQueues = queues.filter((p) => Date.now() - (lstatOrNull(p)?.mtimeMs || Date.now()) > 3600000);
  results.push({ name: "deletion queues", ok: !oldQueues.length, detail: `${queues.length} pending/unverified manifest(s), ${oldQueues.length} over one hour; correlate deletions.jsonl completion, not hook entry` });
  const warn = (name, detail) => results.push({ name, ok: true, warn: true, detail });
  results.push({ name: "dot-folders", ok: true, detail: dots.folders.length ? `unexpected (report only): ${dots.folders.join(" ")}` : "none unexpected" });
  for (const folder of dots.folders) warn(`unexpected dot-folder ${folder}`, "add to HOME_DOT_ALLOW in ~/dev/machine/storage.conf (DEV_DOT_ALLOW for ~/dev) or move; report only");
  const sizes = readSizeCache(env), inventory = inventoryExtras(conf, env, { sizes, internalWarnBytes });
  const extras = Object.entries(inventory).flatMap(([label, entries]) => entries.map((x) => `${label}:${x.name}`));
  results.push({ name: "cache root extras", ok: true, detail: extras.length ? `unmanaged top-level entries (report only): ${extras.join(" ")}` : "none" });
  for (const entry of inventory.internal) if (entry.misplaced) warn(`misplaced cache extra ${entry.name}`,
    `${entry.path}: ${entry.bytes === null ? "size unknown" : fmtGB(entry.bytes)}; owner ${typeof entry.owner === "object" && entry.owner ? JSON.stringify(entry.owner) : entry.owner || "unknown"}${entry.overCap ? "; OVER 1 GB" : ""}`);
  const literals = scanLiteralCachePaths(conf, env);
  for (const hit of literals.hits) warn("literal cache path", `${hit.file}:${hit.line}`);
  if (literals.incomplete) warn("literal cache path scan", "scan incomplete: file, size or time bound reached, or file unreadable");
  const policy = policyInventory(conf, env);
  for (const p of policy.strayDev) warn("stray ~/dev entry", p);
  for (const name of policy.staleHomeDots) warn(`stale HOME_DOT_ALLOW ${name}`, "does not exist; suggest removal from ~/dev/machine/storage.conf");
  for (const p of new Set([...trashPaths(conf, env), ...Object.keys(sizes?.trash || {})])) warn("pending Trash", `${p}: ${sizes?.trash?.[p] === null || sizes?.trash?.[p] === undefined ? "unknown, refresh sizes" : `${sizes.trash[p]} bytes (${fmtGB(sizes.trash[p])})`}`);
  // Optional workspace inventory for users who keep repositories under ~/dev/source.
  if (env.CLEAN_DEV_REPORT_UNADOPTED_REPOS === "1") {
    let repos = [];
    try { repos = sourceRepos(home).repos; } catch (e) { warn("repo scan", `~/dev/source unreadable (${e.code || e.message}); repo rows skipped`); }
    const lacking = (f) => repos.filter((r) => !lstatOrNull(path.join(r, f))?.isFile()).map((r) => path.basename(r));
    for (const [file, why] of [[".clean-development.json", "no declared buildDirs/depDirs; project cleanup skips it"], ["AGENTS.md", "no agent instructions"]]) {
      const names = lacking(file);
      if (names.length) warn(`repos without ${file}`, `${names.length}: ${names.join(" ")}; ${why}`);
    }
  }
  const worktreeRoots = [...new Set([externalWorkRoot(conf), conf.externalRoot, path.join(home, "dev", "machine")].map((root) => path.join(root, "worktrees")))];
  const worktrees = worktreeInventory(conf, env);
  for (const wt of worktrees.worktrees) warn("worktree outside root", `${wt.path} (repo ${wt.repo}); expected under ${worktreeRoots.join(" or ")}`);
  if (worktrees.incomplete) warn("worktree scan", "scan incomplete: git inspection failed or time bound reached");
  // Colima support is optional. A general private environment extension does not opt into Colima; its installed
  // shim is the concrete marker that this host chose the optional integration.
  const colimaShim = path.join(home, "dev", "machine", "bin", "colima");
  const colimaShimStat = lstatOrNull(colimaShim);
  if (colimaShimStat?.isFile() && !colimaShimStat.isSymbolicLink()) {
    if (!colimaHomeMatches(conf, env)) warn("Colima home", `COLIMA_HOME must resolve to ${vmHome(conf, "colima")}; rehome is disabled until it matches`);
    else {
      let strayColima = [];
      try { strayColima = children(path.join(conf.labRoot, "VM", "lima-home")).filter((e) => e.isDirectory() && /^colima(-.+)?$/.test(e.name)).map((e) => e.name); } catch { /* external lab unavailable or unreadable */ }
      if (strayColima.length) warn("colima instances in lima-home", `${strayColima.join(" ")}: run clean-development vm colima-rehome to preview moving stopped instances`);
    }
  }
  return { version: VERSION, ok: results.every((r) => r.ok), results };
}
