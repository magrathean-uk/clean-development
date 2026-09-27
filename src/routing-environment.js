import { environmentValue, setEnvironmentValue } from "./platform.js";

export const SESSION_ENV_MARKER = "CLEAN_DEVELOPMENT_SESSION_ENV";

// Only adapter-owned variables belong in this provenance record. It is local
// routing metadata, not an authorisation token or proof of filesystem ownership.
const ROUTED_NAMES = new Map([
  "CARGO_TARGET_DIR", "GOCACHE", "GOMODCACHE", "npm_config_cache",
  "npm_config_store_dir", "YARN_CACHE_FOLDER", "YARN_ENABLE_GLOBAL_CACHE",
  "YARN_ENABLE_MIRROR", "BUN_INSTALL_CACHE_DIR", "UV_CACHE_DIR", "PIP_CACHE_DIR",
  "NUGET_PACKAGES", "COMPOSER_CACHE_DIR", "CCACHE_DIR", "SCCACHE_DIR"
].map((name) => [name.toLowerCase(), name]));

export function injectedEnvironment(env) {
  const value = environmentValue(env, SESSION_ENV_MARKER);
  if (typeof value !== "string" || value.length > 65536) return {};
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result = {};
    for (const [name, item] of Object.entries(parsed)) {
      const canonical = ROUTED_NAMES.get(name.toLowerCase());
      if (!canonical || typeof item !== "string" || Object.hasOwn(result, canonical)) return {};
      result[canonical] = item;
    }
    return result;
  } catch {
    return {};
  }
}

export function isInjectedEnvironmentValue(env, name, value, injected = injectedEnvironment(env)) {
  const canonical = ROUTED_NAMES.get(name.toLowerCase());
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
    const keys = Object.keys(env).filter((key) => key.toLowerCase() === name.toLowerCase());
    if (keys.length && keys.every((key) => env[key] === value)) result[name] = value;
  }
  for (const [name, value] of Object.entries(applied)) {
    const canonical = ROUTED_NAMES.get(name.toLowerCase());
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
