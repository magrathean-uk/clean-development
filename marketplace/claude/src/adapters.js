import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SHIM_TOOLS } from "./constants.js";
import { readJson, writeJsonAtomic } from "./io.js";
import { canonicalizePotentialPath, environmentValue, isPathInside, setEnvironmentValue } from "./platform.js";
import { identifyWorkspace } from "./workspace.js";

export const OWNERSHIP_MARKER = ".clean-development-owned.json";

function definitions(config, workspace) {
  const shared = config.cacheRoot;
  const build = path.join(config.buildRoot, workspace.id);
  return {
    cargo: { CARGO_TARGET_DIR: path.join(build, "cargo", "target") },
    go: { GOCACHE: path.join(shared, "go", "build"), GOMODCACHE: path.join(shared, "go", "modules") },
    npm: { npm_config_cache: path.join(shared, "node", "npm") },
    npx: { npm_config_cache: path.join(shared, "node", "npm") },
    pnpm: { npm_config_cache: path.join(shared, "node", "npm"), npm_config_store_dir: path.join(shared, "node", "pnpm-store") },
    yarn: {
      YARN_CACHE_FOLDER: path.join(shared, "node", "yarn"),
      YARN_ENABLE_GLOBAL_CACHE: "false",
      YARN_ENABLE_MIRROR: "false"
    },
    bun: { BUN_INSTALL_CACHE_DIR: path.join(shared, "node", "bun") },
    uv: { UV_CACHE_DIR: path.join(shared, "python", "uv") },
    pip: { PIP_CACHE_DIR: path.join(shared, "python", "pip") },
    pip3: { PIP_CACHE_DIR: path.join(shared, "python", "pip") },
    dotnet: { NUGET_PACKAGES: path.join(shared, "dotnet", "nuget") },
    composer: { COMPOSER_CACHE_DIR: path.join(shared, "php", "composer") },
    ccache: { CCACHE_DIR: path.join(shared, "native", "ccache") },
    sccache: { SCCACHE_DIR: path.join(shared, "native", "sccache") }
  };
}

function isInjectedDefault(name, value, config, env) {
  if (name === "CARGO_TARGET_DIR") {
    return environmentValue(env, "CLEAN_DEVELOPMENT_ACTIVE") === "1"
      && value === environmentValue(env, "CLEAN_DEVELOPMENT_CARGO_TARGET_DIR");
  }
  if (name !== "npm_config_cache") return false;
  const pathKey = (candidate) => {
    const canonical = canonicalizePotentialPath(candidate);
    return process.platform === "win32" ? canonical.toLowerCase() : canonical;
  };
  const home = environmentValue(env, "HOME");
  const userProfile = environmentValue(env, "USERPROFILE");
  const localAppData = environmentValue(env, "LOCALAPPDATA");
  const candidates = [
    path.join(config.locations.home, ".npm"),
    home ? path.join(home, ".npm") : null,
    userProfile ? path.join(userProfile, "AppData", "Local", "npm-cache") : null,
    localAppData ? path.join(localAppData, "npm-cache") : null
  ].filter(Boolean).map(pathKey);
  return candidates.includes(pathKey(value));
}

function matchingEnvironmentKeys(env, name) {
  const normalized = name.toLowerCase();
  return Object.keys(env).filter((key) => key.toLowerCase() === normalized);
}

function deleteEnvironmentValue(env, name) {
  const normalized = name.toLowerCase();
  for (const key of Object.keys(env)) if (key.toLowerCase() === normalized) delete env[key];
}

function assertRealDirectory(directory, label) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a real directory: ${directory}`);
  }
  if (canonicalizePotentialPath(directory) !== path.resolve(directory)) {
    throw new Error(`${label} resolves through an unexpected symlink: ${directory}`);
  }
}

function managedSubdirectory(root, target, { create, label }) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Refusing ${label.toLowerCase()} outside ${resolvedRoot}: ${resolvedTarget}`);
  }
  let current = resolvedRoot;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if (fs.existsSync(current)) {
      assertRealDirectory(current, label);
      continue;
    }
    if (!create) break;
    try {
      fs.mkdirSync(current);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    assertRealDirectory(current, label);
  }
}

export function ensureOwnedBuildRoot(config, workspace, existingRecord = null) {
  if (!fs.existsSync(config.buildRoot)) {
    throw new Error(`Managed build root is unavailable: ${config.buildRoot}. Mount it or run 'clean-development prepare' before building.`);
  }
  assertRealDirectory(config.buildRoot, "Managed build root");
  const buildPath = path.join(config.buildRoot, workspace.id);
  if (!isPathInside(config.buildRoot, buildPath) || path.dirname(path.resolve(buildPath)) !== path.resolve(config.buildRoot)) {
    throw new Error(`Refusing unsafe managed build path: ${buildPath}`);
  }
  const markerPath = path.join(buildPath, OWNERSHIP_MARKER);
  const validateExisting = () => {
    assertRealDirectory(buildPath, "Managed build path");
    const marker = readJson(markerPath, null);
    if (marker?.owner !== "clean-development" || !marker?.ownershipId || marker?.workspaceId !== workspace.id || marker?.workspace !== workspace.root) {
      throw new Error(`Refusing unowned existing build directory: ${buildPath}`);
    }
    if (
      !existingRecord
      || existingRecord.ownershipId !== marker.ownershipId
      || existingRecord.workspaceId !== workspace.id
      || existingRecord.workspace !== workspace.root
      || path.resolve(existingRecord.buildRoot || "") !== path.resolve(config.buildRoot)
      || path.resolve(existingRecord.path || "") !== buildPath
    ) {
      throw new Error(`Refusing existing build directory without a matching state receipt: ${buildPath}`);
    }
    return { path: buildPath, ownershipId: marker.ownershipId };
  };
  if (fs.existsSync(buildPath)) return validateExisting();

  const ownershipId = crypto.randomUUID();
  const temporary = path.join(config.buildRoot, `.clean-development-${workspace.id}-${process.pid}-${crypto.randomUUID()}`);
  fs.mkdirSync(temporary);
  writeJsonAtomic(path.join(temporary, OWNERSHIP_MARKER), {
    schemaVersion: 1,
    owner: "clean-development",
    ownershipId,
    workspaceId: workspace.id,
    workspace: workspace.root,
    createdAt: new Date().toISOString()
  });
  try {
    fs.renameSync(temporary, buildPath);
    return { path: buildPath, ownershipId };
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
    return validateExisting();
  }
}

export function environmentForTool(tool, args, { config, cwd = process.cwd(), env = process.env, create = true, validateBase = false, existingBuildRecord = null } = {}) {
  if (!SHIM_TOOLS.includes(tool)) throw new Error(`Unsupported shim tool: ${tool}`);
  const workspace = identifyWorkspace(tool, args, cwd);
  const desired = definitions(config, workspace)[tool] || {};
  const applied = {};
  const preserved = {};
  const force = env.CLEAN_DEVELOPMENT_FORCE === "1";
  if (config.enabled === false || config.tools?.[tool] === false) {
    return { env: { ...env }, applied, preserved, workspace, disabled: true };
  }
  const childEnv = { ...env };
  let ownedBuild = null;
  let cacheRootChecked = false;
  for (const [name, value] of Object.entries(desired)) {
    const existingKeys = matchingEnvironmentKeys(childEnv, name);
    const explicitKeys = existingKeys.filter((key) => childEnv[key] && !isInjectedDefault(name, childEnv[key], config, childEnv));
    if (!force && explicitKeys.length > 0) {
      for (const key of existingKeys) {
        if (!explicitKeys.includes(key) && isInjectedDefault(name, childEnv[key], config, childEnv)) delete childEnv[key];
      }
      for (const key of explicitKeys) preserved[key] = childEnv[key];
      continue;
    }
    deleteEnvironmentValue(childEnv, name);
    childEnv[name] = value;
    applied[name] = value;
    if (name === "YARN_ENABLE_GLOBAL_CACHE" || name === "YARN_ENABLE_MIRROR") continue;
    if (create || validateBase) {
      if (tool === "cargo" && name === "CARGO_TARGET_DIR") {
        if (create) {
          ownedBuild = ensureOwnedBuildRoot(config, workspace, existingBuildRecord);
          managedSubdirectory(ownedBuild.path, value, { create: true, label: "Managed Cargo target path" });
        }
      }
      else if (!cacheRootChecked) {
        if (!fs.existsSync(config.cacheRoot)) {
          throw new Error(`Managed cache root is unavailable: ${config.cacheRoot}. Mount it or run 'clean-development prepare' before using ${tool}.`);
        }
        assertRealDirectory(config.cacheRoot, "Managed cache root");
        cacheRootChecked = true;
      }
      if (tool !== "cargo") managedSubdirectory(config.cacheRoot, value, { create, label: "Managed cache path" });
    }
  }
  if (tool === "cargo") {
    if (applied.CARGO_TARGET_DIR) setEnvironmentValue(childEnv, "CLEAN_DEVELOPMENT_CARGO_TARGET_DIR", applied.CARGO_TARGET_DIR);
    else deleteEnvironmentValue(childEnv, "CLEAN_DEVELOPMENT_CARGO_TARGET_DIR");
  }
  setEnvironmentValue(childEnv, "CLEAN_DEVELOPMENT_ACTIVE", "1");
  setEnvironmentValue(childEnv, "CLEAN_DEVELOPMENT_RESOLVED_ROOT", config.root);
  setEnvironmentValue(childEnv, "CLEAN_DEVELOPMENT_WORKSPACE_ID", workspace.id);
  setEnvironmentValue(childEnv, "CLEAN_DEVELOPMENT_WORKSPACE", workspace.root);
  return { env: childEnv, applied, preserved, workspace, disabled: false, ownedBuild };
}

export function allToolEnvironments(config, options = {}) {
  return Object.fromEntries(SHIM_TOOLS.map((tool) => [tool, environmentForTool(tool, [], { config, create: false, ...options })]));
}
