import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { environmentForTool } from "./adapters.js";
import { writeProjectConfig } from "./config.js";
import { CONFIG_FILE } from "./constants.js";
import { canonicalizePotentialPath, environmentValue, isPathInside, prependUniquePath, setEnvironmentValue } from "./platform.js";
import { detectStack } from "./workspace.js";

export const SESSION_MODES = Object.freeze(["session-only", "persist", "skip"]);
export const SESSION_MODE_ENV = "CLEAN_DEVELOPMENT_SESSION_MODE";
export const SESSION_ENV_MARKER = "CLEAN_DEVELOPMENT_SESSION_ENV";

const PROJECT_SCHEMA = "https://raw.githubusercontent.com/magrathean-uk/clean-development/main/schemas/project-config.schema.json";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function lstatOrNull(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function normalizeSessionMode(value) {
  if (value === undefined || value === null || value === "") return null;
  const normalized = value === "session" ? "session-only" : String(value);
  if (!SESSION_MODES.includes(normalized)) {
    throw new Error(`Invalid session choice '${value}'; use session-only, persist, or skip`);
  }
  return normalized;
}

function inspectProjectConfig(file) {
  const parent = path.dirname(file);
  const parentRealpath = fs.realpathSync.native(parent);
  const parentStat = fs.statSync(parentRealpath, { bigint: true });
  const parentIdentity = { dev: String(parentStat.dev), ino: String(parentStat.ino) };
  const stat = lstatOrNull(file);
  if (!stat) return { path: file, status: "proposed", parentRealpath, parentIdentity };
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return { path: file, status: "blocked", reason: "project configuration is not a real file", parentRealpath, parentIdentity };
  }
  const contents = fs.readFileSync(file, "utf8");
  return { path: file, status: "existing", sha256: sha256(contents), parentRealpath, parentIdentity };
}

function repositoryManagedPaths(projectRoot, managed) {
  const root = canonicalizePotentialPath(projectRoot);
  const home = managed.locations?.home
    ? canonicalizePotentialPath(managed.locations.home)
    : null;
  if (root === home) return [];
  return [...new Set([managed.root, managed.cacheRoot, managed.buildRoot, managed.scratchRoot]
    .map((value) => canonicalizePotentialPath(value))
    .filter((value) => value === root || isPathInside(root, value)))];
}

function parsedSessionEnvironment(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    if (Object.entries(parsed).some(([name, item]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof item !== "string")) return {};
    return parsed;
  } catch {
    return {};
  }
}

function proposedProjectConfig(detection, config) {
  const tools = Object.fromEntries(detection.tools
    .filter((tool) => config.tools?.[tool] !== false)
    .map((tool) => [tool, true]));
  const value = {
    $schema: PROJECT_SCHEMA,
    schemaVersion: 1,
    enabled: true,
    tools
  };
  return { value, contents: `${JSON.stringify(value, null, 2)}\n` };
}

function mergePreview(detection, config, env) {
  const environment = {};
  const preserved = {};
  const dynamic = [];
  if (config.enabled === false) return { environment, preserved, dynamic };
  for (const tool of detection.tools) {
    if (config.tools?.[tool] === false) continue;
    const result = environmentForTool(tool, [], { config, cwd: detection.root, env, create: false });
    for (const [name, value] of Object.entries(result.applied)) {
      if (name === "CARGO_TARGET_DIR") {
        if (!dynamic.includes("CARGO_TARGET_DIR")) dynamic.push("CARGO_TARGET_DIR");
      } else {
        environment[name] = value;
      }
    }
    Object.assign(preserved, result.preserved);
  }
  return { environment, preserved, dynamic };
}

export function planSession({ cwd = process.cwd(), env = process.env, config } = {}) {
  if (!config) throw new Error("planSession requires resolved configuration");
  const detection = detectStack(canonicalizePotentialPath(cwd), { home: config.locations.home });
  const projectConfig = inspectProjectConfig(path.join(detection.root, CONFIG_FILE));
  const proposed = proposedProjectConfig(detection, config);
  const routing = mergePreview(detection, config, env);
  const repositoryPaths = repositoryManagedPaths(detection.root, config);
  return {
    schemaVersion: 1,
    cwd: path.resolve(cwd),
    projectRoot: detection.root,
    detected: {
      tools: detection.tools,
      evidence: detection.evidence,
      conflicts: detection.conflicts
    },
    managed: {
      enabled: config.enabled !== false,
      root: config.root,
      cacheRoot: config.cacheRoot,
      buildRoot: config.buildRoot,
      scratchRoot: config.scratchRoot,
      environment: routing.environment,
      dynamic: routing.dynamic,
      preserved: routing.preserved,
      repositoryPaths
    },
    projectConfig: {
      ...projectConfig,
      proposed: projectConfig.status === "proposed" ? proposed.value : null,
      proposedContents: projectConfig.status === "proposed" ? proposed.contents : null
    },
    choices: [
      { mode: "session-only", available: config.enabled !== false && repositoryPaths.length === 0, sourceWrites: [] },
      { mode: "persist", available: config.enabled !== false && projectConfig.status !== "blocked" && repositoryPaths.length === 0, sourceWrites: projectConfig.status === "proposed" ? [projectConfig.path] : [] },
      { mode: "skip", available: true, sourceWrites: [] }
    ]
  };
}

export function selectSessionMode({ requested, env = process.env, interactive = false, choice } = {}) {
  const explicit = normalizeSessionMode(requested);
  if (explicit) return explicit;
  const inherited = normalizeSessionMode(environmentValue(env, SESSION_MODE_ENV));
  if (inherited) return inherited === "persist" ? "session-only" : inherited;
  if (!interactive) return "session-only";
  return normalizeSessionMode(choice) || "skip";
}

export function persistSessionPlan(plan) {
  const target = plan.projectConfig.path;
  if (plan.projectConfig.status === "existing") {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || sha256(fs.readFileSync(target)) !== plan.projectConfig.sha256) {
      throw new Error(`Project configuration changed after review: ${target}`);
    }
    return { status: "existing", file: target };
  }
  if (plan.projectConfig.status === "blocked") throw new Error(`Cannot persist session: ${plan.projectConfig.reason}: ${target}`);
  if (lstatOrNull(target)) throw new Error(`Project configuration appeared after review: ${target}`);
  if (fs.realpathSync.native(path.dirname(target)) !== plan.projectConfig.parentRealpath) {
    throw new Error(`Project directory changed after review: ${path.dirname(target)}`);
  }
  const parentStat = fs.statSync(path.dirname(target), { bigint: true });
  if (String(parentStat.dev) !== plan.projectConfig.parentIdentity.dev || String(parentStat.ino) !== plan.projectConfig.parentIdentity.ino) {
    throw new Error(`Project directory changed after review: ${path.dirname(target)}`);
  }
  const { $schema: _schema, schemaVersion: _schemaVersion, ...value } = plan.projectConfig.proposed;
  try {
    writeProjectConfig(target, value, { exclusive: true, expectedParent: plan.projectConfig.parentIdentity });
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`Project configuration appeared after review: ${target}`);
    throw error;
  }
  if (fs.readFileSync(target, "utf8") !== plan.projectConfig.proposedContents) {
    throw new Error(`Persisted project configuration did not match the reviewed content: ${target}`);
  }
  return { status: "created", file: target };
}

function ensureManagedBase(directory) {
  const validate = () => {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(directory) !== path.resolve(directory)) {
      throw new Error(`Managed path is not a real directory: ${directory}`);
    }
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

export function prepareManagedDirectories(plan) {
  const directories = [...new Set([
    plan.managed.root, plan.managed.cacheRoot, plan.managed.buildRoot, plan.managed.scratchRoot
  ])];
  for (const directory of directories) ensureManagedBase(directory);
  return directories;
}

export function applySessionPlan(plan, mode, env = process.env) {
  const selected = normalizeSessionMode(mode);
  if (!selected) throw new Error("A session choice is required");
  const childEnv = { ...env };
  setEnvironmentValue(childEnv, SESSION_MODE_ENV, selected === "persist" ? "session-only" : selected);
  if (selected === "skip") return { mode: selected, env: childEnv, projectConfig: null };
  if (plan.managed.repositoryPaths.length) {
    throw new Error(`Managed storage must be outside the project for ${selected}: ${plan.managed.repositoryPaths.join(", ")}`);
  }

  prepareManagedDirectories(plan);
  const inherited = parsedSessionEnvironment(environmentValue(childEnv, SESSION_ENV_MARKER));
  const injected = Object.fromEntries(Object.entries(inherited)
    .filter(([name, value]) => environmentValue(childEnv, name) === value));
  const preservedNames = new Set(Object.keys(plan.managed.preserved).map((name) => name.toLowerCase()));
  for (const [name, value] of Object.entries(plan.managed.environment)) {
    if (preservedNames.has(name.toLowerCase())) continue;
    setEnvironmentValue(childEnv, name, value);
    injected[name] = value;
  }
  setEnvironmentValue(childEnv, SESSION_ENV_MARKER, JSON.stringify(injected));
  const projectConfig = selected === "persist" ? persistSessionPlan(plan) : null;
  return { mode: selected, env: childEnv, projectConfig };
}

export function environmentWithoutSessionRouting(env = process.env, binDir = null) {
  const result = { ...env };
  const injected = parsedSessionEnvironment(environmentValue(result, SESSION_ENV_MARKER));
  for (const [name, value] of Object.entries(injected)) {
    if (environmentValue(result, name) === value) {
      for (const key of Object.keys(result)) if (key.toLowerCase() === name.toLowerCase()) delete result[key];
    }
  }
  const injectedCargo = environmentValue(result, "CLEAN_DEVELOPMENT_CARGO_TARGET_DIR");
  if (injectedCargo && environmentValue(result, "CARGO_TARGET_DIR") === injectedCargo) {
    for (const key of Object.keys(result)) if (key.toLowerCase() === "cargo_target_dir") delete result[key];
  }
  for (const name of [
    "CLEAN_DEVELOPMENT_ACTIVE", "CLEAN_DEVELOPMENT_RESOLVED_ROOT", "CLEAN_DEVELOPMENT_WORKSPACE_ID",
    "CLEAN_DEVELOPMENT_WORKSPACE", "CLEAN_DEVELOPMENT_CARGO_TARGET_DIR", SESSION_ENV_MARKER
  ]) {
    for (const key of Object.keys(result)) if (key.toLowerCase() === name.toLowerCase()) delete result[key];
  }
  if (binDir) {
    const resolved = path.resolve(binDir);
    const entries = String(environmentValue(result, "PATH") || "").split(path.delimiter)
      .filter((entry) => !entry || path.resolve(entry) !== resolved);
    setEnvironmentValue(result, "PATH", entries.join(path.delimiter));
  }
  setEnvironmentValue(result, SESSION_MODE_ENV, "skip");
  return result;
}

export function nativeSessionEnvironment(env = process.env, { mode = "skip", binDir = null, includeRuntime = false } = {}) {
  const selected = normalizeSessionMode(mode) || "skip";
  const result = selected === "skip"
    ? environmentWithoutSessionRouting(env, binDir)
    : { ...env };
  setEnvironmentValue(result, SESSION_MODE_ENV, selected);
  if (includeRuntime && binDir) {
    setEnvironmentValue(result, "PATH", prependUniquePath(environmentValue(result, "PATH"), binDir));
  }
  if (selected === "skip") {
    for (const key of Object.keys(result)) if (key.toLowerCase() === "clean_development_active") delete result[key];
  } else setEnvironmentValue(result, "CLEAN_DEVELOPMENT_ACTIVE", "1");
  return result;
}

export function deferSessionRouting(env = process.env, binDir = null) {
  const selected = normalizeSessionMode(environmentValue(env, SESSION_MODE_ENV));
  if (!selected || selected === "skip") return environmentWithoutSessionRouting(env, binDir);
  const result = environmentWithoutSessionRouting(env, binDir);
  setEnvironmentValue(result, SESSION_MODE_ENV, selected);
  return result;
}
