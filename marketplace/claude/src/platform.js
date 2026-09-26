import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function homeDirectory(env) {
  for (const name of ["CLEAN_DEVELOPMENT_HOME", "HOME", "USERPROFILE"]) {
    const value = environmentValue(env, name);
    if (value === undefined || (name !== "CLEAN_DEVELOPMENT_HOME" && value === "")) continue;
    if (typeof value !== "string" || !value.trim() || !path.isAbsolute(value)) throw new Error(`${name} must be a non-empty absolute path`);
    const resolved = canonicalizePotentialPath(value);
    if (resolved === path.parse(resolved).root) throw new Error(`Refusing broad ${name}: ${resolved}`);
    return resolved;
  }
  const fallback = canonicalizePotentialPath(os.homedir());
  if (fallback === path.parse(fallback).root) throw new Error(`Refusing broad home directory: ${fallback}`);
  return fallback;
}

function privateBase(env, name, home) {
  const value = environmentValue(env, name);
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || !path.isAbsolute(value)) throw new Error(`${name} must be a non-empty absolute path`);
  const resolved = canonicalizePotentialPath(value);
  if (resolved === path.parse(resolved).root || resolved === home) throw new Error(`Refusing broad ${name}: ${resolved}`);
  return resolved;
}

export function platformPaths(env = process.env, platform = process.platform) {
  const home = homeDirectory(env);
  const customData = privateBase(env, "CLEAN_DEVELOPMENT_DATA_HOME", home);
  const customConfig = privateBase(env, "CLEAN_DEVELOPMENT_CONFIG_HOME", home);
  let dataDir;
  let configDir;
  let defaultRoot;

  if (platform === "darwin") {
    dataDir = customData || path.join(home, "Library", "Application Support", "clean-development");
    configDir = customConfig || dataDir;
    defaultRoot = path.join(home, "Library", "Caches", "clean-development");
  } else if (platform === "win32") {
    const local = privateBase(env, "LOCALAPPDATA", home) || path.join(home, "AppData", "Local");
    const roaming = privateBase(env, "APPDATA", home) || path.join(home, "AppData", "Roaming");
    dataDir = customData || path.join(local, "clean-development");
    configDir = customConfig || path.join(roaming, "clean-development");
    defaultRoot = path.join(local, "clean-development", "cache");
  } else {
    const xdgData = privateBase(env, "XDG_DATA_HOME", home) || path.join(home, ".local", "share");
    const xdgConfig = privateBase(env, "XDG_CONFIG_HOME", home) || path.join(home, ".config");
    const xdgCache = privateBase(env, "XDG_CACHE_HOME", home) || path.join(home, ".cache");
    dataDir = customData || path.join(xdgData, "clean-development");
    configDir = customConfig || path.join(xdgConfig, "clean-development");
    defaultRoot = path.join(xdgCache, "clean-development");
  }

  return {
    home,
    dataDir: path.resolve(dataDir),
    configDir: path.resolve(configDir),
    configPath: path.resolve(configDir, "config.json"),
    stateDir: path.resolve(dataDir, "state"),
    runtimeDir: path.resolve(dataDir, "runtime"),
    binDir: path.resolve(dataDir, "bin"),
    defaultRoot: path.resolve(defaultRoot)
  };
}

export function isPathInside(parent, candidate) {
  const relative = path.relative(canonicalizePotentialPath(parent), canonicalizePotentialPath(candidate));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function canonicalizePotentialPath(value) {
  const tail = [];
  let existing = path.resolve(value);
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    tail.unshift(path.basename(existing));
    existing = parent;
  }
  let canonical = existing;
  try {
    canonical = fs.realpathSync.native(existing);
  } catch {
    canonical = path.resolve(existing);
  }
  return path.resolve(canonical, ...tail);
}

export function prependUniquePath(pathValue, directory) {
  const canonicalDirectory = canonicalizePotentialPath(directory);
  const directoryKey = process.platform === "win32" ? canonicalDirectory.toLowerCase() : canonicalDirectory;
  const entries = String(pathValue || "").split(path.delimiter);
  const remaining = entries.filter((entry) => {
    if (!entry || !path.isAbsolute(entry)) return entry !== directory;
    const canonical = canonicalizePotentialPath(entry);
    return (process.platform === "win32" ? canonical.toLowerCase() : canonical) !== directoryKey;
  });
  return [directory, ...remaining].filter(Boolean).join(path.delimiter);
}

export function environmentValue(env, name) {
  const normalized = name.toLowerCase();
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === normalized);
  return key ? env[key] : undefined;
}

export function setEnvironmentValue(env, name, value) {
  const normalized = name.toLowerCase();
  for (const key of Object.keys(env)) if (key.toLowerCase() === normalized) delete env[key];
  env[name] = value;
  return env;
}

export function assertSafeManagedRoot(root, env = process.env) {
  if (!path.isAbsolute(root)) {
    throw new Error(`Managed root must be an absolute path: ${root}`);
  }
  const resolved = canonicalizePotentialPath(root);
  const parsed = path.parse(resolved);
  const { home } = platformPaths(env);
  if (resolved === parsed.root || resolved === canonicalizePotentialPath(home)) {
    throw new Error(`Refusing broad managed root: ${resolved}`);
  }
  return resolved;
}
