// Read-only storage inventory. No session registration, probes or cached measurements.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { homeDir, loadConf, stateDir, VERSION } from "./conf.mjs";
import { detect, freeBytes, workRoot } from "./storage.mjs";

export const inside = (root, item) => item === root || item.startsWith(root + path.sep);

// Resolve existing ancestors too, so a missing leaf under a redirected cache is still checked.
export function realPath(item) {
  const absolute = path.resolve(item);
  try { return fs.realpathSync(absolute); } catch (e) {
    if (e.code !== "ENOENT") throw e;
    const parent = path.dirname(absolute);
    if (parent === absolute) throw e;
    return path.join(realPath(parent), path.basename(absolute));
  }
}

export function walk(item) {
  let bytes = 0, count = 0, newest = 0;
  function visit(p) {
    const stat = fs.lstatSync(p);
    count++;
    newest = Math.max(newest, stat.mtimeMs, stat.ctimeMs);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(p).sort()) visit(path.join(p, name));
    } else bytes += stat.size;
  }
  visit(item);
  return { bytes, count, newest };
}

export function context(env = process.env) {
  const conf = loadConf(env);
  const detected = detect(conf, env, { probe: false, create: false });
  return { conf, home: homeDir(env), mode: detected.mode, root: detected.root,
    work: env.CLEAN_DEV_WORK || workRoot(conf, detected.mode, env) };
}

const CACHE_VARIABLES = [
  "DEVCACHE", "CLEAN_DEVELOPMENT_ROOT", "CLEAN_DEVELOPMENT_CACHE_ROOT", "CLEAN_DEVELOPMENT_BUILD_ROOT",
  "CLEAN_DEVELOPMENT_SCRATCH_ROOT", "CLEAN_DEV_BUILDS", "CLEAN_DEV_SCRATCH", "XCODE_DERIVED_DATA_PATH",
  "DEVLIBRARY", "SWIFTPM_SHARED_CACHE", "CLANG_MODULE_CACHE_PATH", "HOMEBREW_CACHE", "XDG_CACHE_HOME",
  "GOCACHE", "GOMODCACHE", "BUN_INSTALL_CACHE_DIR", "pnpm_config_store_dir", "npm_config_cache",
  "YARN_CACHE_FOLDER", "UV_CACHE_DIR", "PIP_CACHE_DIR", "HF_HUB_CACHE", "HF_ASSETS_CACHE", "TORCH_HOME",
  "NUGET_PACKAGES", "PYTHONPYCACHEPREFIX", "PLAYWRIGHT_BROWSERS_PATH"
];

const KNOWN_CACHES = [
  ".npm", ".cache", ".bun/install/cache", ".gradle/caches", ".nuget/packages",
  "Library/Caches/Homebrew", "Library/Caches/pip", "Library/Caches/uv", "Library/Caches/Yarn",
  "Library/Caches/pnpm", "Library/Caches/go-build", "Library/Caches/ms-playwright",
  "Library/Developer/Xcode/DerivedData", "node_modules", "DerivedData", "npm", "pnpm", "yarn", "cache"
];

function measurement(item) {
  try { return { path: item, ...walk(item) }; }
  catch (e) { return { path: item, bytes: null, error: e.code || e.message }; }
}

// Same rule as machine/env.zsh: nonempty Claude ID wins, including when rejected. IDs need 12+ ASCII
// letters/digits/_/- and no lower- or uppercase placeholder token delimited by the ends, hyphens or underscores.
function agentShell(env) {
  const id = env.CLAUDE_CODE_SESSION_ID || env.CODEX_THREAD_ID || "";
  const placeholders = new Set("unset placeholder changeme dummy example stub undefined null none todo".split(" "));
  return id.length >= 12 && !/[^A-Za-z0-9_-]/.test(id) &&
    !id.split(/[-_]/).some((token) => (token === token.toLowerCase() || token === token.toUpperCase()) && placeholders.has(token.toLowerCase()));
}

function restartReasons(dir, inventory, count) {
  try {
    const file = path.join(dir, "homes-restarts.json");
    if (!fs.lstatSync(file).isFile()) return;
    const { inventorySha256, reasons } = JSON.parse(fs.readFileSync(file, "utf8"));
    if (inventorySha256 === createHash("sha256").update(inventory).digest("hex") &&
        Array.isArray(reasons) && reasons.length === count &&
        reasons.every((reason) => reason === "skill-text" || reason === "none")) return reasons;
  } catch { /* Restart metadata is optional. */ }
}

function agentHomes(env) {
  const dir = stateDir(env);
  let inventory;
  try { inventory = fs.readFileSync(path.join(dir, "homes.txt")); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const lines = inventory.toString("utf8").split(/\r?\n/).filter((line) => line.trim());
  const reasons = restartReasons(dir, inventory, lines.length);
  return lines.map((line, index) => {
    // Read fixed trailing columns so a home path can contain spaces.
    // Accept 1.0.0 rows until the next home refresh rewrites the inventory.
    const row = /^home (.+) (claude|codex) (\S+) ([a-f0-9]{12}|-) ([a-f0-9]{12}|-)( running-older)?(?: restart=(?:skill-text|none))?$/.exec(line);
    if (!row) throw new Error("invalid agent home inventory line");
    return { path: row[1], harness: row[2], version: row[3], hook: row[4], skill: row[5],
      runningOlder: !!row[6], restartReason: reasons?.[index] ?? "unknown" };
  });
}

export function report(env = process.env, { check = false } = {}) {
  const c = context(env), root = realPath(c.root), routing = [];
  for (const name of CACHE_VARIABLES) {
    if (!env[name]) continue;
    let ok = false;
    try { ok = path.isAbsolute(env[name]) && inside(root, realPath(env[name])); } catch { /* report unreadable paths */ }
    if (!ok) routing.push({ name, value: env[name], reason: "outside root" });
  }
  if (agentShell(env)) {
    const scratch = env.CLEAN_DEV_SCRATCH || (env.CLEAN_DEV_BUILDS && path.join(c.root, "scratch", path.basename(env.CLEAN_DEV_BUILDS)));
    let ok = false;
    try {
      const actual = env.TMPDIR && realPath(env.TMPDIR);
      const expected = scratch && realPath(path.join(scratch, "tmp"));
      ok = !!actual && path.isAbsolute(env.TMPDIR) && !!expected && inside(realPath(path.join(root, "scratch")), expected) && actual === expected;
    } catch { /* invalid or unreadable scratch */ }
    if (!ok) routing.push({ name: "TMPDIR", value: env.TMPDIR || "", reason: "outside agent scratch tmp" });
  }
  const homes = agentHomes(env);
  // The check path reads the small home inventory, but never scans or sizes storage.
  if (check)
    return { mode: c.mode, root: c.root, drives: [], roots: [], routing, caches: [], homes, errors: c.conf.errors };
  const known = new Set();
  for (const base of [c.home, c.conf.mountPoint].filter(Boolean)) for (const relative of KNOWN_CACHES) {
    const item = path.join(base, relative);
    try {
      if (fs.lstatSync(item).isSymbolicLink() || inside(root, realPath(item))) continue;
      known.add(item);
    } catch { /* absent cache */ }
  }
  return { mode: c.mode, root: c.root,
    drives: [{ name: "internal", path: c.home, free: freeBytes(c.home) },
      { name: "external", path: c.conf.mountPoint, free: freeBytes(c.conf.mountPoint) }],
    roots: [measurement(c.conf.internalRoot), measurement(c.conf.externalCache)],
    routing, caches: [...known].sort().map(measurement), homes, errors: c.conf.errors };
}

export function reportText(result) {
  return [`mode: ${result.mode}; root: ${result.root}`,
    ...result.drives.map((d) => `${d.name} free: ${d.free ?? "unavailable"} bytes (${d.path})`),
    ...result.roots.map((r) => `root: ${r.path}; ${r.bytes ?? "unknown"} bytes${r.error ? ` (${r.error})` : ""}`),
    ...result.routing.map((r) => `routing: ${r.name}=${r.value} (${r.reason})`),
    ...result.caches.map((r) => `cache outside root: ${r.path}; ${r.bytes ?? "unknown"} bytes`),
    ...(result.homes.length ? [
      `agent homes: ${result.homes.filter((h) => h.version === VERSION).length}/${result.homes.length} current (${VERSION})`,
      ...result.homes.filter((h) => h.version !== VERSION || h.runningOlder).map((h) =>
        `  ${h.path}: ${h.version}${h.runningOlder ? " running-older" : ""}`),
      ...result.homes.map((h) => `restart ${h.path} ${h.restartReason}`)
    ] : []),
    ...result.errors.map((e) => `policy: ${e}`)].join("\n");
}
