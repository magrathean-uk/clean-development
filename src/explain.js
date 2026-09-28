import fs from "node:fs";
import path from "node:path";
import { environmentForTool } from "./adapters.js";
import { resolveConfig } from "./config.js";
import { SHIM_TOOLS } from "./constants.js";
import { environmentValue, platformPaths } from "./platform.js";
import { isInjectedEnvironmentValue } from "./routing-environment.js";
import { resolveExecutable } from "./runtime.js";
import { environmentWithoutSessionRouting, normalizeSessionMode, planSession } from "./session.js";
import { identifyWorkspace } from "./workspace.js";
import { inspectNativeCacheOptions } from "./native-cache-options.js";
import { commandStorageConflicts } from "./routing-context.js";

function executablePlan(command, env, binDir, cwd) {
  const hasPath = command.includes(path.sep) || (process.platform === "win32" && command.includes("/"));
  const selected = resolveExecutable(hasPath ? path.resolve(cwd, command) : command, env, binDir, cwd);
  try {
    if (!selected || !fs.statSync(selected).isFile()) return { path: selected, found: false };
    fs.accessSync(selected, fs.constants.X_OK);
    return { path: selected, found: true };
  } catch {
    return { path: selected, found: false };
  }
}

function explicitTarget(args) {
  for (let index = 0; index < args.length && args[index] !== "--"; index += 1) {
    if (args[index] === "--target-dir") return args[index + 1] || null;
    if (args[index].startsWith("--target-dir=")) return args[index].slice("--target-dir=".length);
  }
  return null;
}

/** Predict the wrapper's environment without running tools, preparing storage,
 * materialising shims, recording commands or claiming actual native-tool writes. */
export function explainCommand(command, args = [], { cwd = process.cwd(), env = process.env, mode } = {}) {
  if (typeof command !== "string" || !command) throw new Error("explain requires a command after --");
  const requested = normalizeSessionMode(mode);
  if (requested === "persist") throw new Error("Use session --dry-run to review persistence; explain supports session-only or skip");
  const inherited = normalizeSessionMode(environmentValue(env, "CLEAN_DEVELOPMENT_SESSION_MODE"));
  const selected = requested || (inherited === "persist" ? "session-only" : inherited) || "session-only";
  const locations = platformPaths(env);
  const supported = SHIM_TOOLS.includes(command);
  const report = {
    schemaVersion: 1,
    kind: "prediction",
    scope: "wrapped child command, not the current parent shell or an agent host",
    command,
    cwd: path.resolve(cwd),
    session: { mode: selected, source: requested ? "argument" : inherited ? "environment" : "noninteractive run default" },
    executable: null,
    supportedShim: supported,
    workspace: null,
    configuration: null,
    routing: { status: "skipped", variables: [], commandLineTarget: null },
    limitations: [
      "No command was executed and no files were created or changed.",
      "This predicts environment routing, not observed output paths. Tool flags and native configuration may take precedence.",
      "Source files, project-local dependencies and arbitrary script output are not relocated or sandboxed."
    ]
  };
  if (selected === "skip") {
    report.executable = executablePlan(command, environmentWithoutSessionRouting(env, locations.binDir), locations.binDir, cwd);
    return report;
  }
  const initialConfig = resolveConfig({ cwd, env });
  const workspace = identifyWorkspace(command, args, cwd);
  const config = initialConfig.enabled !== false && supported && workspace.effectiveCwd !== path.resolve(cwd)
    ? resolveConfig({ cwd: workspace.effectiveCwd, env }) : initialConfig;
  report.workspace = { ...workspace, authority: command === "cargo" ? "static estimate; Cargo may resolve a different root at dispatch" : "local manifest discovery" };
  report.configuration = {
    projectConfig: config.projectConfigPath,
    paths: Object.fromEntries(["root", "cacheRoot", "buildRoot", "scratchRoot"].map((key) => [key, {
      path: config[key], source: config.pathSources[key]
    }]))
  };
  const disabled = initialConfig.enabled === false || config.enabled === false || (supported && config.tools?.[command] === false);
  if (disabled) {
    report.routing.status = "disabled";
    report.executable = executablePlan(command, environmentWithoutSessionRouting(env, locations.binDir), locations.binDir, cwd);
    return report;
  }
  const plan = planSession({ cwd, env, config: initialConfig });
  report.executable = executablePlan(command, env, locations.binDir, cwd);
  if (plan.managed.repositoryPaths.length || (supported && commandStorageConflicts(config, cwd, workspace).length)) {
    report.routing.status = "blocked";
    report.routing.reason = "Managed storage must be outside the project for session-only routing";
    return report;
  }
  report.routing.status = supported ? "predicted" : "indirect";
  const preview = supported ? environmentForTool(command, args, { config, cwd, env, create: false }) : null;
  const applied = preview?.applied || plan.managed.environment;
  const preserved = preview?.preserved || plan.managed.preserved;
  for (const [name, value] of Object.entries(applied)) {
    const injected = Object.entries(env).some(([key, item]) => key.toLowerCase() === name.toLowerCase() && isInjectedEnvironmentValue(env, key, item));
    const forced = environmentValue(env, "CLEAN_DEVELOPMENT_FORCE") === "1";
    // Fixed policy values come from the adapter, not the configurable cache root.
    const fixedYarnSetting = name === "YARN_ENABLE_GLOBAL_CACHE" || name === "YARN_ENABLE_MIRROR";
    report.routing.variables.push({ name, value, action: "set",
      source: fixedYarnSetting ? "adapter: yarn" : config.pathSources[name === "CARGO_TARGET_DIR" ? "buildRoot" : "cacheRoot"],
      reason: forced ? "explicit force mode" : injected ? "reroute unchanged Clean Development value"
        : fixedYarnSetting ? "fixed adapter setting" : "configured adapter destination" });
  }
  for (const [name, value] of Object.entries(preserved)) {
    report.routing.variables.push({ name, value, action: "preserve", source: "environment", reason: "explicit user override" });
  }
  const nativeCacheOptions = inspectNativeCacheOptions(command, args);
  if (nativeCacheOptions) {
    report.routing.nativeCacheOptions = nativeCacheOptions;
    if (nativeCacheOptions.declarations.length > 0) report.limitations.push("Native cache inspection covers only leading recognised options; command arguments and unknown options stop inspection. Declarations are not observed write locations.");
  }
  if (command === "cargo") {
    report.routing.commandLineTarget = explicitTarget(args);
    report.limitations.push("Cargo workspace discovery, ownership checks and active leases are deferred until actual dispatch. The displayed Cargo target is provisional.");
    if (report.routing.commandLineTarget) report.limitations.push("--target-dir takes precedence over CARGO_TARGET_DIR; managed ownership checks still apply at dispatch.");
  }
  if (!supported) report.limitations.push("No top-level adapter handles this command. Detected session caches are shown; routing of nested commands depends on PATH and cannot be proven statically.");
  if (!report.executable.found) report.limitations.push("The executable was not found; no installation or repair was attempted.");
  report.routing.variables.sort((a, b) => a.name.localeCompare(b.name));
  return report;
}

export { formatExplanation } from "./diagnostic-formatters.js";
