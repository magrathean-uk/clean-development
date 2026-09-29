import path from "node:path";

const ROUTING_VARIABLES = new Set([
  "CARGO_TARGET_DIR", "CARGO_BUILD_BUILD_DIR", "GOCACHE", "GOMODCACHE",
  "NPM_CONFIG_CACHE", "NPM_CONFIG_STORE_DIR", "YARN_CACHE_FOLDER",
  "BUN_INSTALL_CACHE_DIR", "UV_CACHE_DIR", "PIP_CACHE_DIR", "NUGET_PACKAGES",
  "COMPOSER_CACHE_DIR", "CCACHE_DIR", "SCCACHE_DIR", "NODE_OPTIONS"
]);

/**
 * Copy an environment without any CLEAN_DEVELOPMENT_* variable (matched
 * case-insensitively, as Windows treats names). Fixtures that spawn the CLI
 * build their child environment from this so an ambient CLEAN_DEVELOPMENT_ROOT
 * or similar override cannot leak in and change which storage a test uses.
 */
export function withoutCleanDevelopmentEnvironment(inherited = process.env) {
  return Object.fromEntries(Object.entries(inherited).filter(([key]) => !key.toUpperCase().startsWith("CLEAN_DEVELOPMENT_")));
}

export function isolatedEnvironment(root, inherited = process.env) {
  const env = Object.fromEntries(Object.entries(withoutCleanDevelopmentEnvironment(inherited))
    .filter(([key]) => !ROUTING_VARIABLES.has(key.toUpperCase())));
  return {
    ...env,
    CLEAN_DEVELOPMENT_HOME: path.join(root, "home"),
    CLEAN_DEVELOPMENT_DATA_HOME: path.join(root, "data"),
    CLEAN_DEVELOPMENT_CONFIG_HOME: path.join(root, "config"),
    CLEAN_DEVELOPMENT_ROOT: path.join(root, "managed")
  };
}

export function summarizeOverhead(direct, routed) {
  if (!direct.length || direct.length !== routed.length || [...direct, ...routed].some((value) => !Number.isFinite(value))) {
    throw new Error("Overhead samples must be non-empty, finite, and paired");
  }
  const percentile = (values, fraction) => {
    const ordered = [...values].sort((left, right) => left - right);
    return Number(ordered[Math.ceil(ordered.length * fraction) - 1].toFixed(2));
  };
  const added = routed.map((value, index) => value - direct[index]);
  return {
    directMedianMs: percentile(direct, 0.5),
    routedMedianMs: percentile(routed, 0.5),
    directP95Ms: percentile(direct, 0.95),
    routedP95Ms: percentile(routed, 0.95),
    addedMedianMs: percentile(added, 0.5),
    addedP95Ms: percentile(added, 0.95)
  };
}
