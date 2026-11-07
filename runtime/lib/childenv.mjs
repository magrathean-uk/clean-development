import fs from "node:fs";
import path from "node:path";
import { stateDir } from "./conf.mjs";

export const ROUTING_NAMES = Object.freeze([
  "CLEAN_DEV_VERSION", "CLEAN_DEV_MODE", "CLEAN_DEV_STAMP", "CLEAN_DEV_SESSION", "CLEAN_DEV_SCRATCH", "CLEAN_DEV_BUILDS", "CLEAN_DEV_WORK", "DEVCACHE", "TMPDIR",
  "CLEAN_DEVELOPMENT_SCRATCH_ROOT", "CLEAN_DEVELOPMENT_ROOT", "CLEAN_DEVELOPMENT_CACHE_ROOT", "CLEAN_DEVELOPMENT_BUILD_ROOT",
  "DEVDRIVE", "DEV_CACHE_VOLUME", "DEVLAB", "DEVMODELS", "DEVLIBRARY",
  "XCODE_DERIVED_DATA_PATH", "SWIFTPM_SHARED_CACHE", "CLANG_MODULE_CACHE_PATH", "PYTHONPYCACHEPREFIX",
  "HOMEBREW_CACHE", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME",
  "CARGO_HOME", "RUSTUP_HOME", "GOPATH", "GOCACHE", "GOMODCACHE", "BUN_INSTALL", "BUN_INSTALL_CACHE_DIR", "PNPM_HOME", "pnpm_config_store_dir", "npm_config_cache",
  "YARN_CACHE_FOLDER", "YARN_GLOBAL_FOLDER", "UV_CACHE_DIR", "UV_PYTHON_INSTALL_DIR", "UV_TOOL_DIR", "UV_TOOL_BIN_DIR", "PIP_CACHE_DIR", "HF_HOME", "TORCH_HOME", "OLLAMA_MODELS",
  "GRADLE_USER_HOME", "NUGET_PACKAGES", "DOTNET_CLI_HOME", "BUNDLE_USER_HOME", "GEM_HOME", "GEM_SPEC_CACHE", "MPLCONFIGDIR", "PLAYWRIGHT_BROWSERS_PATH",
  "TART_HOME", "LIMA_HOME", "COLIMA_HOME", "DOCKER_CONFIG", "PYTHON_HISTORY", "SQLITE_HISTORY"
]);

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Harness identity and secrets never pass, even when named in keep. CODEX_HOME, CLAUDE_CONFIG_DIR (a seat's config)
// and SSH_AUTH_SOCK (agent access) pass only when named in keep.
const KEEP_ONLY = new Set(["CODEX_HOME", "CLAUDE_CONFIG_DIR", "SSH_AUTH_SOCK"]);
const denied = (name) => /^(CLAUDE_|ANTHROPIC_|OPENAI_|CODEX_|MCP_|OP_SESSION_)/i.test(name) || /^CLAUDECODE$/i.test(name)
  || /(?:_TOKEN|_KEY|_PAT)$/i.test(name) || /_SECRET|PASSWORD/i.test(name) || /^AWS_(?:ACCESS|SECRET)/i.test(name);

function extraRoutingNames(env) {
  try {
    const file = path.join(stateDir(env), "childenv-allow.list");
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return [];
    return fs.readFileSync(file, "utf8").split(/\r?\n/).map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
  } catch { return []; }
}

export function childEnv(env = process.env, { keep = [] } = {}) {
  const extra = extraRoutingNames(env).filter((name) => !KEEP_ONLY.has(name));
  const wanted = new Set(["HOME", "USER", "LOGNAME", "SHELL", "PATH", "LANG", "LC_ALL", "TERM", "TZ",
    ...ROUTING_NAMES, ...extra, "CLEAN_DEV_SESSION", "CLEAN_DEV_STAMP", "DEV", "DEVMACHINE", ...keep]);
  const out = {}, refused = new Set();
  for (const name of wanted) {
    if (typeof name !== "string" || !NAME.test(name) || (denied(name) && !(KEEP_ONLY.has(name) && keep.includes(name)))) {
      if (keep.includes(name) || Object.hasOwn(env, name)) refused.add(name);
      continue;
    }
    if (!Object.hasOwn(env, name) || env[name] === undefined) continue;
    const value = String(env[name]);
    if (value.includes("\0")) { refused.add(name); continue; }
    out[name] = value;
  }
  for (const name of Object.keys(env)) if (denied(name) && !(KEEP_ONLY.has(name) && keep.includes(name))) refused.add(name);
  Object.defineProperty(out, "refused", { value: [...refused], enumerable: false });
  return out;
}

export function formatEnv(obj, format) {
  const entries = Object.entries(obj);
  if (entries.some(([name, value]) => !NAME.test(name) || typeof value !== "string" || value.includes("\0"))) throw new Error("invalid environment name or value");
  if (format === "json") return JSON.stringify(obj, null, 2) + "\n";
  if (format === "null") return entries.map(([name, value]) => `${name}=${value}\0`).join("");
  if (format === "sh") return entries.map(([name, value]) => `export ${name}='${value.replaceAll("'", "'\\''")}'\n`).join("");
  throw new Error("environment format must be sh, json or null");
}
