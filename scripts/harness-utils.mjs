import fs from "node:fs";
import os from "node:os";
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

/**
 * Native verification children need a disposable HOME as well as CLI state.
 * This is additive: ordinary CLI unit fixtures can keep isolatedEnvironment's
 * narrower contract. Callers create the selected directories before execution.
 * Explicit overrides are applied last for prepared hermetic tool/config homes;
 * installed executables, SDK selection and toolchain pins otherwise stay intact.
 */
export function isolatedNativeEnvironment(root, inherited = process.env, { overrides = {} } = {}) {
  if (!path.isAbsolute(root) || path.resolve(root) === path.parse(root).root || path.resolve(root) === path.resolve(os.homedir())) {
    throw new Error("Native fixture root must be a dedicated absolute directory");
  }
  const env = isolatedEnvironment(root, inherited);
  // An inherited shell startup hook can restore real-home routing after fixture
  // isolation. Explicit fixture overrides may supply their own startup files.
  for (const key of Object.keys(env)) {
    if (["BASH_ENV", "ENV", "ZDOTDIR", "NODE_PATH", "PYTHONSTARTUP"].includes(key.toUpperCase())) delete env[key];
  }
  // npm's aliases are case-insensitive even on Unix; remove ambient config
  // flags before declaring one fixture-owned spelling for each cache/config.
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith("NPM_CONFIG_")) delete env[key];
  }
  const home = path.join(root, "native-home"), cache = path.join(root, "native-cache");
  const config = path.join(root, "native-config"), data = path.join(root, "native-data");
  const tmp = path.join(root, "managed", "scratch", "tmp");
  const defaults = {
    HOME: home, USERPROFILE: home,
    APPDATA: config, LOCALAPPDATA: data,
    XDG_CACHE_HOME: cache, XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data, XDG_STATE_HOME: path.join(root, "native-state"),
    TMPDIR: tmp, TMP: tmp, TEMP: tmp,
    CLEAN_DEVELOPMENT_CACHE_ROOT: path.join(root, "managed", "caches"),
    CLEAN_DEVELOPMENT_BUILD_ROOT: path.join(root, "managed", "builds"),
    CLEAN_DEVELOPMENT_SCRATCH_ROOT: path.join(root, "managed", "scratch"),
    CODEX_HOME: path.join(config, "codex"), CLAUDE_CONFIG_DIR: path.join(config, "claude"),
    CARGO_HOME: path.join(data, "cargo"), ...rustupHomeEnvironment(inherited), RUSTUP_AUTO_INSTALL: "0",
    GOPATH: path.join(data, "go"), GOCACHE: path.join(cache, "go", "build"), GOMODCACHE: path.join(cache, "go", "modules"),
    GOENV: inherited.GOENV ?? "off",
    npm_config_cache: path.join(cache, "npm"), npm_config_store_dir: path.join(cache, "pnpm"),
    npm_config_userconfig: path.join(config, "npm-user.config"), npm_config_globalconfig: path.join(config, "npm-global.config"),
    YARN_CACHE_FOLDER: path.join(cache, "yarn"), BUN_INSTALL_CACHE_DIR: path.join(cache, "bun"),
    UV_CACHE_DIR: path.join(cache, "uv"), PIP_CACHE_DIR: path.join(cache, "pip"), PIP_CONFIG_FILE: path.join(config, "pip.conf"),
    PYTHONUSERBASE: path.join(data, "python"), PYTHONPYCACHEPREFIX: path.join(cache, "python", "bytecode"),
    PYTHONNOUSERSITE: "1",
    COREPACK_HOME: path.join(data, "corepack"), PNPM_HOME: path.join(data, "pnpm"),
    DOTNET_CLI_HOME: path.join(data, "dotnet"), NUGET_PACKAGES: path.join(cache, "nuget"),
    COMPOSER_HOME: path.join(config, "composer"), COMPOSER_CACHE_DIR: path.join(cache, "composer"),
    CCACHE_DIR: path.join(cache, "ccache"), SCCACHE_DIR: path.join(cache, "sccache"),
    GRADLE_USER_HOME: path.join(data, "gradle"),
    GIT_CONFIG_GLOBAL: inherited.GIT_CONFIG_GLOBAL ?? path.join(config, "gitconfig"),
    ...overrides
  };
  // Windows environment names are case-insensitive. Collapse native fixture
  // defaults without retaining an inherited alternate spelling beside them.
  const native = { ...env };
  for (const [key, value] of Object.entries(defaults)) {
    for (const existing of Object.keys(native)) {
      if (existing.toUpperCase() === key.toUpperCase()) delete native[existing];
    }
    native[key] = value;
  }
  return native;
}

/**
 * RUSTUP_HOME for children that run with a disposable HOME. Rustup derives its
 * default home from HOME, so a child that does not name the installed toolchain
 * cannot find it. Use the inherited value; otherwise rustup's default location, but
 * only when a toolchain is already installed there. Never name a path that is
 * absent (rustup would create it) and never invent one: return nothing so the
 * child's disposable HOME applies and nothing is created under the real home.
 */
export function rustupHomeEnvironment(inherited = process.env, home = os.homedir()) {
  if (inherited.RUSTUP_HOME) return { RUSTUP_HOME: inherited.RUSTUP_HOME };
  const installed = path.join(home, ".rustup");
  return fs.statSync(path.join(installed, "toolchains"), { throwIfNoEntry: false })?.isDirectory() ? { RUSTUP_HOME: installed } : {};
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
