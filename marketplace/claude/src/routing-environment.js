import { environmentValue, matchingEnvironmentKeys, setEnvironmentValue } from "./platform.js";

export const SESSION_ENV_MARKER = "CLEAN_DEVELOPMENT_SESSION_ENV";

// Only adapter-owned variables belong in this provenance record. It is local
// routing metadata, not an authorisation token or proof of filesystem ownership.
const ROUTED_NAMES = [
  "CARGO_TARGET_DIR", "GOCACHE", "GOMODCACHE", "npm_config_cache",
  "npm_config_store_dir", "YARN_CACHE_FOLDER", "YARN_ENABLE_GLOBAL_CACHE",
  "YARN_ENABLE_MIRROR", "BUN_INSTALL_CACHE_DIR", "UV_CACHE_DIR", "PIP_CACHE_DIR",
  "NUGET_PACKAGES", "COMPOSER_CACHE_DIR", "CCACHE_DIR", "SCCACHE_DIR"
];
const ROUTED_CANONICAL_NAMES = new Map(ROUTED_NAMES.map((name) => [name.toLowerCase(), name]));

function routedName(name, platform = process.platform) {
  // npm defines case-insensitive npm_config_* aliases itself, even on POSIX.
  // Other adapters and our routing metadata use the host's environment rules.
  const canonical = ROUTED_CANONICAL_NAMES.get(name.toLowerCase());
  return canonical && (platform === "win32" || canonical.startsWith("npm_config_") || canonical === name)
    ? canonical : undefined;
}

export function matchingRoutedEnvironmentKeys(env, name, platform = process.platform) {
  const canonical = routedName(name, platform);
  if (canonical?.startsWith("npm_config_")) {
    return Object.keys(env).filter((key) => key.toLowerCase() === canonical.toLowerCase());
  }
  return matchingEnvironmentKeys(env, name, platform);
}

export function injectedEnvironment(env) {
  const value = environmentValue(env, SESSION_ENV_MARKER);
  if (typeof value !== "string" || value.length > 65536) return {};
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result = {};
    for (const [name, item] of Object.entries(parsed)) {
      const canonical = routedName(name);
      if (!canonical || typeof item !== "string" || Object.hasOwn(result, canonical)) return {};
      result[canonical] = item;
    }
    return result;
  } catch {
    return {};
  }
}

export function isInjectedEnvironmentValue(env, name, value, injected = injectedEnvironment(env)) {
  const canonical = routedName(name);
  if (!canonical) return false;
  if (Object.hasOwn(injected, canonical) && injected[canonical] === value) return true;
  // Compatibility with existing Cargo-only runtime environments.
  return canonical === "CARGO_TARGET_DIR"
    && environmentValue(env, "CLEAN_DEVELOPMENT_ACTIVE") === "1"
    && value === environmentValue(env, "CLEAN_DEVELOPMENT_CARGO_TARGET_DIR");
}

export function recordInjectedEnvironment(env, applied) {
  const injected = injectedEnvironment(env);
  const result = {};
  for (const [name, value] of Object.entries(injected)) {
    const keys = matchingRoutedEnvironmentKeys(env, name);
    // An independent case variant must not hide a still-injected spelling
    // from later rerouting or skip, even when a different adapter runs first.
    if (keys.some((key) => env[key] === value)) result[name] = value;
  }
  for (const [name, value] of Object.entries(applied)) {
    const canonical = routedName(name);
    if (canonical && typeof value === "string") result[canonical] = value;
  }
  setEnvironmentValue(env, SESSION_ENV_MARKER, JSON.stringify(result));
}

export function removeInjectedEnvironment(env) {
  const injected = injectedEnvironment(env);
  // Compare every spelling separately: removing a lower-case injected value
  // must not also discard an independently changed upper-case override.
  for (const key of Object.keys(env)) {
    if (isInjectedEnvironmentValue(env, key, env[key], injected)) delete env[key];
  }
}
