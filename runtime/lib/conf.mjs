// clean-development 0.6.0: storage.conf reader and machine paths. No dependencies.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const VERSION = "0.6.0";

export function homeDir(env = process.env) {
  const h = env.HOME && path.isAbsolute(env.HOME) ? env.HOME : os.homedir();
  if (!h || h === "/") throw new Error("refusing an empty or root HOME");
  return h;
}
export const machineDir = (env = process.env) => path.join(homeDir(env), "dev", "machine");
export const stateDir = (env = process.env) => path.join(machineDir(env), "state", "clean-development");
export const sessionsDir = (env = process.env) => path.join(stateDir(env), "sessions");
export const stampsDir = (env = process.env) => path.join(stateDir(env), "stamps");
export const logPath = (env = process.env) => path.join(stateDir(env), "hook.log");
export const eventsPath = (env = process.env) => path.join(stateDir(env), "events.jsonl");
export const runtimeRoot = (env = process.env) => path.join(machineDir(env), "runtime", "clean-development");
export const confPath = (env = process.env) => path.join(machineDir(env), "storage.conf");

const NUMERIC = {
  DEPS_CAP_GB: 30, DEPS_MIN_IDLE_HOURS: 2, EXTERNAL_BUILD_DAYS: 14, EXTERNAL_PRUNE_EVERY_DAYS: 7,
  INTERNAL_BUILD_IDLE_HOURS: 24, SESSION_STALE_HOURS: 24, BIG_DOWNLOAD_GB: 5, INTERNAL_MIN_FREE_GB: 40
};
const LISTS = {
  HOME_DOT_ALLOW: ".agents .aws .cache .claude .codex .config .cups .gnupg .insightface .local .opencode .ssh .thumbnails .Trash .warp .zsh_sessions",
  HOME_DOTFILE_ALLOW: ".CFUserTextEncoding .DS_Store .claude.json .claude.json.backup .gitconfig .zcompdump .zprofile .zsh_history .zshenv .zshrc",
  DEV_DOT_ALLOW: ".DS_Store"
};

// Parses the restricted KEY=value syntax documented at the top of storage.conf.
export function parseConf(text, env = process.env) {
  const values = {};
  const errors = [];
  const home = homeDir(env);
  const expand = (raw, lineNo) => raw.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, a, b) => {
    const name = a || b;
    if (name === "HOME") return home;
    if (Object.hasOwn(values, name)) return values[name];
    errors.push(`line ${lineNo}: unknown variable ${name}`);
    return "";
  });
  text.split(/\r?\n/).forEach((line, i) => {
    const lineNo = i + 1;
    const t = line.trim();
    if (!t || t.startsWith("#")) return;
    const m = t.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!m) { errors.push(`line ${lineNo}: not KEY=value`); return; }
    let [, key, raw] = m;
    if (/[`]|\$\(/.test(raw)) { errors.push(`line ${lineNo}: command substitution is not allowed`); return; }
    let value;
    if (raw.startsWith("'")) {
      if (!raw.endsWith("'") || raw.length < 2) { errors.push(`line ${lineNo}: unterminated quote`); return; }
      value = raw.slice(1, -1);
    } else if (raw.startsWith('"')) {
      if (!raw.endsWith('"') || raw.length < 2) { errors.push(`line ${lineNo}: unterminated quote`); return; }
      value = expand(raw.slice(1, -1), lineNo);
    } else {
      if (/\s/.test(raw)) { errors.push(`line ${lineNo}: unquoted value contains spaces`); return; }
      value = expand(raw, lineNo);
    }
    values[key] = value;
  });
  return { values, errors };
}

export function loadConf(env = process.env) {
  const home = homeDir(env);
  const file = confPath(env);
  let text = "";
  const errors = [];
  const warnings = [];
  try { text = fs.readFileSync(file, "utf8"); } catch (e) {
    if (e.code === "ENOENT") warnings.push(`${file} missing; defaults apply`); else errors.push(`${file}: ${e.code || e.message}`);
  }
  const parsed = parseConf(text, env);
  errors.push(...parsed.errors);
  const v = parsed.values;
  const externalVolume = v.EXTERNAL_VOLUME || "4TB";
  const externalRoot = v.EXTERNAL_ROOT || `/Volumes/${externalVolume}/machine`;
  const conf = {
    file,
    version: VERSION,
    externalVolume,
    externalRoot,
    externalCache: v.EXTERNAL_CACHE || path.join(externalRoot, "cache"),
    internalRoot: v.INTERNAL_ROOT || path.join(home, "dev", "machine", "cache"),
    labRoot: v.LAB_ROOT || `/Volumes/${externalVolume}/dev/lab`,
    modelsRoot: v.MODELS_ROOT || `/Volumes/${externalVolume}/models`,
    sdVolume: v.SD_VOLUME || "",
    errors,
    warnings
  };
  for (const [k, def] of Object.entries(NUMERIC)) {
    const n = v[k] === undefined ? def : Number(v[k]);
    if (!Number.isFinite(n) || n < 0) { errors.push(`${k} must be a non-negative number`); conf[k] = def; } else conf[k] = n;
  }
  for (const [k, def] of Object.entries(LISTS)) conf[k] = new Set((v[k] ?? def).split(/\s+/).filter(Boolean));
  const marker = `/Volumes/${externalVolume}`;
  const idx = conf.externalRoot.indexOf(marker);
  const okRoot = idx >= 0 && (conf.externalRoot.length === idx + marker.length || conf.externalRoot[idx + marker.length] === "/");
  conf.mountPoint = okRoot ? conf.externalRoot.slice(0, idx + marker.length) : null;
  for (const k of ["externalRoot", "externalCache", "internalRoot", "labRoot", "modelsRoot"]) {
    if (!path.isAbsolute(conf[k])) errors.push(`${k} must be absolute`);
  }
  if (!okRoot) errors.push(`EXTERNAL_ROOT must be below /Volumes/${externalVolume}`);
  if (!conf.externalCache.startsWith(conf.externalRoot + "/")) errors.push("EXTERNAL_CACHE must be below EXTERNAL_ROOT");
  conf.valid = errors.length === 0;
  return conf;
}
