import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { XCODE_DERIVED_DATA_KEY, XCODE_DOMAIN } from "./constants.js";
import { resolveExecutable } from "./executable.js";
import { ensureRealDirectory, readJson, writeJsonAtomic } from "./io.js";
import { createSizeScanner } from "./measurement.js";
import { isPathInside } from "./platform.js";

// Opt-in macOS Xcode management. Two independent choices, both off until the owner says yes:
//   derivedData  point Xcode's DerivedData at <root>/xcode/DerivedData (one Xcode preference, restorable)
//   simulators   allow `clean-development xcode prune` to clear simulator and device leftovers
// Nothing here runs automatically: pruning is a reviewed dry run unless --apply is given.

const DAY_MS = 24 * 60 * 60 * 1000;
const DERIVED_DATA_PROJECT = /^.+-[a-z]{28}$/;
const DEVICE_SUPPORT = ["iOS", "watchOS", "tvOS", "visionOS", "xrOS"].map((name) => `${name} DeviceSupport`);
const COMMAND_TIMEOUT_MS = 30_000;

export function xcodeSupported(platform = process.platform) {
  return platform === "darwin";
}

export function xcodeSettings(config) {
  return {
    decided: config.xcode !== undefined,
    derivedData: config.xcode?.derivedData === true,
    simulators: config.xcode?.simulators === true
  };
}

export function xcodePaths(config) {
  const developer = path.join(config.locations.home, "Library", "Developer");
  const xcodeRoot = path.join(config.root, "xcode");
  return {
    xcodeRoot,
    derivedData: path.join(xcodeRoot, "DerivedData"),
    testResults: path.join(xcodeRoot, "test-results"),
    receipt: path.join(config.locations.stateDir, "xcode.json"),
    developer,
    simulatorCaches: path.join(developer, "CoreSimulator", "Caches"),
    testingDevices: path.join(developer, "XCTestDevices"),
    deviceSupport: DEVICE_SUPPORT.map((name) => path.join(developer, "Xcode", name))
  };
}

function tool(name, env, config) {
  return resolveExecutable(name, env, config.locations.binDir);
}

function run(executable, args, env) {
  const result = spawnSync(executable, args, { env, encoding: "utf8", timeout: COMMAND_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "", error: result.error || null };
}

function readReceipt(file) {
  const receipt = readJson(file, null);
  if (receipt === null) return null;
  const valid = receipt && receipt.schemaVersion === 1 && receipt.domain === XCODE_DOMAIN && receipt.key === XCODE_DERIVED_DATA_KEY
    && typeof receipt.written === "string" && path.isAbsolute(receipt.written)
    && (receipt.previous === null || typeof receipt.previous === "string");
  if (!valid) throw new Error(`Invalid Xcode receipt ${file}; remove it after checking 'defaults read ${XCODE_DOMAIN} ${XCODE_DERIVED_DATA_KEY}'`);
  return receipt;
}

function readPreference(config, env) {
  const defaults = tool("defaults", env, config);
  if (!defaults) return { status: "unavailable", value: null };
  const result = run(defaults, ["read", XCODE_DOMAIN, XCODE_DERIVED_DATA_KEY], env);
  if (result.error) return { status: "unavailable", value: null };
  if (result.status === 0) return { status: "set", value: result.stdout.replace(/\r?\n$/, "") };
  if (/does not exist/i.test(result.stderr)) return { status: "absent", value: null };
  return { status: "unreadable", value: null, detail: result.stderr.trim().slice(0, 200) };
}

function requirePreferenceTools(config, env) {
  const defaults = tool("defaults", env, config);
  if (!defaults) throw new Error("The macOS 'defaults' command was not found on PATH");
  return defaults;
}

function writePreference(config, env, value) {
  const defaults = requirePreferenceTools(config, env);
  const args = value === null ? ["delete", XCODE_DOMAIN, XCODE_DERIVED_DATA_KEY] : ["write", XCODE_DOMAIN, XCODE_DERIVED_DATA_KEY, "-string", value];
  const result = run(defaults, args, env);
  if (result.error || result.status !== 0) throw new Error(`defaults ${args[0]} failed: ${(result.error?.message || result.stderr).trim()}`);
}

/** Setup/update step. Applies the DerivedData preference, or restores it when the choice was withdrawn. */
export function applyXcodeSettings(config, env, { dryRun = false, platform = process.platform } = {}) {
  const settings = xcodeSettings(config);
  const paths = xcodePaths(config);
  const result = { supported: xcodeSupported(platform), decided: settings.decided, derivedData: { enabled: settings.derivedData, path: paths.derivedData },
    simulators: { enabled: settings.simulators } };
  if (!result.supported) return result;
  const receipt = readReceipt(paths.receipt);
  if (!settings.derivedData) {
    if (receipt) result.derivedData.action = restoreXcodeSettings(config, env, { dryRun, platform }).action;
    else result.derivedData.action = "none";
    return result;
  }
  const current = readPreference(config, env);
  if (current.status === "unavailable" || current.status === "unreadable") {
    throw new Error(`Cannot read the Xcode preference ${XCODE_DERIVED_DATA_KEY}${current.detail ? `: ${current.detail}` : "; the macOS 'defaults' command was not found"}`);
  }
  if (current.status === "set" && current.value === paths.derivedData) {
    result.derivedData.action = "unchanged";
    return result;
  }
  // Keep the value from before Clean Development touched it, not our own earlier write.
  const ours = receipt && current.status === "set" && current.value === receipt.written;
  const previous = ours ? receipt.previous : current.status === "set" ? current.value : null;
  result.derivedData.previous = previous;
  if (dryRun) {
    result.derivedData.action = "would-set";
    return result;
  }
  ensureRealDirectory(paths.xcodeRoot, { create: true, label: "Xcode root" });
  ensureRealDirectory(paths.derivedData, { create: true, label: "DerivedData root" });
  writePreference(config, env, paths.derivedData);
  const check = readPreference(config, env);
  if (check.status !== "set" || check.value !== paths.derivedData) throw new Error(`Xcode preference ${XCODE_DERIVED_DATA_KEY} did not take the new value`);
  writeJsonAtomic(paths.receipt, { schemaVersion: 1, domain: XCODE_DOMAIN, key: XCODE_DERIVED_DATA_KEY, previous, written: paths.derivedData, writtenAt: new Date().toISOString() });
  result.derivedData.action = "set";
  return result;
}

/** Undo the preference Clean Development wrote. A value the owner changed since is left alone. Files are never moved or deleted. */
export function restoreXcodeSettings(config, env, { dryRun = false, platform = process.platform } = {}) {
  const paths = xcodePaths(config);
  if (!xcodeSupported(platform)) return { action: "none" };
  const receipt = readReceipt(paths.receipt);
  if (!receipt) return { action: "none" };
  const current = readPreference(config, env);
  if (current.status === "unavailable" || current.status === "unreadable") {
    throw new Error(`Cannot read the Xcode preference ${XCODE_DERIVED_DATA_KEY}; restoration receipt retained${current.detail ? `: ${current.detail}` : "; the macOS 'defaults' command is unavailable"}`);
  }
  const ours = current.status === "set" && current.value === receipt.written;
  const action = ours ? (receipt.previous === null ? "removed" : "restored") : "left-unchanged";
  const result = { action, previous: receipt.previous, written: receipt.written, retainedDirectory: receipt.written, dryRun };
  if (dryRun) return { ...result, action: `would-be-${action}` };
  if (ours) writePreference(config, env, receipt.previous);
  fs.rmSync(paths.receipt, { force: true });
  return result;
}

function xcodeActivity(config, env) {
  const pgrep = tool("pgrep", env, config);
  const processes = [];
  let unknown = false;
  if (!pgrep) return { running: false, unknown: true, processes };
  for (const name of ["Xcode", "xcodebuild"]) {
    const result = run(pgrep, ["-x", name], env);
    if (result.error || (result.status !== 0 && result.status !== 1)) unknown = true;
    else if (result.status === 0) processes.push(name);
  }
  return { running: processes.length > 0, unknown, processes };
}

function simctl(config, env, args) {
  const xcrun = tool("xcrun", env, config);
  if (!xcrun) return { usable: false, reason: "xcrun-not-found" };
  const result = run(xcrun, ["simctl", ...args], env);
  if (result.error || result.status !== 0) return { usable: false, reason: "simctl-unavailable" };
  return { usable: true, stdout: result.stdout };
}

function listDevices(config, env, selector, ...setArgs) {
  const answer = simctl(config, env, [...setArgs, "list", "devices", selector, "-j"]);
  if (!answer.usable) return answer;
  try {
    const parsed = JSON.parse(answer.stdout);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || !parsed.devices || typeof parsed.devices !== "object" || Array.isArray(parsed.devices)) {
      return { usable: false, reason: "simctl-output-unreadable" };
    }
    const groups = Object.values(parsed.devices);
    if (groups.some((group) => !Array.isArray(group)
      || group.some((device) => !device || typeof device !== "object" || Array.isArray(device)
        || typeof device.udid !== "string" || !device.udid.trim()))) {
      return { usable: false, reason: "simctl-output-unreadable" };
    }
    const devices = groups.flat();
    return { usable: true, count: devices.length };
  } catch {
    return { usable: false, reason: "simctl-output-unreadable" };
  }
}

function realDirectoryEntry(directory) {
  try {
    const resolved = path.resolve(directory);
    const stat = fs.lstatSync(resolved);
    return stat.isDirectory() && !stat.isSymbolicLink() && fs.realpathSync.native(resolved) === resolved ? stat : null;
  } catch {
    return null;
  }
}

function childEntries(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.name !== ".DS_Store");
  } catch {
    return [];
  }
}

function newestModification(...files) {
  let newest = 0;
  for (const file of files) {
    try { newest = Math.max(newest, fs.lstatSync(file).mtimeMs); } catch { /* absent marker: treated as unverified elsewhere */ }
  }
  return newest;
}

function derivedDataEntries(paths, threshold, activity) {
  const root = paths.derivedData;
  if (!fs.existsSync(root)) return [];
  if (!realDirectoryEntry(root) || fs.realpathSync.native(root) !== root) {
    return [{ category: "derived-data", label: "DerivedData root", path: root, eligible: false, reason: "unsafe-root" }];
  }
  const entries = [];
  for (const entry of childEntries(root)) {
    const project = path.join(root, entry.name);
    if (!DERIVED_DATA_PROJECT.test(entry.name)) continue; // Xcode's shared module and SDK caches are not project folders.
    const item = { category: "derived-data", label: entry.name, path: project, marker: path.join(project, "info.plist") };
    if (entry.isSymbolicLink() || !entry.isDirectory()) { entries.push({ ...item, eligible: false, reason: "not-a-real-directory" }); continue; }
    let marked = false;
    try { marked = fs.lstatSync(item.marker).isFile(); } catch { /* unmarked */ }
    if (!marked) { entries.push({ ...item, eligible: false, reason: "no-xcode-marker" }); continue; }
    const last = newestModification(project, item.marker);
    item.lastUsedAt = new Date(last).toISOString();
    item.reason = activity.running ? "xcode-running" : activity.unknown ? "activity-unknown" : last >= threshold ? "recent" : "eligible";
    item.eligible = item.reason === "eligible";
    entries.push(item);
  }
  return entries;
}

function deviceSupportEntries(paths, threshold, activity) {
  const entries = [];
  for (const parent of paths.deviceSupport) {
    if (!realDirectoryEntry(parent)) continue;
    for (const entry of childEntries(parent)) {
      const target = path.join(parent, entry.name);
      const item = { category: "device-support", label: `${path.basename(parent)}/${entry.name}`, path: target, parent };
      if (entry.isSymbolicLink() || !entry.isDirectory()) { entries.push({ ...item, eligible: false, reason: "not-a-real-directory" }); continue; }
      const last = newestModification(target);
      item.lastUsedAt = new Date(last).toISOString();
      item.reason = activity.running ? "xcode-running" : activity.unknown ? "activity-unknown" : last >= threshold ? "recent" : "eligible";
      item.eligible = item.reason === "eligible";
      entries.push(item);
    }
  }
  return entries;
}

function simulatorEntries(config, env, paths) {
  const entries = [];
  const booted = listDevices(config, env, "booted");
  const bootedTesting = listDevices(config, env, "booted", "--set", "testing");
  const noneBooted = booted.usable && booted.count === 0 && bootedTesting.usable && bootedTesting.count === 0;
  const blocked = !booted.usable || !bootedTesting.usable ? "simctl-unavailable" : !noneBooted ? "simulator-booted" : null;

  const unavailable = listDevices(config, env, "unavailable");
  entries.push({
    category: "unavailable-simulators", label: "simulators whose runtime is gone",
    command: ["xcrun", "simctl", "delete", "unavailable"], count: unavailable.usable ? unavailable.count : null,
    eligible: unavailable.usable && unavailable.count > 0, reason: !unavailable.usable ? unavailable.reason : unavailable.count > 0 ? "eligible" : "none-found"
  });

  if (realDirectoryEntry(paths.testingDevices) && childEntries(paths.testingDevices).length) {
    entries.push({
      category: "testing-simulators", label: "XCTest device set", path: paths.testingDevices,
      command: ["xcrun", "simctl", "--set", "testing", "delete", "all"],
      eligible: blocked === null, reason: blocked || "eligible"
    });
  }

  if (realDirectoryEntry(paths.simulatorCaches) && childEntries(paths.simulatorCaches).length) {
    entries.push({
      category: "simulator-caches", label: "CoreSimulator caches (rebuilt on next boot)", path: paths.simulatorCaches, contentsOnly: true,
      eligible: blocked === null, reason: blocked || "eligible"
    });
  }
  return entries;
}

function retentionDays(value) {
  const days = Number(value);
  if (!Number.isFinite(days) || days < 0) throw new Error(`Invalid retention age: ${value}`);
  return days;
}

/** Read-only plan of everything `xcode prune --apply` would touch. */
export function xcodePrunePlan(config, env, { olderThanDays = config.retention.buildDays, now = Date.now(), platform = process.platform } = {}) {
  if (!xcodeSupported(platform)) throw new Error("Xcode management is available on macOS only");
  const settings = xcodeSettings(config);
  if (!settings.derivedData && !settings.simulators) {
    throw new Error("Xcode management is not enabled; run 'clean-development setup --xcode' (or update --xcode) first");
  }
  const days = retentionDays(olderThanDays);
  const threshold = now - days * DAY_MS;
  const paths = xcodePaths(config);
  const activity = xcodeActivity(config, env);
  const entries = [];
  if (settings.derivedData) entries.push(...derivedDataEntries(paths, threshold, activity));
  if (settings.simulators) {
    entries.push(...deviceSupportEntries(paths, threshold, activity));
    entries.push(...simulatorEntries(config, env, paths));
  }
  return { schemaVersion: 1, olderThanDays: days, pruneBefore: new Date(threshold).toISOString(), activity, settings, entries };
}

function assertInside(parent, target) {
  const canonicalParent = fs.realpathSync.native(parent);
  const canonicalTarget = fs.realpathSync.native(target);
  if (!isPathInside(canonicalParent, canonicalTarget)) throw new Error(`Refusing to remove ${target}: outside ${parent}`);
}

function stillEligible(entry, config, env, plan, paths) {
  const threshold = Date.parse(plan.pruneBefore);
  const stat = entry.path ? realDirectoryEntry(entry.path) : null;
  if (entry.category === "derived-data") {
    if (!stat || !DERIVED_DATA_PROJECT.test(path.basename(entry.path))) return false;
    try { if (!fs.lstatSync(entry.marker).isFile()) return false; } catch { return false; }
    if (newestModification(entry.path, entry.marker) >= threshold) return false;
    assertInside(paths.derivedData, entry.path);
    return true;
  }
  if (entry.category === "device-support") {
    if (!stat || !paths.deviceSupport.includes(entry.parent)) return false;
    if (newestModification(entry.path) >= threshold) return false;
    assertInside(entry.parent, entry.path);
    return true;
  }
  if (entry.category === "testing-simulators") return Boolean(stat) && entry.path === paths.testingDevices;
  if (entry.category === "simulator-caches") return Boolean(stat) && entry.path === paths.simulatorCaches;
  return true;
}

/** Apply the eligible entries of a reviewed plan, re-checking each one first. Returns what happened per entry. */
export function applyXcodePrune(plan, config, env, { platform = process.platform } = {}) {
  if (!xcodeSupported(platform)) throw new Error("Xcode management is available on macOS only");
  const paths = xcodePaths(config);
  const activity = xcodeActivity(config, env);
  const outcome = [];
  // Simulator state can change between plan and apply, so ask again.
  const fresh = plan.settings.simulators ? simulatorEntries(config, env, paths) : [];
  for (const entry of plan.entries.filter((item) => item.eligible)) {
    const record = { category: entry.category, label: entry.label, path: entry.path ?? null };
    try {
      if ((entry.category === "derived-data" || entry.category === "device-support") && (activity.running || activity.unknown)) {
        outcome.push({ ...record, status: "skipped", reason: activity.running ? "xcode-running" : "activity-unknown" });
        continue;
      }
      if (!stillEligible(entry, config, env, plan, paths)) {
        outcome.push({ ...record, status: "skipped", reason: "changed-since-plan" });
        continue;
      }
      if (entry.command) {
        const current = fresh.find((item) => item.category === entry.category);
        if (!current?.eligible) {
          outcome.push({ ...record, status: "skipped", reason: current?.reason || "changed-since-plan" });
          continue;
        }
        const xcrun = tool("xcrun", env, config);
        const result = run(xcrun, entry.command.slice(1), env);
        if (result.error || result.status !== 0) throw new Error(`${entry.command.join(" ")} failed: ${(result.error?.message || result.stderr).trim().slice(0, 300)}`);
        outcome.push({ ...record, status: "done", command: entry.command });
        continue;
      }
      if (entry.contentsOnly) {
        const current = fresh.find((item) => item.category === entry.category);
        if (!current?.eligible || !realDirectoryEntry(entry.path)) { outcome.push({ ...record, status: "skipped", reason: current?.reason || "changed-since-plan" }); continue; }
        for (const child of childEntries(entry.path)) {
          const target = path.join(entry.path, child.name);
          if (!child.isSymbolicLink()) assertInside(entry.path, target);
          fs.rmSync(target, { recursive: true, force: false });
        }
        outcome.push({ ...record, status: "done" });
        continue;
      }
      fs.rmSync(entry.path, { recursive: true, force: false });
      outcome.push({ ...record, status: "done" });
    } catch (error) {
      outcome.push({ ...record, status: "failed", reason: error.message });
    }
  }
  return outcome;
}

/** Read-only status: preference, paths, activity and optional sizes. */
export function xcodeStatus(config, env, { sizes = false, platform = process.platform } = {}) {
  const settings = xcodeSettings(config);
  const paths = xcodePaths(config);
  const report = { schemaVersion: 1, supported: xcodeSupported(platform), settings, derivedDataRoot: paths.derivedData,
    testResults: { path: paths.testResults, retention: "retained", prunable: false } };
  if (!report.supported) return report;
  const preference = readPreference(config, env);
  const receipt = (() => { try { return readReceipt(paths.receipt); } catch (error) { return { invalid: error.message }; } })();
  report.preference = { key: XCODE_DERIVED_DATA_KEY, ...preference, matchesManagedRoot: preference.status === "set" && preference.value === paths.derivedData };
  report.receipt = receipt;
  report.activity = xcodeActivity(config, env);
  const booted = listDevices(config, env, "booted");
  const unavailable = listDevices(config, env, "unavailable");
  report.simulators = { usable: booted.usable, booted: booted.usable ? booted.count : null, unavailable: unavailable.usable ? unavailable.count : null,
    reason: booted.usable ? undefined : booted.reason };
  if (sizes) {
    const scanner = createSizeScanner();
    const measured = { derivedData: paths.derivedData, testResults: paths.testResults,
      simulatorCaches: paths.simulatorCaches, testingDevices: paths.testingDevices,
      ...Object.fromEntries(paths.deviceSupport.map((dir) => [path.basename(dir), dir])) };
    report.sizes = Object.fromEntries(Object.entries(measured).map(([name, dir]) => [name, scanner.measure(dir)]));
    report.sizeNote = "Logical file-name bytes, not space saved. Roots are separate; the totals are not added up.";
  }
  return report;
}

export function xcodeChoiceText(config) {
  const paths = xcodePaths(config);
  return [
    "",
    "Xcode (optional)",
    "Clean Development can also look after Xcode leftovers. Nothing changes unless you say yes.",
    `  1. DerivedData: point Xcode's DerivedData at ${paths.derivedData}.`,
    `     This sets one Xcode preference (${XCODE_DERIVED_DATA_KEY}). The old value is remembered and uninstall restores it.`,
    "     Existing DerivedData is not moved or deleted.",
    "  2. Simulators: enable 'clean-development xcode prune', which removes unavailable simulators, the XCTest device set,",
    "     CoreSimulator caches and old DeviceSupport folders. It is a dry run unless you add --apply; nothing runs automatically.",
    ""
  ].join("\n");
}

/** Ask the two Xcode questions. Default is no; closed input counts as no. */
export async function promptXcodeChoice(config, { input = process.stdin, stream = process.stderr, terminal = true } = {}) {
  stream.write(xcodeChoiceText(config));
  const prompt = createInterface({ input, output: stream, terminal });
  // readline drops lines that arrive while nobody is asking and never settles a pending question when the
  // input closes, so keep our own queue: piped answers all count, and end of input means "no".
  const lines = [];
  let waiting = null;
  let ended = false;
  prompt.on("line", (line) => {
    if (waiting) { const resolve = waiting; waiting = null; resolve(line); } else lines.push(line);
  });
  prompt.on("close", () => {
    ended = true;
    if (waiting) { const resolve = waiting; waiting = null; resolve(null); }
  });
  const next = () => (lines.length ? Promise.resolve(lines.shift()) : ended ? Promise.resolve(null) : new Promise((resolve) => { waiting = resolve; }));
  const ask = async (question) => {
    while (true) {
      stream.write(question);
      const answer = await next();
      if (answer === null) return false;
      const value = answer.trim().toLowerCase();
      if (["", "n", "no"].includes(value)) return false;
      if (["y", "yes"].includes(value)) return true;
      stream.write("Answer y or n.\n");
    }
  };
  try {
    const derivedData = await ask("Manage Xcode DerivedData? [y/N] ");
    const simulators = await ask("Enable simulator and device clean-up? [y/N] ");
    return { derivedData, simulators };
  } finally {
    prompt.close();
  }
}

function describe(entry) {
  const what = entry.count === null || entry.count === undefined ? "" : ` (${entry.count})`;
  const where = entry.path ? ` ${entry.path}` : entry.command ? ` ${entry.command.join(" ")}` : "";
  const when = entry.lastUsedAt ? `, last used ${entry.lastUsedAt.slice(0, 10)}` : "";
  return `${entry.eligible ? "remove" : "keep  "} [${entry.category}] ${entry.label}${what}${where}  -- ${entry.reason}${when}`;
}

export function formatXcodePlan(plan, outcome = null) {
  const lines = [`Xcode prune ${outcome ? "(applied)" : "(dry run; add --apply to act)"}: older than ${plan.olderThanDays} days (${plan.pruneBefore.slice(0, 10)})`];
  if (plan.activity.running) lines.push(`Xcode activity: ${plan.activity.processes.join(", ")} running; DerivedData and DeviceSupport are kept.`);
  else if (plan.activity.unknown) lines.push("Xcode activity could not be determined; DerivedData and DeviceSupport are kept.");
  if (!plan.entries.length) lines.push("Nothing found.");
  for (const entry of plan.entries) lines.push(describe(entry));
  if (outcome) {
    lines.push("Result:");
    for (const item of outcome) lines.push(`  ${item.status}${item.reason ? ` (${item.reason})` : ""} [${item.category}] ${item.label}`);
  }
  return lines.join("\n");
}

export function formatXcodeStatus(report) {
  if (!report.supported) return "Xcode management is available on macOS only.";
  const lines = [
    `Managed: DerivedData ${report.settings.derivedData ? "yes" : "no"}, simulator clean-up ${report.settings.simulators ? "yes" : "no"}${report.settings.decided ? "" : " (never asked; run setup --xcode to opt in)"}`,
    `DerivedData root: ${report.derivedDataRoot}`,
    `Test results root: ${report.testResults.path} (retained; not pruned)`,
    `Xcode preference ${report.preference.key}: ${report.preference.status === "set" ? report.preference.value : report.preference.status}${report.preference.matchesManagedRoot ? " (managed)" : ""}`,
    `Xcode running: ${report.activity.running ? report.activity.processes.join(", ") : report.activity.unknown ? "unknown" : "no"}`,
    `Simulators: ${report.simulators.usable ? `${report.simulators.booted} booted, ${report.simulators.unavailable} unavailable` : `simctl not usable (${report.simulators.reason})`}`
  ];
  if (report.sizes) for (const [name, size] of Object.entries(report.sizes)) {
    const label = name === "testResults" ? "testResults (retained; not pruned)" : name;
    lines.push(`  ${label}: ${size.status === "complete" ? `${size.logicalBytes} bytes` : size.status}`);
  }
  return lines.join("\n");
}
