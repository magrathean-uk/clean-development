// clean-development 0.6.0: per-project .clean-development.json (schema v2; v1 files are read and migrated).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { lastUsedMs, lstatOrNull, children } from "./fsutil.mjs";

export const CONFIG = ".clean-development.json";
export const SCHEMA_URL = "https://raw.githubusercontent.com/magrathean-uk/bolyki-dev/main/clean-development/schemas/project-config.schema.json";
const V1_KEYS = new Set(["$schema", "schemaVersion", "enabled", "root", "cacheRoot", "buildRoot", "scratchRoot", "swiftpmWorkspaceRoot", "retention", "tools"]);
const V2_KEYS = new Set(["$schema", "schemaVersion", "enabled", "heavy", "buildDirs", "depDirs", "notes"]);

const validRel = (p) => typeof p === "string" && p.length > 0 && p.length < 200 && !path.isAbsolute(p)
  && !p.split("/").includes("..") && !p.startsWith(".git") && !p.includes("\0");

export function validateV2(o) {
  const errors = [];
  if (!o || typeof o !== "object" || Array.isArray(o)) return ["top level must be an object"];
  for (const k of Object.keys(o)) if (!V2_KEYS.has(k)) errors.push(`unknown key ${k}`);
  if (o.schemaVersion !== 2) errors.push("schemaVersion must be 2");
  for (const k of ["enabled", "heavy"]) if (o[k] !== undefined && typeof o[k] !== "boolean") errors.push(`${k} must be a boolean`);
  for (const k of ["buildDirs", "depDirs"]) {
    if (o[k] === undefined) continue;
    if (!Array.isArray(o[k]) || o[k].length > 16 || !o[k].every(validRel)) errors.push(`${k} must be up to 16 relative paths without ..`);
  }
  if (o.notes !== undefined && (typeof o.notes !== "string" || o.notes.length > 500)) errors.push("notes must be a string up to 500 characters");
  return errors;
}

// Markers -> typical regenerable output. Only directories that git ignores are ever deleted (checked at deletion time).
export function detectDirs(root) {
  const has = (f) => lstatOrNull(path.join(root, f)) !== null;
  const buildDirs = [];
  const depDirs = [];
  if (has("Package.swift")) buildDirs.push(".build");
  if (has("Cargo.toml")) buildDirs.push("target");
  if (has("package.json")) { depDirs.push("node_modules"); for (const d of [".next", "dist", ".turbo"]) if (has(d)) buildDirs.push(d); }
  if (has("pyproject.toml") || has("requirements.txt")) { depDirs.push(".venv"); }
  if (has("Podfile")) depDirs.push("Pods");
  if (children(root).some((d) => d.name.endsWith(".xcodeproj") || d.name.endsWith(".xcworkspace")) && has("DerivedData")) buildDirs.push("DerivedData");
  return { buildDirs: [...new Set(buildDirs)], depDirs: [...new Set(depDirs)] };
}

export function migrateV1(o, root) {
  const d = root ? detectDirs(root) : { buildDirs: [], depDirs: [] };
  const out = { $schema: SCHEMA_URL, schemaVersion: 2, enabled: o?.enabled !== false };
  if (d.buildDirs.length) out.buildDirs = d.buildDirs;
  if (d.depDirs.length) out.depDirs = d.depDirs;
  const dropped = Object.keys(o || {}).filter((k) => !["$schema", "schemaVersion", "enabled"].includes(k));
  return { config: out, dropped };
}

export function loadProjectConfig(root) {
  if (!root) return null;
  const file = path.join(root, CONFIG);
  const st = lstatOrNull(file);
  if (!st) return null;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return { file, ok: false, errors: [`invalid JSON (${e.message})`] }; }
  if (raw?.schemaVersion === 1) {
    const unknown = Object.keys(raw).filter((k) => !V1_KEYS.has(k));
    const m = migrateV1(raw, root);
    return { file, ok: unknown.length === 0, version: 1, config: m.config, errors: unknown.map((k) => `unknown v1 key ${k}`), migrate: true };
  }
  const errors = validateV2(raw);
  return { file, ok: errors.length === 0, version: raw?.schemaVersion, config: errors.length ? null : raw, errors };
}

// Nearest ancestor of cwd (stopping at home) that holds .clean-development.json, else the git top level, else null.
export function findProjectRoot(cwd, home) {
  if (!cwd || !path.isAbsolute(cwd)) return null;
  let dir = path.resolve(cwd);
  while (true) {
    if (lstatOrNull(path.join(dir, CONFIG))) return dir;
    if (lstatOrNull(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir || dir === home) return null;
    dir = parent;
  }
}

export function isGitIgnored(root, rel) {
  const r = spawnSync("/usr/bin/git", ["-C", root, "check-ignore", "-q", "--", rel], { stdio: "ignore", timeout: 10000 });
  return r.status === 0;
}

function existingIgnored(root, rels) {
  const out = [];
  for (const rel of rels || []) {
    if (!validRel(rel)) continue;
    const p = path.join(root, rel);
    const st = lstatOrNull(p);
    if (!st || !st.isDirectory() || st.isSymbolicLink()) continue;
    if (isGitIgnored(root, rel)) out.push(p);
  }
  return out;
}

// Build directories a project declares (v2 buildDirs), existing and git-ignored.
export function projectBuildDirs(root) {
  if (!root) return [];
  const pc = loadProjectConfig(root);
  if (!pc?.config || pc.config.enabled === false) return [];
  return existingIgnored(root, pc.config.buildDirs);
}

// Activity of a repository: newest of git index/HEAD/FETCH_HEAD and its top-level entries.
export function repoLastUsedMs(root) {
  const marks = [lastUsedMs(root, 500)];
  for (const f of [".git/index", ".git/HEAD", ".git/FETCH_HEAD", ".git/logs/HEAD"]) marks.push(lstatOrNull(path.join(root, f))?.mtimeMs || 0);
  return Math.max(...marks);
}

// Declared build and dependency directories of a repository idle for longer than maxAgeMs.
export function projectAgedDirs(root, maxAgeMs, now = Date.now()) {
  const pc = loadProjectConfig(root);
  if (!pc?.config || pc.config.enabled === false) return [];
  if (now - repoLastUsedMs(root) <= maxAgeMs) return [];
  return existingIgnored(root, [...(pc.config.buildDirs || []), ...(pc.config.depDirs || [])]);
}

// Top-level repositories in ~/dev/source (tolerates dead symlinks such as SpecieX while the 4TB is away).
export function sourceRepos(home) {
  const src = path.join(home, "dev", "source");
  const repos = [];
  const dead = [];
  for (const d of children(src)) {
    const p = path.join(src, d.name);
    if (d.isSymbolicLink()) {
      let target = "";
      try { target = fs.readlinkSync(p); } catch { /* unreadable */ }
      try { fs.statSync(p); } catch { dead.push({ name: d.name, target }); continue; }
      continue; // live symlinks (4TB projects) are not scanned for pruning
    }
    if (d.isDirectory()) repos.push(p);
  }
  return { repos, dead };
}
