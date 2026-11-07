// clean-development 0.6.2: storage.conf reader and machine paths. No dependencies.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strictlyBelow } from "./fsutil.mjs";

export const VERSION = "0.6.8";

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
export const deletionsPath = (env = process.env) => path.join(stateDir(env), "deletions.jsonl");
// Durable ownership index for prune --project: owners/<key>/.owner.json, outside every cache root (0.6.2).
export const ownersDir = (env = process.env) => path.join(stateDir(env), "owners");
export const runtimeRoot = (env = process.env) => path.join(machineDir(env), "runtime", "clean-development");
// Version-less hook entry written by install.sh. Hook command text (and so Codex trust hashes) survives upgrades;
// the shim names the active immutable release. Release directories are the X.Y.Z siblings of active/.
export const hookShimPath = (env = process.env) => path.join(runtimeRoot(env), "active", "bin", "cd-hook");
export const RELEASE_DIR = /^\d+\.\d+\.\d+$/;
const shq = (s) => `'${s.replaceAll("'", "'\\''")}'`;
export function hookShimText(env = process.env, version = VERSION) {
  if (!RELEASE_DIR.test(version)) throw new Error("invalid release version");
  return `#!/bin/sh\n# clean-development hook shim: stable harness command; the managed CLI launcher selects Node.\n`
    + `rt=${shq(path.join(runtimeRoot(env), version))}\n[ -x "$rt/bin/cd-hook" ] || exit 0\n`
    + `cli=${shq(path.join(machineDir(env), "bin", "clean-development"))}\n[ -x "$cli" ] || exit 0\nexec "$cli" hook "$@"\n`;
}
// The release a shim names, or null when the text is not a shim this runtime wrote.
export function shimRelease(text, env = process.env) {
  const m = String(text).match(/^rt='([^']+)'$/m);
  if (!m || path.dirname(m[1]) !== runtimeRoot(env) || !RELEASE_DIR.test(path.basename(m[1]))) return null;
  return text === hookShimText(env, path.basename(m[1])) ? path.basename(m[1]) : null;
}
export const confPath = (env = process.env) => path.join(machineDir(env), "storage.conf");

const NUMERIC = {
  DEPS_CAP_GB: 30, DEPS_MIN_IDLE_HOURS: 2, EXTERNAL_BUILD_DAYS: 14, EXTERNAL_PRUNE_EVERY_DAYS: 7,
  INTERNAL_BUILD_IDLE_HOURS: 24, SESSION_STALE_HOURS: 24, BIG_DOWNLOAD_GB: 5, INTERNAL_MIN_FREE_GB: 40
};
const LISTS = {
  DEV_TOP_ALLOW: "machine source",
  HOME_DOT_ALLOW: ".agents .aws .cache .claude .codex .config .cups .gnupg .local .opencode .ssh .thumbnails .Trash .warp .zsh_sessions",
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

export function loadConf(env = process.env, { text: suppliedText } = {}) {
  const home = homeDir(env);
  const file = confPath(env);
  let text = "";
  const errors = [];
  const warnings = [];
  try { text = suppliedText ?? fs.readFileSync(file, "utf8"); } catch (e) {
    if (e.code === "ENOENT") warnings.push(`${file} missing; defaults apply`); else errors.push(`${file}: ${e.code || e.message}`);
  }
  const parsed = parseConf(text, env);
  errors.push(...parsed.errors);
  const v = parsed.values;
  const keys = new Set(["STORAGE_CONF_VERSION", "EXTERNAL_VOLUME", "EXTERNAL_ROOT", "EXTERNAL_CACHE", "INTERNAL_ROOT", "LAB_ROOT", "MODELS_ROOT", "SD_VOLUME", ...Object.keys(NUMERIC), ...Object.keys(LISTS)]);
  for (const key of Object.keys(v)) if (!keys.has(key)) errors.push(`unknown policy key ${key}`);
  const externalVolume = v.EXTERNAL_VOLUME ?? "External";
  const externalRoot = v.EXTERNAL_ROOT ?? `/Volumes/${externalVolume}/dev`;
  const conf = {
    file,
    version: VERSION,
    externalVolume,
    externalRoot,
    externalCache: v.EXTERNAL_CACHE ?? path.join(externalRoot, "cache"),
    internalRoot: v.INTERNAL_ROOT ?? path.join(home, "dev", "machine", "cache"),
    labRoot: v.LAB_ROOT ?? `/Volumes/${externalVolume}/dev/lab`,
    modelsRoot: v.MODELS_ROOT ?? `/Volumes/${externalVolume}/models`,
    sdVolume: v.SD_VOLUME || "",
    errors,
    warnings
  };
  for (const [k, def] of Object.entries(NUMERIC)) {
    const n = v[k] === undefined ? def : Number(v[k]);
    if (!Number.isFinite(n) || n < 0 || (v[k] !== undefined && !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(v[k]))) { errors.push(`${k} must be a non-negative plain decimal`); conf[k] = def; } else conf[k] = n;
  }
  for (const [k, def] of Object.entries(LISTS)) conf[k] = new Set((v[k] ?? def).split(/\s+/).filter(Boolean));
  for (const k of ["externalRoot", "externalCache", "internalRoot", "labRoot", "modelsRoot"]) {
    if (!path.isAbsolute(conf[k]) || conf[k].includes("\0") || conf[k].split(path.sep).some((s) => s === ".." || s === ".")) errors.push(`${k} must be absolute without . or .. components`);
    else conf[k] = path.resolve(conf[k]);
  }
  const marker = `/Volumes/${externalVolume}`;
  const idx = conf.externalRoot.indexOf(marker);
  const okRoot = idx >= 0 && (conf.externalRoot.length === idx + marker.length || conf.externalRoot[idx + marker.length] === "/");
  conf.mountPoint = okRoot ? conf.externalRoot.slice(0, idx + marker.length) : null;
  if (!okRoot) errors.push(`EXTERNAL_ROOT must be below /Volumes/${externalVolume}`);
  if (!externalVolume || externalVolume.includes("/") || externalVolume === "." || externalVolume === "..") errors.push("EXTERNAL_VOLUME must be one volume name");
  if (!strictlyBelow(path.resolve(conf.externalRoot), path.resolve(conf.externalCache))) errors.push("EXTERNAL_CACHE must be below EXTERNAL_ROOT");
  const anchors = [conf.internalRoot, conf.externalCache].map((p) => path.resolve(p));
  if (anchors[0] === anchors[1] || strictlyBelow(anchors[0], anchors[1]) || strictlyBelow(anchors[1], anchors[0])) errors.push("cache anchors must not overlap");
  for (const anchor of anchors) {
    // Caches may not contain machine state/toolchains, source, HOME or protected model/lab data.
    for (const protectedPath of [home, path.join(home, "dev", "machine"), path.join(home, "dev", "source"), conf.labRoot, conf.modelsRoot]) {
      const p = path.resolve(protectedPath);
      if (anchor === p || strictlyBelow(anchor, p)) errors.push(`cache root contains protected path ${p}`);
    }
    for (const p of [path.join(home, "dev", "source"), path.join(home, "dev", "machine", "state"), path.join(home, "dev", "machine", "toolchains"), conf.labRoot, conf.modelsRoot].map((p) => path.resolve(p))) {
      if (strictlyBelow(p, anchor)) errors.push(`cache root is inside protected path ${p}`);
    }
    if (anchor === path.parse(anchor).root) errors.push("cache root must not be a filesystem root");
  }
  conf.valid = errors.length === 0;
  // Startup is fail-open using a known routing default; invalid policy never authorises cleanup.
  if (!conf.valid) conf.internalRoot = path.join(home, "dev", "machine", "cache");
  return conf;
}
