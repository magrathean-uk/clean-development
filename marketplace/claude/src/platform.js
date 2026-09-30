import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatPathEntry, pathEntries } from "./path-entries.js";

function homeDirectory(env, platform) {
  for (const name of ["CLEAN_DEVELOPMENT_HOME", "HOME", "USERPROFILE"]) {
    const value = environmentValue(env, name, platform);
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

function privateBase(env, name, home, platform) {
  const value = environmentValue(env, name, platform);
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || !path.isAbsolute(value)) throw new Error(`${name} must be a non-empty absolute path`);
  const resolved = canonicalizePotentialPath(value);
  if (resolved === path.parse(resolved).root || resolved === home) throw new Error(`Refusing broad ${name}: ${resolved}`);
  return resolved;
}

export function platformPaths(env = process.env, platform = process.platform) {
  const home = homeDirectory(env, platform);
  const customData = privateBase(env, "CLEAN_DEVELOPMENT_DATA_HOME", home, platform);
  const customConfig = privateBase(env, "CLEAN_DEVELOPMENT_CONFIG_HOME", home, platform);
  let dataDir;
  let configDir;
  let defaultRoot;

  if (platform === "darwin") {
    dataDir = customData || path.join(home, "Library", "Application Support", "clean-development");
    configDir = customConfig || dataDir;
    defaultRoot = path.join(home, "Library", "Caches", "clean-development");
  } else if (platform === "win32") {
    const local = privateBase(env, "LOCALAPPDATA", home, platform) || path.join(home, "AppData", "Local");
    const roaming = privateBase(env, "APPDATA", home, platform) || path.join(home, "AppData", "Roaming");
    dataDir = customData || path.join(local, "clean-development");
    configDir = customConfig || path.join(roaming, "clean-development");
    defaultRoot = path.join(local, "clean-development", "cache");
  } else {
    const xdgData = privateBase(env, "XDG_DATA_HOME", home, platform) || path.join(home, ".local", "share");
    const xdgConfig = privateBase(env, "XDG_CONFIG_HOME", home, platform) || path.join(home, ".config");
    const xdgCache = privateBase(env, "XDG_CACHE_HOME", home, platform) || path.join(home, ".cache");
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

export function prependUniquePath(pathValue, directory, platform = process.platform) {
  const canonicalDirectory = canonicalizePotentialPath(directory);
  const directoryKey = platform === "win32" ? canonicalDirectory.toLowerCase() : canonicalDirectory;
  const entries = pathValue ? pathEntries(pathValue, platform) : [];
  const remaining = entries.filter((entry) => {
    if (!entry.value || !path.isAbsolute(entry.value)) return entry.value !== directory;
    const canonical = canonicalizePotentialPath(entry.value);
    return (platform === "win32" ? canonical.toLowerCase() : canonical) !== directoryKey;
  }).map((entry) => entry.raw);
  return [formatPathEntry(directory, platform), ...remaining].join(platform === "win32" ? ";" : path.delimiter);
}

export function matchingEnvironmentKeys(env, name, platform = process.platform) {
  if (platform !== "win32") return Object.hasOwn(env, name) ? [name] : [];
  const normalized = name.toLowerCase();
  return Object.keys(env).filter((candidate) => candidate.toLowerCase() === normalized);
}

export function environmentValue(env, name, platform = process.platform) {
  const [key] = matchingEnvironmentKeys(env, name, platform);
  return key ? env[key] : undefined;
}

export function setEnvironmentValue(env, name, value, platform = process.platform) {
  for (const key of matchingEnvironmentKeys(env, name, platform)) delete env[key];
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
