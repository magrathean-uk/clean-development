import { resolveConfig } from "../../src/config.js";
import { environmentValue, setEnvironmentValue } from "../../src/platform.js";
import { ensureRuntime } from "../../src/runtime.js";
import { nativeSessionEnvironment, normalizeSessionMode, SESSION_MODE_ENV } from "../../src/session.js";

const ADDITIVE_TOMBSTONES = [
  "CLEAN_DEVELOPMENT_ACTIVE",
  "CLEAN_DEVELOPMENT_CARGO_TARGET_DIR",
  "CLEAN_DEVELOPMENT_RESOLVED_ROOT",
  "CLEAN_DEVELOPMENT_SESSION_ENV",
  "CLEAN_DEVELOPMENT_WORKSPACE",
  "CLEAN_DEVELOPMENT_WORKSPACE_ID"
];

function passThroughEnvironment(existing, binDir, includeRuntime = false) {
  const cleaned = nativeSessionEnvironment(existing, { binDir, includeRuntime });
  const internal = new Set(ADDITIVE_TOMBSTONES.map((name) => name.toLowerCase()));
  // The additive merge can resurrect an omitted parent spelling. On POSIX,
  // GOCACHE and gocache are distinct even though routing configuration treats
  // their names case-insensitively; retaining one cannot unset the other.
  const keyIdentity = (name) => process.platform === "win32" ? name.toLowerCase() : name;
  const retainedKeys = new Set(Object.keys(cleaned).map(keyIdentity));
  const removedRouting = Object.keys(existing).filter((name) =>
    !retainedKeys.has(keyIdentity(name)) && !internal.has(name.toLowerCase()));
  if (removedRouting.length) {
    throw new Error(`OpenCode cannot safely unset inherited Clean Development routing (${removedRouting.sort().join(", ")}). Relaunch OpenCode through clean-development agent opencode, or use --session skip.`);
  }
  for (const name of ADDITIVE_TOMBSTONES) setEnvironmentValue(cleaned, name, "");
  return cleaned;
}

function environment(cwd, existing) {
  const inheritedMode = normalizeSessionMode(environmentValue(existing, SESSION_MODE_ENV));
  let config;
  if (inheritedMode && inheritedMode !== "skip") config = resolveConfig({ cwd, env: existing });
  else {
    try {
      config = resolveConfig({ cwd, env: existing });
    } catch {
      config = resolveConfig({ cwd, env: existing, includeProject: false });
    }
  }
  const sessionMode = config.enabled === false
    ? "skip"
    : inheritedMode || "skip";
  if (config.enabled === false) return passThroughEnvironment(existing, config.locations.binDir);
  const runtime = ensureRuntime(config, { automatic: true });
  if (sessionMode === "skip") {
    return passThroughEnvironment(existing, runtime?.binDir || config.locations.binDir, Boolean(runtime));
  }
  return nativeSessionEnvironment(existing, {
    mode: sessionMode,
    binDir: runtime?.binDir || config.locations.binDir,
    includeRuntime: Boolean(runtime)
  });
}

export const CleanDevelopmentPlugin = async ({ directory }) => ({
  "shell.env": async (input, output) => {
    output.env ||= {};
    const activated = environment(input.cwd || directory || process.cwd(), { ...process.env, ...output.env });
    for (const name of Object.keys(output.env)) delete output.env[name];
    Object.assign(output.env, activated);
  }
});

export default CleanDevelopmentPlugin;
