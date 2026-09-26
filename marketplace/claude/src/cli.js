import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { allToolEnvironments, environmentForTool } from "./adapters.js";
import { resolveConfig, writeProjectConfig, writeUserConfig } from "./config.js";
import { CONFIG_FILE, DEFAULT_CONFIG, SHIM_TOOLS, SUPPORTED_AGENTS, VERSION } from "./constants.js";
import { installAgentIntegrations, integrationStatus, applyClaudeSessionEnvironment, removeOwnedAgentIntegrations, validateClaudeHookOwner } from "./integrations.js";
import { acquireDirectoryLock, directorySize, readJson, writeJsonAtomic } from "./io.js";
import { environmentValue, platformPaths, prependUniquePath } from "./platform.js";
import { ensureRuntime, removeRuntime, resolveExecutable, runTool, runWithShims, runtimeHealth, runtimeRemovalPlan } from "./runtime.js";
import { applySessionPlan, deferSessionRouting, normalizeSessionMode, planSession, selectSessionMode } from "./session.js";
import { acquireWorkspaceLock, activeWorkspaceIds, applyPrune, listWorkspaceRecords, prunePlan } from "./state.js";

const HELP = `clean-development ${VERSION}

Keep new development caches and supported build output in one managed place.

Usage:
  clean-development setup [--root PATH] [--agents LIST] [--dry-run] [--json]
  clean-development update [--root PATH] [--agents LIST] [--dry-run] [--json]
  clean-development prepare [--dry-run] [--json]
  clean-development session [--session session-only|persist|skip] [--dry-run] [--json]
  clean-development init [--root PATH] [--force]
  clean-development agent AGENT [--session session-only|persist|skip] [-- ARGS...]
  clean-development run [--session session-only|persist|skip] -- COMMAND [ARGS...]
  clean-development env [--tool TOOL] [--format json|sh|fish|powershell]
  clean-development status [--sizes] [--json]
  clean-development doctor [--json]
  clean-development prune [--older-than DAYS] [--apply] [--json]
  clean-development pin WORKSPACE_ID | unpin WORKSPACE_ID
  clean-development uninstall [--dry-run] [--json]

Use COMMAND --help for help. Put child command options after --.
Interactive launches offer session only (Enter), save project settings, or skip.
Noninteractive launches default to session-only; native integrations default to skip.

Agents:
  ${Object.keys(SUPPORTED_AGENTS).join(", ")}

The default prune is a dry run. Explicit environment variables are preserved unless
CLEAN_DEVELOPMENT_FORCE=1 is set.`;

const COMMAND_OPTIONS = Object.freeze({
  help: {},
  version: {},
  setup: { root: "value", agents: "value", "dry-run": "boolean", json: "boolean" },
  update: { root: "value", agents: "value", "dry-run": "boolean", json: "boolean" },
  prepare: { "dry-run": "boolean", json: "boolean" },
  session: { session: "value", "dry-run": "boolean", json: "boolean" },
  init: { root: "value", force: "boolean", json: "boolean" },
  agent: { session: "value" },
  run: { session: "value" },
  shim: {},
  hook: { owner: "value" },
  env: { tool: "value", format: "value" },
  status: { sizes: "boolean", json: "boolean" },
  doctor: { json: "boolean" },
  prune: { "older-than": "value", apply: "boolean", json: "boolean" },
  pin: { json: "boolean" },
  unpin: { json: "boolean" },
  uninstall: { "dry-run": "boolean", json: "boolean" }
});

function parse(argv, optionTypes) {
  const options = {};
  const positionals = [];
  let passthrough = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--") {
      passthrough = argv.slice(index + 1);
      break;
    }
    if (value.startsWith("--")) {
      const equals = value.indexOf("=");
      const key = value.slice(2, equals === -1 ? undefined : equals);
      if (!Object.hasOwn(optionTypes, key)) throw new Error(`Unknown option '--${key}'`);
      const type = optionTypes[key];
      if (Object.hasOwn(options, key)) throw new Error(`Option '--${key}' was provided more than once`);
      if (type === "boolean") {
        if (equals !== -1) throw new Error(`Option '--${key}' does not take a value`);
        options[key] = true;
      } else if (equals !== -1) {
        const optionValue = value.slice(equals + 1);
        if (!optionValue) throw new Error(`Option '--${key}' requires a value`);
        options[key] = optionValue;
      } else if (argv[index + 1] && !argv[index + 1].startsWith("-")) {
        options[key] = argv[++index];
      } else {
        throw new Error(`Option '--${key}' requires a value`);
      }
    } else positionals.push(value);
  }
  return { options, positionals, passthrough };
}

function validateArguments(command, parsed) {
  const { positionals, passthrough } = parsed;
  const noArguments = ["help", "version", "setup", "update", "prepare", "session", "init", "env", "status", "doctor", "prune", "uninstall"];
  if (noArguments.includes(command) && (positionals.length > 0 || passthrough.length > 0)) {
    throw new Error(`${command} does not accept positional arguments`);
  }
  if (["pin", "unpin"].includes(command) && (positionals.length !== 1 || passthrough.length > 0)) {
    throw new Error(`${command} requires exactly one workspace ID`);
  }
  if (command === "agent") {
    if (positionals.length < 1) throw new Error("agent requires an agent name");
    if (passthrough.length > 0 && positionals.length !== 1) throw new Error("Put agent arguments after a single '--' separator");
  }
  if (command === "run") {
    if (positionals.length === 0 && passthrough.length === 0) throw new Error(`${command} requires a command`);
    if (positionals.length > 0 && passthrough.length > 0) throw new Error(`Put the command and all arguments after a single '--' separator`);
  }
  if (command === "shim") {
    if (positionals.length < 1) throw new Error("shim requires a tool name");
    if (passthrough.length > 0 && positionals.length !== 1) throw new Error("Put shim arguments after a single '--' separator");
  }
  if (command === "hook" && (positionals.length !== 1 || positionals[0] !== "session-start" || passthrough.length > 0)) {
    throw new Error("hook requires exactly 'session-start'");
  }
}

function output(value, json = false) {
  if (json || typeof value !== "string") console.log(JSON.stringify(value, null, 2));
  else console.log(value);
}

function splitAgents(value) {
  if (!value || value === "all") return Object.keys(SUPPORTED_AGENTS);
  const agents = String(value).split(",").map((item) => item.trim()).filter(Boolean);
  if (!agents.length) throw new Error("--agents requires 'all' or a comma-separated list of supported agents");
  for (const agent of agents) if (!Object.hasOwn(SUPPORTED_AGENTS, agent)) throw new Error(`Unsupported agent '${agent}'`);
  return [...new Set(agents)];
}

function setupPlan(options, env) {
  const current = resolveConfig({ env, overrides: options.root ? { root: path.resolve(options.root) } : {}, includeProject: false });
  const agents = splitAgents(options.agents);
  return { config: current, agents };
}

function ensureManagedBase(directory) {
  const validate = () => {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Managed path is not a real directory: ${directory}`);
  };
  if (fs.existsSync(directory)) return validate();
  const parent = path.dirname(directory);
  if (!fs.existsSync(parent) || !fs.lstatSync(parent).isDirectory()) {
    throw new Error(`Parent directory is unavailable for ${directory}. Mount or create ${parent} first.`);
  }
  try {
    fs.mkdirSync(directory);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  validate();
}

async function setup(options, env) {
  const { config, agents } = setupPlan(options, env);
  const summary = {
    root: config.root,
    cacheRoot: config.cacheRoot,
    buildRoot: config.buildRoot,
    scratchRoot: config.scratchRoot,
    agents,
    dryRun: Boolean(options["dry-run"])
  };
  if (options["dry-run"]) return summary;
  const releaseLock = await acquireDirectoryLock(path.join(config.locations.stateDir, "setup.lock"));
  try {
    for (const directory of [...new Set([config.root, config.cacheRoot, config.buildRoot, config.scratchRoot])]) ensureManagedBase(directory);
    fs.mkdirSync(config.locations.stateDir, { recursive: true });
    config.agents = agents;
    summary.configFile = writeUserConfig(config, env);
    const persisted = resolveConfig({ env, includeProject: false });
    const runtime = ensureRuntime(persisted);
    summary.runtime = { version: VERSION, binDir: runtime.binDir };
    summary.integrations = installAgentIntegrations(persisted, runtime, agents, env);
    return summary;
  } finally {
    releaseLock();
  }
}

async function update(options, env) {
  const current = resolveConfig({
    env,
    overrides: options.root ? { root: path.resolve(options.root) } : {},
    includeProject: false
  });
  const configuredAgents = Array.isArray(current.agents) && current.agents.length > 0
    ? current.agents
    : Object.keys(SUPPORTED_AGENTS);
  const agents = options.agents ? splitAgents(options.agents) : configuredAgents;
  const summary = await setup({ ...options, agents: agents.join(",") }, env);
  return { ...summary, command: "update" };
}

function prepare(options, env, cwd = process.cwd()) {
  const config = resolveConfig({ cwd, env });
  const directories = [...new Set([config.root, config.cacheRoot, config.buildRoot, config.scratchRoot])];
  const result = { dryRun: Boolean(options["dry-run"]), projectConfig: config.projectConfigPath, directories };
  if (!result.dryRun) for (const directory of directories) ensureManagedBase(directory);
  return result;
}

function projectInit(options, cwd) {
  const file = path.join(cwd, CONFIG_FILE);
  const value = {};
  if (options.root) value.root = path.resolve(options.root);
  writeProjectConfig(file, value, { force: Boolean(options.force) });
  return { file, config: readJson(file) };
}

function renderSessionPlan(plan, stream = process.stderr) {
  const tools = plan.detected.tools.length ? plan.detected.tools.join(", ") : "no supported manifests";
  stream.write(`\nClean Development session plan\n`);
  stream.write(`Project: ${plan.projectRoot}\n`);
  stream.write(`Detected: ${tools}\n`);
  stream.write(`Caches: ${plan.managed.cacheRoot}\n`);
  stream.write(`Builds: ${plan.managed.buildRoot}\n`);
  if (plan.managed.repositoryPaths.length) {
    stream.write(`Blocked repository storage: ${plan.managed.repositoryPaths.join(", ")}\n`);
  }
  if (plan.detected.conflicts.length) {
    for (const conflict of plan.detected.conflicts) stream.write(`Conflict: ${conflict.reason} (${conflict.tools.join(", ")})\n`);
  }
  if (plan.projectConfig.status === "proposed") {
    stream.write(`Persist would create ${plan.projectConfig.path}:\n${plan.projectConfig.proposedContents}`);
  } else if (plan.projectConfig.status === "existing") {
    stream.write(`Project settings already exist: ${plan.projectConfig.path}\n`);
  } else {
    stream.write(`Persist unavailable: ${plan.projectConfig.reason}\n`);
  }
}

async function promptSessionChoice(plan, input = process.stdin, stream = process.stderr) {
  renderSessionPlan(plan, stream);
  const prompt = createInterface({ input, output: stream, terminal: true });
  try {
    while (true) {
      let answer;
      try {
        answer = (await prompt.question("Choose [1] session only (default), [2] save project settings, or [3] skip: ")).trim().toLowerCase();
      } catch {
        return "skip";
      }
      if (["", "1", "session", "session-only"].includes(answer)) {
        if (plan.choices.find((item) => item.mode === "session-only")?.available) return "session-only";
        stream.write("Session-only is unavailable until managed storage is moved outside the project.\n");
        continue;
      }
      if (["2", "persist", "save"].includes(answer)) {
        if (plan.choices.find((item) => item.mode === "persist")?.available) return "persist";
        stream.write(`Save is unavailable${plan.projectConfig.reason ? `: ${plan.projectConfig.reason}` : " until managed storage is moved outside the project"}.\n`);
        continue;
      }
      if (["3", "skip", "no"].includes(answer)) return "skip";
      stream.write("Enter 1, 2, or 3.\n");
    }
  } finally {
    prompt.close();
  }
}

async function sessionDecision(options, config, env, cwd = process.cwd()) {
  normalizeSessionMode(options.session);
  const plan = planSession({ cwd, env, config });
  if (options["dry-run"]) return { dryRun: true, plan };
  const inherited = environmentValue(env, "CLEAN_DEVELOPMENT_SESSION_MODE");
  const interactive = config.enabled !== false && !options.session && !inherited && Boolean(process.stdin.isTTY && process.stderr.isTTY);
  const choice = interactive ? await promptSessionChoice(plan) : null;
  const mode = config.enabled === false ? "skip" : selectSessionMode({ requested: options.session, env, interactive, choice });
  const applied = applySessionPlan(plan, mode, env);
  const result = {
    dryRun: false,
    mode,
    plan,
    projectConfig: applied.projectConfig
  };
  Object.defineProperty(result, "env", { value: applied.env, enumerable: false });
  return result;
}

function quoteShell(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function formatEnvironment(values, format) {
  if (format === "json") return JSON.stringify(values, null, 2);
  if (format === "fish") return Object.entries(values).map(([key, value]) => `set -gx ${key} ${quoteShell(value)};`).join("\n");
  if (format === "powershell") return Object.entries(values).map(([key, value]) => `$env:${key} = '${String(value).replaceAll("'", "''")}'`).join("\n");
  return Object.entries(values).map(([key, value]) => `export ${key}=${quoteShell(value)}`).join("\n");
}

function envCommand(options, config, env) {
  const format = options.format || "json";
  if (!["json", "sh", "fish", "powershell"].includes(format)) {
    throw new Error(`Unsupported environment format '${format}'; use json, sh, fish, or powershell`);
  }
  if (options.tool) {
    if (!SHIM_TOOLS.includes(options.tool)) throw new Error(`Unsupported tool '${options.tool}'`);
    if (options.tool === "cargo") throw new Error("Cargo build output needs ownership and an active lease; use 'clean-development run -- cargo …' or the cargo shim");
    const result = environmentForTool(options.tool, [], { config, env, create: false, validateBase: true });
    return formatEnvironment({ ...result.applied, CLEAN_DEVELOPMENT_RESOLVED_ROOT: config.root, CLEAN_DEVELOPMENT_WORKSPACE_ID: result.workspace.id }, format);
  }
  const runtime = ensureRuntime(config);
  return formatEnvironment({
    PATH: prependUniquePath(environmentValue(env, "PATH"), runtime.binDir),
    CLEAN_DEVELOPMENT_ACTIVE: "1"
  }, format);
}

function statusCommand(options, config) {
  const records = listWorkspaceRecords(config).map(({ value }) => value);
  const result = {
    version: VERSION,
    configured: fs.existsSync(config.locations.configPath),
    configFile: config.locations.configPath,
    projectConfig: config.projectConfigPath,
    root: config.root,
    rootSource: config.rootSource,
    cacheRoot: config.cacheRoot,
    buildRoot: config.buildRoot,
    scratchRoot: config.scratchRoot,
    runtime: readJson(path.join(config.locations.stateDir, "runtime.json"), null),
    integrations: integrationStatus(config).integrations,
    workspaces: records.length,
    activeWorkspaces: [...activeWorkspaceIds(config)]
  };
  if (options.sizes) {
    result.bytes = {
      caches: directorySize(config.cacheRoot),
      builds: directorySize(config.buildRoot),
      scratch: directorySize(config.scratchRoot)
    };
  }
  return result;
}

function doctorCommand(config, env) {
  const checks = [];
  checks.push({ name: "config", ok: fs.existsSync(config.locations.configPath), detail: config.locations.configPath });
  for (const key of ["root", "cacheRoot", "buildRoot", "scratchRoot"]) {
    const directory = config[key];
    let ok = false;
    let detail = directory;
    try {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("not a real directory");
      fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
      ok = true;
    } catch (error) {
      detail = `${directory}: ${error.code || error.message}; mount the volume or run clean-development prepare`;
    }
    checks.push({ name: `managed-${key}`, ok, detail });
  }
  checks.push({ name: "runtime", ...runtimeHealth(config) });
  for (const tool of SHIM_TOOLS) {
    const executable = resolveExecutable(tool, env, config.locations.binDir);
    checks.push({ name: `tool:${tool}`, ok: Boolean(executable), optional: true, detail: executable || "not found" });
  }
  return { ok: checks.filter((item) => !item.optional).every((item) => item.ok), checks };
}

function parseDays(value, fallback = DEFAULT_CONFIG.retention.buildDays) {
  const match = String(value ?? fallback).match(/^(\d+)(?:d|days?)?$/i);
  if (!match) throw new Error(`Invalid age '${value}'; use a number of days such as 30 or 30d`);
  return Number(match[1]);
}

async function setPinned(config, workspaceId, pinned) {
  let changed = 0;
  const matches = listWorkspaceRecords(config).filter(({ value }) => value.workspaceId === workspaceId);
  for (const { file, value } of matches) {
    if (value.workspaceId !== workspaceId) continue;
    const releaseLock = await acquireWorkspaceLock(config, workspaceId, value.buildRoot);
    try {
      const current = readJson(file, null);
      if (!current || current.workspaceId !== workspaceId) continue;
      current.pinned = pinned;
      writeJsonAtomic(file, current);
      changed += 1;
    } finally {
      releaseLock();
    }
  }
  if (changed === 0) throw new Error(`Unknown workspace ID: ${workspaceId}`);
  return { workspaceId, pinned, recordsChanged: changed };
}

async function uninstallCommand(options, config, env) {
  const runtimeReceiptFile = path.join(config.locations.stateDir, "runtime.json");
  const integrationReceiptFile = path.join(config.locations.stateDir, "integrations.json");
  if (!fs.existsSync(runtimeReceiptFile) && !fs.existsSync(integrationReceiptFile)) {
    throw new Error(`No installation receipts were found in ${config.locations.stateDir}; nothing was removed. If the data-home or XDG environment changed, rerun uninstall with the same data-home settings used for setup.`);
  }
  const runtimePlan = runtimeRemovalPlan(config);
  const integrationTargets = integrationStatus(config, env, { enforcePaths: true }).integrations
    .filter((entry) => entry.file)
    .map((entry) => ({ agent: entry.agent, mode: entry.mode, file: entry.file, command: entry.command, beginMarker: entry.beginMarker, endMarker: entry.endMarker }));
  const result = {
    dryRun: Boolean(options["dry-run"]),
    targets: runtimePlan.files,
    archivedReceiptTargets: runtimePlan.archivedReceipts,
    integrationTargets,
    retained: runtimePlan.retained
  };
  if (result.dryRun) return result;
  const releaseLock = await acquireDirectoryLock(path.join(config.locations.stateDir, "setup.lock"));
  try {
    result.integrationsRemoved = removeOwnedAgentIntegrations(config, env);
    result.runtime = removeRuntime(config);
    return result;
  } finally {
    releaseLock();
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const [rawCommand = "help", ...rest] = argv;
  const command = ["--help", "-h"].includes(rawCommand) ? "help"
    : ["--version", "-v"].includes(rawCommand) ? "version"
      : rawCommand;
  if (!Object.hasOwn(COMMAND_OPTIONS, command)) throw new Error(`Unknown command '${command}'. Run clean-development help.`);
  const separator = rest.indexOf("--");
  const ownArguments = separator === -1 ? rest : rest.slice(0, separator);
  if (ownArguments.some((argument) => argument === "--help" || argument === "-h")) {
    console.log(HELP);
    return 0;
  }
  const optionTypes = COMMAND_OPTIONS[command];
  const parsed = parse(rest, optionTypes);
  validateArguments(command, parsed);
  const json = Boolean(parsed.options.json);
  if (command === "help") {
    console.log(HELP);
    return 0;
  }
  if (command === "version") {
    console.log(VERSION);
    return 0;
  }
  if (command === "setup") {
    output(await setup(parsed.options, env), json);
    return 0;
  }
  if (command === "update") {
    output(await update(parsed.options, env), json);
    return 0;
  }
  if (command === "prepare") {
    output(prepare(parsed.options, env), json);
    return 0;
  }
  if (command === "session") {
    const config = resolveConfig({ env });
    const result = await sessionDecision(parsed.options, config, env);
    output(result, json);
    return 0;
  }
  if (command === "init") {
    output(projectInit(parsed.options, process.cwd()), json);
    return 0;
  }
  const requestedSession = normalizeSessionMode(parsed.options.session);
  const inheritedSession = normalizeSessionMode(environmentValue(env, "CLEAN_DEVELOPMENT_SESSION_MODE"));
  if ((requestedSession || inheritedSession) === "skip" && ["run", "agent", "shim", "hook"].includes(command)) {
    const skipEnv = { ...env, CLEAN_DEVELOPMENT_SESSION_MODE: "skip" };
    const skipConfig = { locations: platformPaths(env) };
    if (command === "run") {
      const [executable, ...args] = parsed.passthrough.length ? parsed.passthrough : parsed.positionals;
      return runWithShims(executable, args, { config: skipConfig, env: skipEnv });
    }
    if (command === "agent") {
      const agent = parsed.positionals[0];
      if (!Object.hasOwn(SUPPORTED_AGENTS, agent)) throw new Error(`agent must be one of: ${Object.keys(SUPPORTED_AGENTS).join(", ")}`);
      const args = parsed.passthrough.length ? parsed.passthrough : parsed.positionals.slice(1);
      return runWithShims(SUPPORTED_AGENTS[agent], args, { config: skipConfig, env: skipEnv });
    }
    if (command === "shim") {
      const [tool, ...args] = parsed.positionals.concat(parsed.passthrough);
      return runTool(tool, args, { config: skipConfig, env: skipEnv });
    }
    return 0;
  }
  let config;
  if (command === "hook" && inheritedSession === null) {
    try {
      config = resolveConfig({ env });
    } catch {
      config = resolveConfig({ env, includeProject: false });
    }
  } else config = resolveConfig({ env });
  if (command === "run") {
    const [executable, ...args] = parsed.passthrough.length ? parsed.passthrough : parsed.positionals;
    if (!executable) throw new Error("run requires a command after --");
    const session = await sessionDecision(parsed.options, config, env);
    return runWithShims(executable, args, { config, env: session.env });
  }
  if (command === "agent") {
    const agent = parsed.positionals[0];
    if (!Object.hasOwn(SUPPORTED_AGENTS, agent)) throw new Error(`agent must be one of: ${Object.keys(SUPPORTED_AGENTS).join(", ")}`);
    const args = parsed.passthrough.length ? parsed.passthrough : parsed.positionals.slice(1);
    const session = await sessionDecision(parsed.options, config, env);
    const agentEnv = agent === "opencode"
      ? deferSessionRouting(session.env, config.locations.binDir)
      : session.env;
    return runWithShims(SUPPORTED_AGENTS[agent], args, { config, env: agentEnv });
  }
  if (command === "shim") {
    const [tool, ...args] = parsed.positionals.concat(parsed.passthrough);
    if (!tool) throw new Error("shim requires a tool name");
    return runTool(tool, args, { config, env });
  }
  if (command === "hook") {
    if (parsed.positionals[0] !== "session-start") throw new Error("unknown hook");
    const owner = validateClaudeHookOwner(config, env, parsed.options.owner);
    if (!owner) return 0;
    const runtime = ensureRuntime(config, { automatic: true });
    if (!runtime) return 0;
    applyClaudeSessionEnvironment(config, runtime, env, parsed.options.owner, { disabled: config.enabled === false });
    return 0;
  }
  if (command === "env") {
    console.log(envCommand(parsed.options, config, env));
    return 0;
  }
  if (command === "status") {
    output(statusCommand(parsed.options, config), json);
    return 0;
  }
  if (command === "doctor") {
    const result = doctorCommand(config, env);
    output(result, json);
    return result.ok ? 0 : 1;
  }
  if (command === "prune") {
    const plan = prunePlan(config, { olderThanDays: parseDays(parsed.options["older-than"], config.retention.buildDays) });
    const result = { apply: Boolean(parsed.options.apply), entries: plan };
    if (parsed.options.apply) result.removed = await applyPrune(config, plan);
    output(result, json);
    return 0;
  }
  if (command === "pin" || command === "unpin") {
    output(await setPinned(config, parsed.positionals[0], command === "pin"), json);
    return 0;
  }
  if (command === "uninstall") {
    output(await uninstallCommand(parsed.options, config, env), json);
    return 0;
  }
  throw new Error(`Unknown command '${command}'. Run clean-development help.`);
}

export { allToolEnvironments };
