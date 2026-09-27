import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { environmentForTool } from "./adapters.js";
import { resolveConfig } from "./config.js";
import { VERSION } from "./constants.js";
import { explainCommand } from "./explain.js";
import { canonicalizePotentialPath, environmentValue } from "./platform.js";
import { captureProbeCommand } from "./probe-process.js";

export const PROBE_TOOLS = Object.freeze(["npm", "go", "uv"]);
const QUERIES = Object.freeze({ npm: ["config", "get", "cache"], go: ["env", "-json", "GOCACHE", "GOMODCACHE"], uv: ["cache", "dir", "--offline", "--no-config"] });

function validate(tool, timeoutMs) {
  if (!PROBE_TOOLS.includes(tool)) throw new Error(`probe requires --tool ${PROBE_TOOLS.join("|")}`);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw new Error("Probe timeout must be an integer between 100 and 30000 ms");
}

/** A plan reads configuration and executable metadata only. It does not probe. */
export function planProbe(tool, { cwd = process.cwd(), env = process.env, timeoutMs = 5000 } = {}) {
  validate(tool, timeoutMs);
  const prediction = explainCommand(tool, [], { cwd, env });
  const routing = prediction.routing;
  let status = "not-tested";
  if (["skipped", "disabled", "blocked"].includes(routing.status)) status = routing.status;
  else if (routing.variables.some((item) => item.action === "preserve")) status = "preserved-override";
  else if (!prediction.executable.found) status = "unavailable";
  return { schemaVersion: 1, kind: "isolated-routing-probe", packageVersion: VERSION, tool, status,
    executed: false, executable: prediction.executable, configuredRouting: routing.variables,
    query: [...QUERIES[tool]], timeoutMs, maxOutputBytes: 65536, toolVersion: null, observations: [],
    cleanup: "not-needed", scope: "installed-tool adapter support in disposable storage, not configured-volume or agent-host acceptance",
    limitations: [
      "Without --execute this is a read-only plan; no tool runs and no files are created.",
      "Execution uses a temporary project, cache and tool home. Configured storage and project scripts are not exercised.",
      "A preserved override, skip, disabled project or blocked route is not silently overridden for a probe.",
      "Native offline settings and process cleanup are not a security sandbox; the selected executable must be trusted.",
      "No compilation, dependency installation, arbitrary command, runtime installation or persistence is performed."
    ] };
}

function isolatedProbeEnvironment(root, original) {
  const env = {};
  // Do not forward ambient secrets, runtime preload options, proxies or tool
  // configuration. Keep only executable discovery and essential OS information.
  for (const name of ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "ComSpec"]) {
    const value = environmentValue(original, name);
    if (value !== undefined) env[name] = value;
  }
  const home = path.join(root, "home"), tmp = path.join(root, "tmp");
  for (const directory of [home, tmp]) fs.mkdirSync(directory);
  return { ...env, HOME: home, USERPROFILE: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp,
    XDG_CONFIG_HOME: path.join(home, "config"), XDG_CACHE_HOME: path.join(home, "cache"),
    XDG_DATA_HOME: path.join(home, "data"), XDG_STATE_HOME: path.join(home, "state"),
    APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local"),
    GOENV: "off", GOWORK: "off", GOTOOLCHAIN: "local", GOPROXY: "off", GOSUMDB: "off",
    npm_config_userconfig: path.join(root, "user.npmrc"), npm_config_globalconfig: path.join(root, "global.npmrc"),
    npm_config_offline: "true", npm_config_ignore_scripts: "true", npm_config_audit: "false", npm_config_fund: "false",
    COREPACK_ENABLE_NETWORK: "0", COREPACK_ENABLE_AUTO_PIN: "0", COREPACK_DEFAULT_TO_LATEST: "0",
    UV_OFFLINE: "1", UV_NO_CONFIG: "1", UV_PYTHON_DOWNLOADS: "never", NO_COLOR: "1" };
}

function observedVariables(tool, text) {
  if (tool === "go") {
    const value = JSON.parse(text);
    return { GOCACHE: value?.GOCACHE, GOMODCACHE: value?.GOMODCACHE };
  }
  return { [tool === "npm" ? "npm_config_cache" : "UV_CACHE_DIR"]: text.trim() };
}
function version(tool, text) {
  const prefix = { npm: "", go: "go version go", uv: "uv " }[tool];
  const line = text.trim().split(/\r?\n/, 1)[0];
  if (!line.startsWith(prefix)) return null;
  return line.slice(prefix.length).match(/^(\d+\.\d+\.\d+)(?:[-+\s]|$)/)?.[1] || null;
}

/** Explicitly execute only a fixed native path query in a disposable fixture.
 * This verifies the environment adapter, not the user's configured storage. */
export async function probeTool(tool, { cwd = process.cwd(), env = process.env, execute = false, timeoutMs = 5000 } = {}) {
  if (typeof execute !== "boolean") throw new Error("execute must be boolean");
  const report = planProbe(tool, { cwd, env, timeoutMs });
  if (!execute || report.status !== "not-tested") return report;
  let root = null, rootIdentity = null, cleanupSafe = true;
  try {
    const config = resolveConfig({ cwd, env });
    root = fs.mkdtempSync(path.join(os.tmpdir(), "clean-development-probe-"));
    root = fs.realpathSync.native(root);
    rootIdentity = fs.lstatSync(root, { bigint: true });
    const probeEnv = isolatedProbeEnvironment(root, env);
    const project = path.join(root, "project"); fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, "package.json"), '{"name":"clean-development-probe","private":true}\n');
    fs.writeFileSync(path.join(project, "go.mod"), "module example.invalid/clean-development-probe\n\ngo 1.22\n");
    fs.writeFileSync(probeEnv.npm_config_userconfig, ""); fs.writeFileSync(probeEnv.npm_config_globalconfig, "");
    const isolatedConfig = { ...config, root, cacheRoot: path.join(root, "caches"), buildRoot: path.join(root, "builds"), scratchRoot: path.join(root, "scratch") };
    const route = environmentForTool(tool, [], { config: isolatedConfig, env: probeEnv, cwd: project, create: false });
    const capture = (args) => captureProbeCommand(report.executable.path, args, {
      cwd: project, env: route.env, timeoutMs, maxOutputBytes: report.maxOutputBytes
    });
    report.executed = true;
    const query = await capture(QUERIES[tool]);
    cleanupSafe = query.cleanupComplete;
    if (!query.ok) { report.status = "failed"; report.reason = query.failure; report.interruptedSignal = query.interruptedSignal; return report; }
    const observed = observedVariables(tool, query.stdout);
    for (const [name, expected] of Object.entries(route.applied)) {
      const value = observed[name];
      if (typeof value !== "string" || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value) || !path.isAbsolute(value)) throw new Error("invalid native path response");
      const matches = canonicalizePotentialPath(value) === canonicalizePotentialPath(expected);
      report.observations.push({ name, expected, observed: value, matches, scope: "disposable-fixture" });
    }
    const capturedVersion = await capture(tool === "go" ? ["version"] : ["--version"]);
    cleanupSafe = capturedVersion.cleanupComplete;
    if (!capturedVersion.ok) { report.status = "failed"; report.reason = capturedVersion.failure; report.interruptedSignal = capturedVersion.interruptedSignal; return report; }
    report.toolVersion = version(tool, capturedVersion.stdout);
    if (!report.toolVersion) throw new Error("invalid native version response");
    report.status = report.observations.every((item) => item.matches) ? "observed-working" : "mismatch";
    report.testedAt = new Date().toISOString();
  } catch {
    report.status = "failed"; report.reason = "probe-failed";
  } finally {
    if (root && cleanupSafe) {
      try {
        const current = fs.lstatSync(root, { bigint: true });
        if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== rootIdentity?.dev
          || current.ino !== rootIdentity?.ino || fs.realpathSync.native(root) !== root) throw new Error("fixture changed");
        fs.rmSync(root, { recursive: true, force: true }); report.cleanup = "removed";
      }
      catch { report.cleanup = "failed"; report.retainedFixture = root; report.status = "failed"; report.reason = "cleanup-failed"; }
    } else if (root) {
      report.cleanup = "retained-process-uncertain"; report.retainedFixture = root; report.status = "failed";
    }
  }
  return report;
}

const display = (value) => JSON.stringify(String(value)).slice(1, -1).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
  (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
export function formatProbe(report) {
  const lines = [`Clean Development — ${report.executed ? "isolated probe" : "probe plan (read-only)"}`,
    `Tool: ${display(report.tool)} | Status: ${display(report.status)}`,
    `Executable: ${display(report.executable.path || "not found")}`];
  if (report.toolVersion) lines.push(`Version: ${display(report.toolVersion)}`);
  for (const item of report.observations) lines.push(`${display(item.name)}: ${item.matches ? "matched" : "MISMATCH"} (disposable storage)`);
  if (report.reason) lines.push(`Reason: ${display(report.reason)}`);
  lines.push(`Cleanup: ${display(report.cleanup)}`, `Scope: ${display(report.scope)}`);
  if (report.retainedFixture) lines.push(`Retained fixture: ${display(report.retainedFixture)}`);
  if (!report.executed && report.status === "not-tested") lines.push("Use --execute to run the displayed fixed query in disposable storage.");
  return lines.join("\n");
}
