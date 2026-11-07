// Read-only installation and unmanaged-storage inventories.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { homeDir, stateDir } from "./conf.mjs";
import { detect, externalWorkRoot, rootExtras } from "./storage.mjs";
import { lstatOrNull, readJsonOrNull, safeDirectory } from "./fsutil.mjs";

const realDir = (p) => lstatOrNull(p)?.isDirectory() === true;
function entries(dir) { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } }
function listedPath(value, home) {
  if (value.includes("\0")) return null;
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.resolve(home, value.slice(2));
  return path.isAbsolute(value) ? path.resolve(value) : null;
}

function regularFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function registryRows(file, home, kind) {
  let text = "";
  const errors = [], optionalMissing = [], rows = [];
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { if (e.code !== "ENOENT") errors.push(file + ": " + (e.code || e.message)); }
  text.split(/\r?\n/).forEach((line, i) => {
    let value = line.trim();
    if (!value || value.startsWith("#")) return;
    const optional = value.startsWith("?");
    if (optional) value = value.slice(1).trim();
    const resolved = listedPath(value, home);
    if (!resolved) {
      errors.push(file + ":" + (i + 1) + ": " + kind + " path must be absolute or start with ~/: " + value);
      return;
    }
    const present = kind === "Codex home"
      ? regularFile(path.join(resolved, "config.toml")) || regularFile(path.join(resolved, "hooks.json"))
      : regularFile(resolved);
    if (optional && !present) optionalMissing.push(resolved);
    else rows.push({ path: resolved, optional });
  });
  return { rows, errors, optionalMissing };
}

export function codexHomes(env = process.env) {
  const home = homeDir(env), file = path.join(stateDir(env), "codex-homes.list"), defaultHome = path.join(home, ".codex");
  const registry = registryRows(file, home, "Codex home"), candidates = [];
  if (regularFile(path.join(defaultHome, "config.toml")) || regularFile(path.join(defaultHome, "hooks.json"))) candidates.push(defaultHome);
  const explicit = new Set();
  for (const row of registry.rows) { candidates.push(row.path); explicit.add(row.path); }
  return { homes: [...new Set(candidates)], errors: registry.errors, explicit, optionalMissing: registry.optionalMissing };
}

export function claudeSettings(env = process.env) {
  const home = homeDir(env), file = path.join(stateDir(env), "claude-settings.list"), defaultFile = path.join(home, ".claude", "settings.json");
  const registry = registryRows(file, home, "Claude settings"), candidates = regularFile(defaultFile) ? [defaultFile] : [];
  for (const row of registry.rows) candidates.push(row.path);
  return { files: [...new Set(candidates)], errors: registry.errors, explicit: new Set(registry.rows.map((r) => r.path)), optionalMissing: registry.optionalMissing };
}

export function claudeProfiles(env = process.env) {
  const home = homeDir(env), file = path.join(stateDir(env), "claude-profiles.list");
  const registry = registryRows(file, home, "Claude profile settings"), files = [];
  for (const row of registry.rows) {
    if (regularFile(row.path)) files.push(row.path);
    else registry.errors.push(row.path + ": Claude profile settings must be an existing regular file (prefix optional entries with ? to skip absent files)");
  }
  return { files: [...new Set(files)], errors: registry.errors, optionalMissing: registry.optionalMissing };
}

export function inventoryExtras(conf, env = process.env, { sizes = null, internalWarnBytes = 1024 ** 3, deadline = Infinity } = {}) {
  const external = detect(conf, env, { probe: false, create: false }).mode === "external", out = {};
  for (const [label, root] of [["internal", conf.internalRoot], ...(external ? [["external", conf.externalCache]] : [])]) {
    out[label] = [];
    if (Date.now() >= deadline) { out.incomplete = true; continue; }
    if (!safeDirectory(root, root, { missingAnchor: true })) continue;
    for (const entry of rootExtras(root, { sizes: false })) {
      if (Date.now() >= deadline) { out.incomplete = true; break; }
      const st = lstatOrNull(entry.path), measured = sizes?.roots?.[root]?.extras?.[entry.name];
      const bytes = Number.isFinite(measured) && measured >= 0 ? measured : null;
      let owner = null;
      if (st?.isDirectory()) {
        // Regular, small files only: a FIFO or link named .owner.json must not hang or redirect doctor.
        const ownerFile = path.join(entry.path, ".owner.json"), of = lstatOrNull(ownerFile);
        const doc = of?.isFile() && of.size <= 65536 ? readJsonOrNull(ownerFile) : null;
        if (doc && typeof doc === "object" && !Array.isArray(doc)) {
          const fields = Object.fromEntries(["repo", "cwd", "harness", "key"].filter((k) => typeof doc[k] === "string" && doc[k]).map((k) => [k, doc[k]]));
          if (Object.keys(fields).length) owner = fields;
        }
        if (!owner) owner = entries(entry.path).find((d) => d.isFile() && /^MOVED-TO-.*\.txt$/.test(d.name))?.name || null;
      }
      const misplaced = label === "internal" && external;
      out[label].push({ ...entry, bytes, measuredAt: bytes === null ? null : sizes.measuredAt, owner, mtimeMs: st?.mtimeMs ?? null,
        misplaced, overCap: misplaced && bytes !== null && bytes > internalWarnBytes });
    }
  }
  return out;
}

function sourceDirs(home) {
  const root = path.join(home, "dev", "source");
  return safeDirectory(home, root, { missingAnchor: true }) && realDir(root) ? entries(root).filter((d) => d.isDirectory()).map((d) => path.join(root, d.name)) : [];
}

// Doctor uses the 3 s default; callers may pass their own deadline.
export function scanLiteralCachePaths(conf, env = process.env, { deadline = Date.now() + 3000 } = {}) {
  const home = homeDir(env), hits = [], literals = new Set([conf.internalRoot, conf.externalCache]);
  if (conf.internalRoot.startsWith(home + path.sep)) for (const prefix of ["~", "$HOME"]) literals.add(prefix + conf.internalRoot.slice(home.length));
  let incomplete = false, files = 0, dirs = 0;
  const expired = () => { if (Date.now() >= deadline) incomplete = true; return incomplete && Date.now() >= deadline; };
  function scan(file) {
    if (expired()) return;
    if (files >= 2000) { incomplete = true; return; }
    const st = lstatOrNull(file);
    if (!st?.isFile()) return;
    files++;
    if (st.size > 1024 ** 2) { incomplete = true; return; }
    let fd;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      if (!fs.fstatSync(fd).isFile()) return;
      const buffer = Buffer.alloc(1024 ** 2 + 1), n = fs.readSync(fd, buffer, 0, buffer.length, 0);
      if (n > 1024 ** 2) { incomplete = true; return; }
      if (buffer.subarray(0, Math.min(n, 4096)).includes(0)) return;
      buffer.subarray(0, n).toString("utf8").split(/\r?\n/).forEach((line, i) => {
        if ([...literals].some((literal) => literal && line.includes(literal))) hits.push({ file, line: i + 1 });
      });
    } catch { incomplete = true; } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  function walk(dir) {
    if (expired() || files >= 2000 || dirs >= 2000) { incomplete = true; return; }
    if (!safeDirectory(home, dir) || !realDir(dir)) return;
    dirs++;
    let iterator;
    try {
      iterator = fs.opendirSync(dir);
      for (let entry; (entry = iterator.readSync());) {
        if (expired() || files >= 2000 || dirs >= 2000) { incomplete = true; break; }
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.isFile()) scan(file);
      }
    } catch { incomplete = true; } finally { iterator?.closeSync(); }
  }
  const agents = path.join(home, "Library", "LaunchAgents");
  if (safeDirectory(home, agents) && realDir(agents)) for (const entry of entries(agents)) {
    if (expired() || files >= 2000) { incomplete = true; break; }
    if (entry.isFile() && entry.name.endsWith(".plist")) scan(path.join(agents, entry.name));
  }
  const dev = path.join(home, "dev");
  const otherRoots = [...conf.DEV_TOP_ALLOW].filter((name) => !["source", "machine"].includes(name))
    .map((name) => path.join(dev, name)).filter(realDir);
  const repos = [...sourceDirs(home), ...otherRoots];
  for (const repo of repos) {
    if (expired() || files >= 2000) { incomplete = true; break; }
    if (lstatOrNull(path.join(repo, ".clean-development.json"))?.isFile()) walk(path.join(repo, "tools"));
  }
  return { hits, incomplete, files };
}

export function policyInventory(conf, env = process.env) {
  const home = homeDir(env);
  return {
    // Dot entries are the dot-folder report's; listing them here too doubled every warning.
    strayDev: entries(path.join(home, "dev")).filter((d) => !d.name.startsWith(".") && !conf.DEV_TOP_ALLOW.has(d.name)).map((d) => path.join(home, "dev", d.name)),
    staleHomeDots: [...conf.HOME_DOT_ALLOW].filter((name) => !lstatOrNull(path.join(home, name)))
  };
}

export function worktreeInventory(conf, env = process.env, { deadline = Date.now() + 5000 } = {}) {
  deadline = Math.min(deadline, Date.now() + 5000);
  const root = [path.join(externalWorkRoot(conf), "worktrees"), path.join(conf.externalRoot, "worktrees"), path.join(homeDir(env), "dev", "machine", "worktrees")];
  const worktrees = [], seen = new Set();
  let incomplete = false;
  for (const repo of sourceDirs(homeDir(env))) {
    if (!lstatOrNull(path.join(repo, ".git"))) continue;
    const left = deadline - Date.now();
    if (left <= 0) { incomplete = true; break; }
    const r = spawnSync("/usr/bin/git", ["-C", repo, "worktree", "list", "--porcelain", "-z"], {
      env: { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }, encoding: "utf8", timeout: Math.min(2000, left), killSignal: "SIGKILL", maxBuffer: 1024 ** 2
    });
    if (r.error || r.status !== 0) { incomplete = true; continue; }
    const paths = r.stdout.split("\0").filter((s) => s.startsWith("worktree ")).map((s) => s.slice(9));
    // Repos sharing one git dir list the same worktrees; report each path once, under the repo that owns the main tree.
    for (const p of paths.slice(1)) if (!root.some((r) => p === r || p.startsWith(r + path.sep)) && !seen.has(p)) { seen.add(p); worktrees.push({ repo: paths[0] || repo, path: p }); }
  }
  return { worktrees, incomplete };
}
