import fs from "node:fs";
import path from "node:path";
import { CONFIG_FILE, DEFAULT_CONFIG, SHIM_TOOLS, SUPPORTED_AGENTS } from "./constants.js";
import { readJson, writeJsonAtomic, writeJsonExclusive } from "./io.js";
import { assertSafeManagedRoot, environmentValue, platformPaths } from "./platform.js";

const PROJECT_KEYS = new Set(["$schema", "schemaVersion", "enabled", "root", "cacheRoot", "buildRoot", "scratchRoot", "retention", "tools"]);

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalid(file, message) {
  throw new Error(`Invalid configuration in ${file}: ${message}`);
}

function validateConfig(value, file, { user = false } = {}) {
  if (!isObject(value)) invalid(file, "top level must be a JSON object");
  const allowed = user ? new Set([...PROJECT_KEYS, "agents"]) : PROJECT_KEYS;
  for (const key of Object.keys(value)) if (!allowed.has(key)) invalid(file, `unknown key '${key}'`);
  if (value.schemaVersion !== 1) invalid(file, "schemaVersion must be 1");
  if (value.$schema !== undefined && (typeof value.$schema !== "string" || !value.$schema.trim())) invalid(file, "$schema must be a non-empty string");
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") invalid(file, "enabled must be a boolean");
  for (const key of ["root", "cacheRoot", "buildRoot", "scratchRoot"]) {
    if (value[key] !== undefined && (typeof value[key] !== "string" || !value[key].trim())) invalid(file, `${key} must be a non-empty string`);
  }
  if (value.retention !== undefined) {
    if (!isObject(value.retention)) invalid(file, "retention must be an object");
    for (const key of Object.keys(value.retention)) {
      if (key !== "buildDays") invalid(file, `unknown retention key '${key}'`);
      if (!Number.isInteger(value.retention[key]) || value.retention[key] < 0) invalid(file, `retention.${key} must be a non-negative integer`);
    }
  }
  if (value.tools !== undefined) {
    if (!isObject(value.tools)) invalid(file, "tools must be an object");
    for (const [tool, enabled] of Object.entries(value.tools)) {
      if (!SHIM_TOOLS.includes(tool)) invalid(file, `unknown tool '${tool}'`);
      if (typeof enabled !== "boolean") invalid(file, `tools.${tool} must be a boolean`);
    }
  }
  if (value.agents !== undefined) {
    if (!user) invalid(file, "agents is only valid in user configuration");
    if (!Array.isArray(value.agents) || value.agents.some((agent) => !Object.hasOwn(SUPPORTED_AGENTS, agent))) {
      invalid(file, "agents must contain only supported agent names");
    }
  }
  return value;
}

function loadConfig(file, options) {
  if (!fs.existsSync(file)) return null;
  return validateConfig(readJson(file, null), file, options);
}

function environmentPath(env, name) {
  const value = environmentValue(env, name);
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty absolute path`);
  return value;
}

function cloneDefault() {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

function merge(base, extra) {
  if (!extra) return base;
  const merged = { ...base, ...extra };
  merged.retention = { ...base.retention, ...(extra.retention || {}) };
  merged.tools = { ...base.tools, ...(extra.tools || {}) };
  return merged;
}

function resolveConfiguredPath(value, configFile) {
  if (!value) return undefined;
  if (!path.isAbsolute(value)) {
    throw new Error(`Paths in ${configFile} must be absolute: ${value}`);
  }
  return path.resolve(value);
}

export function findProjectConfig(start = process.cwd()) {
  let current = path.resolve(start);
  while (true) {
    const candidate = path.join(current, CONFIG_FILE);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function readUserConfig(env = process.env) {
  const locations = platformPaths(env);
  return loadConfig(locations.configPath, { user: true });
}

export function resolveConfig({ cwd = process.cwd(), env = process.env, overrides = {}, includeProject = true } = {}) {
  const locations = platformPaths(env);
  const user = loadConfig(locations.configPath, { user: true });
  const projectPath = includeProject ? findProjectConfig(cwd) : null;
  const project = projectPath ? loadConfig(projectPath) : null;
  let config = cloneDefault();
  config = merge(config, user);
  config = merge(config, project);
  config = merge(config, overrides);

  const environmentRoot = environmentPath(env, "CLEAN_DEVELOPMENT_ROOT");
  const environmentCacheRoot = environmentPath(env, "CLEAN_DEVELOPMENT_CACHE_ROOT");
  const environmentBuildRoot = environmentPath(env, "CLEAN_DEVELOPMENT_BUILD_ROOT");
  const environmentScratchRoot = environmentPath(env, "CLEAN_DEVELOPMENT_SCRATCH_ROOT");
  const rootValue = overrides.root || environmentRoot || project?.root || user?.root || locations.defaultRoot;
  const rootSource = overrides.root ? "command line" : environmentRoot ? "environment" : project?.root ? projectPath : user?.root ? locations.configPath : "platform default";
  const root = assertSafeManagedRoot(resolveConfiguredPath(rootValue, rootSource), env);
  const projectBase = projectPath || locations.configPath;
  const cacheRootValue = overrides.cacheRoot || environmentCacheRoot || project?.cacheRoot || user?.cacheRoot || path.join(root, "caches");
  const buildRootValue = overrides.buildRoot || environmentBuildRoot || project?.buildRoot || user?.buildRoot || path.join(root, "builds");
  const scratchRootValue = overrides.scratchRoot || environmentScratchRoot || project?.scratchRoot || user?.scratchRoot || path.join(root, "scratch");

  config.root = root;
  config.cacheRoot = assertSafeManagedRoot(resolveConfiguredPath(cacheRootValue, projectBase), env);
  config.buildRoot = assertSafeManagedRoot(resolveConfiguredPath(buildRootValue, projectBase), env);
  config.scratchRoot = assertSafeManagedRoot(resolveConfiguredPath(scratchRootValue, projectBase), env);
  config.projectConfigPath = projectPath;
  config.rootSource = rootSource;
  config.locations = locations;
  return config;
}

export function writeUserConfig(config, env = process.env) {
  const locations = platformPaths(env);
  const persisted = {
    schemaVersion: 1,
    enabled: config.enabled !== false,
    root: assertSafeManagedRoot(path.resolve(config.root), env),
    retention: config.retention || DEFAULT_CONFIG.retention,
    tools: config.tools || DEFAULT_CONFIG.tools,
    agents: config.agents || []
  };
  if (config.cacheRoot && config.cacheRoot !== path.join(persisted.root, "caches")) persisted.cacheRoot = path.resolve(config.cacheRoot);
  if (config.buildRoot && config.buildRoot !== path.join(persisted.root, "builds")) persisted.buildRoot = path.resolve(config.buildRoot);
  if (config.scratchRoot && config.scratchRoot !== path.join(persisted.root, "scratch")) persisted.scratchRoot = path.resolve(config.scratchRoot);
  validateConfig(persisted, locations.configPath, { user: true });
  writeJsonAtomic(locations.configPath, persisted);
  return locations.configPath;
}

export function writeProjectConfig(file, value, { force = false, exclusive = false, expectedParent = null } = {}) {
  if (fs.existsSync(file) && !force) throw new Error(`${file} already exists; use --force to replace it`);
  const output = {
    $schema: "https://raw.githubusercontent.com/magrathean-uk/clean-development/main/schemas/project-config.schema.json",
    schemaVersion: 1,
    ...value
  };
  validateConfig(output, file);
  if (exclusive || !force) writeJsonExclusive(file, output, { expectedParent });
  else writeJsonAtomic(file, output);
}
