import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isolatedNativeEnvironment } from "./harness-utils.mjs";
import { snapshotFootprint, compareFootprints } from "./footprint-utils.mjs";
import { verificationSource } from "./verification-utils.mjs";
import { ensureRealDirectory } from "../src/io.js";
import { windowsBatchInvocation } from "../src/windows-command.js";

const repository = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const PREFIX = "clean-development-host-boundaries-";
const HOSTS = new Set(["codex", "claude", "gemini", "antigravity", "opencode", "aws", "other"]);
export const HOST_BOUNDARY_HELP = "Usage: verify-host-boundaries.mjs plan|prepare --host NAME --scratch-root ABS; preflight --lab ABS --executable ABS; execute --lab ABS --operation install|update --executable ABS --expect-artifact outputs/REL [--allow-growth config,data,cache,state,tmp,outputs] -- ARGS...";

export function hostBoundaryEnvironment(root, inherited = process.env) {
  // Credentials, shell startup injection and inherited agent profiles do not
  // enter native verification. Installed executable/toolchain choices do.
  const allowed = ["PATH", "SystemRoot", "ComSpec", "PATHEXT", "DEVELOPER_DIR", "SDKROOT", "RUSTUP_HOME", "RUSTUP_TOOLCHAIN", "RUSTC", "CC", "CXX", "GOTOOLCHAIN"];
  const selected = Object.fromEntries(allowed.filter((key) => inherited[key] !== undefined).map((key) => [key, inherited[key]]));
  return isolatedNativeEnvironment(root, selected, { overrides: {
    CI: "1", TERM: "dumb", NO_COLOR: "1", LANG: "C.UTF-8", DISABLE_AUTOUPDATER: "1", DISABLE_UPDATES: "1",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "native-config", "gitconfig"),
    npm_config_offline: "true", npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false"
  } });
}

export function boundaryRoots(item) {
  const env = hostBoundaryEnvironment(item.root, {});
  return [
    ["home", env.HOME], ["config", env.XDG_CONFIG_HOME], ["data", env.XDG_DATA_HOME],
    ["cache", env.XDG_CACHE_HOME], ["state", env.XDG_STATE_HOME], ["tmp", env.TMPDIR], ["outputs", path.join(item.root, "outputs")]
  ].map(([name, location]) => ({ name, path: location }));
}

export function boundaryPlan({ host, scratchRoot }) {
  if (!HOSTS.has(host)) throw new Error("Select a supported host boundary label");
  if (typeof scratchRoot !== "string" || !path.isAbsolute(scratchRoot)) throw new Error("An absolute reviewed scratch root is required");
  const root = path.resolve(scratchRoot);
  if (root === path.parse(root).root || root === path.resolve(os.homedir()) || root === repository || root.startsWith(`${repository}${path.sep}`)) {
    throw new Error("A dedicated scratch root outside source is required");
  }
  if (!ensureRealDirectory(root, { label: "Host verification scratch root" })) throw new Error("Host verification scratch root is missing");
  return { schemaVersion: 1, kind: "host-boundary-plan", host, scratchRoot: root, disposablePrefix: PREFIX,
    automaticHostLaunch: false, modelCalls: false, execution: "explicit phase only", cleanup: "none", source: verificationSource(repository) };
}

export function prepareBoundaryLab(options) {
  const plan = boundaryPlan(options), root = fs.mkdtempSync(path.join(plan.scratchRoot, PREFIX));
  const item = { schemaVersion: 1, owner: "clean-development-host-boundaries", root, host: plan.host, scratchRoot: plan.scratchRoot,
    createdAt: new Date().toISOString(), source: plan.source };
  for (const selected of boundaryRoots(item)) fs.mkdirSync(selected.path, { recursive: true });
  fs.mkdirSync(path.join(root, "project")); fs.mkdirSync(path.join(root, "evidence"));
  fs.writeFileSync(path.join(root, "boundary.json"), `${JSON.stringify(item, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return item;
}

export function loadBoundaryLab(root) {
  if (typeof root !== "string" || !path.isAbsolute(root) || !path.basename(root).startsWith(PREFIX)) throw new Error("Use an exact prepared boundary lab");
  if (!ensureRealDirectory(root, { label: "Host boundary lab" })) throw new Error("Host boundary lab is missing");
  const file = path.join(root, "boundary.json"), stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error("Invalid boundary lab metadata");
  const item = JSON.parse(fs.readFileSync(file, "utf8"));
  if (item.schemaVersion !== 1 || item.owner !== "clean-development-host-boundaries" || item.root !== path.resolve(root)
    || item.scratchRoot !== path.dirname(item.root) || !HOSTS.has(item.host)) throw new Error("Invalid boundary lab identity");
  for (const directory of [...boundaryRoots(item).map((entry) => entry.path), path.join(root, "project"), path.join(root, "evidence")]) {
    if (!ensureRealDirectory(directory, { label: "Host boundary directory" })) throw new Error("Boundary directory is missing");
  }
  return item;
}

function executableFile(executable) {
  if (typeof executable !== "string" || !path.isAbsolute(executable)) throw new Error("Choose an absolute installed executable");
  // Installed executable aliases are allowed; output/root aliases are not.
  fs.accessSync(executable, fs.constants.X_OK);
  if (!fs.statSync(executable).isFile()) throw new Error("Installed executable must be a file");
}

function child(item, executable, args, { timeoutMs = 10000, inherited = process.env } = {}) {
  executableFile(executable);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error("Host boundary timeout must be 1 to 60000 ms");
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) throw new Error("Executable arguments must be strings without NUL");
  const env = hostBoundaryEnvironment(item.root, inherited);
  const invocation = process.platform === "win32" && /\.(cmd|bat)$/i.test(executable) ? windowsBatchInvocation(executable, args, env) : { command: executable, args };
  const result = spawnSync(invocation.command, invocation.args, { cwd: path.join(item.root, "project"), env, encoding: "utf8", timeout: timeoutMs,
    maxBuffer: 256 * 1024, detached: process.platform !== "win32", windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments || false, killSignal: "SIGKILL" });
  let cleanupComplete = true;
  if ((result.error || result.status !== 0) && process.platform !== "win32" && Number.isInteger(result.pid) && result.pid > 0) {
    try { process.kill(-result.pid, "SIGKILL"); } catch (error) { cleanupComplete = error.code === "ESRCH"; }
  }
  let lifetime = process.platform === "win32" ? "not-observed-on-windows" : "unknown";
  if (process.platform !== "win32" && Number.isInteger(result.pid) && result.pid > 0) {
    try {
      process.kill(-result.pid, 0);
      lifetime = "active-process-group"; cleanupComplete = false;
    } catch (error) {
      lifetime = error.code === "ESRCH" ? "quiescent-process-group" : "process-group-uncertain";
      cleanupComplete = cleanupComplete && error.code === "ESRCH";
    }
  }
  return { result, observed: { exitStatus: result.status, signal: result.signal,
    errorCode: /^[A-Z0-9_]+$/.test(result.error?.code || "") ? result.error.code : result.error ? "CHILD_ERROR" : null,
    cleanupComplete, lifetime, ok: !result.error && result.status === 0 && cleanupComplete } };
}

function persistReport(item, report) {
  const file = path.join(item.root, "evidence", `${report.operation}-${Date.now()}-${process.pid}.json`);
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return { ...report, reportFile: file };
}

export function preflightHostBoundary(item, executable, options = {}) {
  item = loadBoundaryLab(item.root);
  const source = verificationSource(repository), roots = boundaryRoots(item), before = snapshotFootprint(roots, { limits: options.limits });
  const version = child(item, executable, ["--version"], options), help = child(item, executable, ["--help"], options);
  const text = version.result.stdout.trim(), match = text.length <= 1024 && /(?:^|\s)(\d+\.\d+(?:\.\d+)?(?:[-+][a-zA-Z0-9.-]+)?)(?:\s|$)/.exec(text);
  const exactVersion = version.observed.ok && match ? match[1] : null;
  const after = snapshotFootprint(roots, { limits: options.limits }), footprint = compareFootprints(before, after);
  const sourceUnchanged = source.fingerprint === verificationSource(repository).fingerprint;
  return persistReport(item, { schemaVersion: 1, kind: "host-boundary-verification", operation: "preflight", host: item.host,
    source, sourceUnchanged, environment: { platform: process.platform, arch: process.arch, node: process.version, osRelease: os.release() },
    version: exactVersion, versionCommand: version.observed, helpCommand: help.observed,
    capabilities: { resume: /\bresume\b/.test(help.result.stdout), fork: /\bfork\b/.test(help.result.stdout),
      shellConfigOverride: /(?:--config|\s-c[ ,])/.test(help.result.stdout), loginShell: /allow_login_shell|login.shell/.test(help.result.stdout) },
    before, after, footprint, ok: Boolean(exactVersion && help.observed.ok && footprint.complete && sourceUnchanged),
    liveAcceptance: "not-run", authentication: "not-inspected", modelCalls: false,
    boundary: "Installed version/help in a disposable profile; no model, lifecycle, installer or updater acceptance" });
}

function artifactDetails(item, relative) {
  if (typeof relative !== "string" || path.isAbsolute(relative)) throw new Error("Declare an artifact relative to outputs/");
  const output = path.join(item.root, "outputs"), target = path.resolve(item.root, relative);
  if (!target.startsWith(`${output}${path.sep}`)) throw new Error("Artifact must be within declared outputs");
  if (!ensureRealDirectory(output, { label: "Declared output directory" })) throw new Error("Declared output directory is missing");
  let current = path.dirname(target);
  while (current !== output) {
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Artifact directory must be real");
    current = path.dirname(current);
  }
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error("Declared artifact must be a nonempty regular file");
  return { relativePath: relative, identity: { dev: String(stat.dev), ino: String(stat.ino) }, logicalBytes: stat.size, modifiedAt: stat.mtime.toISOString() };
}

export function executeHostBoundary(item, { operation, executable, args, expectArtifact, allowGrowth = ["config", "data", "cache", "state", "tmp", "outputs"], ...options }) {
  if (!["install", "update"].includes(operation)) throw new Error("Only explicitly requested install/update phases are executable");
  item = loadBoundaryLab(item.root);
  const roots = boundaryRoots(item), names = new Set(roots.map((root) => root.name));
  if (!Array.isArray(allowGrowth) || allowGrowth.some((name) => !names.has(name))) throw new Error("Allowed growth must use selected root names");
  // Validate the declared artifact destination even before a child runs.
  if (typeof expectArtifact !== "string" || path.isAbsolute(expectArtifact) || !path.resolve(item.root, expectArtifact).startsWith(`${path.join(item.root, "outputs")}${path.sep}`)) {
    throw new Error("An outputs/ artifact is required before execution");
  }
  const source = verificationSource(repository), before = snapshotFootprint(roots, { limits: options.limits });
  if (!before.complete) return persistReport(item, { schemaVersion: 1, kind: "host-boundary-verification", operation, host: item.host,
    source, before, ok: false, child: null, reason: "incomplete-before-observation", outputsPreserved: true });
  let artifactBefore = null;
  const declaredPath = path.resolve(item.root, expectArtifact);
  let existing;
  try { existing = fs.lstatSync(declaredPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (existing) {
    try { artifactBefore = artifactDetails(item, expectArtifact); }
    catch { return persistReport(item, { schemaVersion: 1, kind: "host-boundary-verification", operation, host: item.host,
      source, before, ok: false, child: null, reason: "existing-artifact-unsafe", outputsPreserved: true }); }
    if (operation === "install") return persistReport(item, { schemaVersion: 1, kind: "host-boundary-verification", operation, host: item.host,
      source, before, artifactBefore, ok: false, child: null, reason: "install-artifact-already-exists", outputsPreserved: true });
  }
  const execution = child(item, executable, args, options), after = snapshotFootprint(roots, { limits: options.limits });
  const footprint = compareFootprints(before, after), unexpected = footprint.deltas.filter((delta) => delta.changed && !allowGrowth.includes(delta.name)).map((delta) => delta.name);
  let artifact = null, artifactError = null;
  try { artifact = artifactDetails(item, expectArtifact); } catch { artifactError = "declared-artifact-missing-or-unsafe"; }
  const sourceUnchanged = source.fingerprint === verificationSource(repository).fingerprint;
  const artifactFreshness = !artifact ? "missing-or-unsafe" : !artifactBefore ? "created" : JSON.stringify(artifactBefore) === JSON.stringify(artifact) ? "unchanged" : "metadata-changed";
  return persistReport(item, { schemaVersion: 1, kind: "host-boundary-verification", operation, host: item.host,
    source, sourceUnchanged, child: execution.observed, before, after, footprint, allowedGrowth: allowGrowth, unexpected,
    artifactBefore, artifact, artifactFreshness, artifactError,
    phaseAcceptance: artifactFreshness === "unchanged" ? "no-op-boundary-observed" : "artifact-boundary-observed",
    ok: execution.observed.ok && footprint.complete && unexpected.length === 0 && Boolean(artifact) && sourceUnchanged,
    outputsPreserved: true, cleanup: "none", commandRecording: false, liveAcceptance: "installer-boundary-only",
    boundary: "Caller-selected executable and argv run unchanged in disposable native homes; selected roots only, no sandbox or whole-disk claim" });
}

export function main(args) {
  const phase = args.shift();
  if (phase === "--help") { console.log(HOST_BOUNDARY_HELP); return 0; }
  if (!["plan", "prepare", "preflight", "execute"].includes(phase)) throw new Error(HOST_BOUNDARY_HELP);
  const parsed = {}, commandArgs = [];
  while (args.length) {
    const key = args.shift();
    if (key === "--") { commandArgs.push(...args); break; }
    if (!["--host", "--scratch-root", "--lab", "--executable", "--operation", "--expect-artifact", "--allow-growth"].includes(key) || Object.hasOwn(parsed, key)) throw new Error(HOST_BOUNDARY_HELP);
    const value = args.shift(); if (!value || value.startsWith("--")) throw new Error(HOST_BOUNDARY_HELP); parsed[key] = value;
  }
  let report;
  if (["plan", "prepare"].includes(phase)) {
    if (commandArgs.length) throw new Error(HOST_BOUNDARY_HELP);
    const options = { host: parsed["--host"], scratchRoot: parsed["--scratch-root"] };
    report = phase === "plan" ? boundaryPlan(options) : prepareBoundaryLab(options);
  } else {
    const item = loadBoundaryLab(parsed["--lab"]);
    if (phase === "preflight") {
      if (commandArgs.length) throw new Error("Preflight accepts version/help only");
      report = preflightHostBoundary(item, parsed["--executable"]);
    } else report = executeHostBoundary(item, { operation: parsed["--operation"], executable: parsed["--executable"], args: commandArgs,
      expectArtifact: parsed["--expect-artifact"], ...(parsed["--allow-growth"] ? { allowGrowth: parsed["--allow-growth"].split(",") } : {}) });
  }
  console.log(JSON.stringify(report, null, 2)); return report.ok === false ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.length > 2) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch { console.error("Host boundary verification failed; inspect the prepared lab or invocation."); process.exitCode = 1; }
}
