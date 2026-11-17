// clean-development 0.8.0: per-project .clean-development.json (schema v2; v1 files are read and migrated).
import fs from "node:fs";
import path from "node:path";
import { lstatOrNull, children } from "./fsutil.mjs";

export const CONFIG = ".clean-development.json";
export const SCHEMA_URL = "https://raw.githubusercontent.com/magrathean-uk/clean-development/main/schemas/project-config.schema.json";
const V1_KEYS = new Set(["$schema", "schemaVersion", "enabled", "root", "cacheRoot", "buildRoot", "scratchRoot", "swiftpmWorkspaceRoot", "retention", "tools"]);
const V2_KEYS = new Set(["$schema", "schemaVersion", "enabled", "heavy", "buildDirs", "depDirs", "notes"]);

const validRel = (p) => typeof p === "string" && p.length > 0 && p.length < 200 && !path.isAbsolute(p)
  && p.split("/").every((s) => s && s !== "." && s !== ".." && s !== ".git") && !/[\x00-\x1f\x7f]/.test(p);

export function validateV2(o) {
  const errors = [];
  if (!o || typeof o !== "object" || Array.isArray(o)) return ["top level must be an object"];
  for (const k of Object.keys(o)) if (!V2_KEYS.has(k)) errors.push(`unknown key ${k}`);
  if (o.schemaVersion !== 2) errors.push("schemaVersion must be 2");
  for (const k of ["enabled", "heavy"]) if (o[k] !== undefined && typeof o[k] !== "boolean") errors.push(`${k} must be a boolean`);
  for (const k of ["buildDirs", "depDirs"]) {
    if (o[k] === undefined) continue;
    if (!Array.isArray(o[k]) || o[k].length > 16 || !o[k].every(validRel) || new Set(o[k]).size !== o[k].length) errors.push(`${k} must be up to 16 unique relative paths without empty, . , .. or .git components`);
  }
  if (o.$schema !== undefined && (typeof o.$schema !== "string" || !o.$schema.length)) errors.push("$schema must be a non-empty string");
  if (o.notes !== undefined && (typeof o.notes !== "string" || o.notes.length > 500)) errors.push("notes must be a string up to 500 characters");
  return errors;
}

// Markers identify typical regenerable output for init.
// `has(name)` says whether root/name exists; `names()` lists root's entries. Detection is shared by init and the legacy config reader.
function dirsFrom(has, names) {
  const buildDirs = [];
  const depDirs = [];
  if (has("Package.swift")) buildDirs.push(".build");
  if (has("Cargo.toml")) buildDirs.push("target");
  if (has("package.json")) { depDirs.push("node_modules"); for (const d of [".next", "dist", ".turbo"]) if (has(d)) buildDirs.push(d); }
  if (has("pyproject.toml") || has("requirements.txt")) { depDirs.push(".venv"); }
  if (has("Podfile")) depDirs.push("Pods");
  if (names().some((n) => n.endsWith(".xcodeproj") || n.endsWith(".xcworkspace")) && has("DerivedData")) buildDirs.push("DerivedData");
  return { buildDirs: [...new Set(buildDirs)], depDirs: [...new Set(depDirs)] };
}
export function detectDirs(root) {
  return dirsFrom((f) => lstatOrNull(path.join(root, f)) !== null, () => children(root).map((d) => d.name));
}
export function migrateV1(o, root, detect = detectDirs) {
  const d = root ? detect(root) : { buildDirs: [], depDirs: [] };
  const out = { $schema: SCHEMA_URL, schemaVersion: 2, enabled: o?.enabled !== false };
  if (d.buildDirs.length) out.buildDirs = d.buildDirs;
  if (d.depDirs.length) out.depDirs = d.depDirs;
  const dropped = Object.keys(o || {}).filter((k) => !["$schema", "schemaVersion", "enabled"].includes(k));
  return { config: out, dropped };
}

// The meaning of a configuration file's text: v2 validated, v1 validated and migrated (its directories detected by
// `detect`), anything else invalid.
function interpretConfig(file, text, root, detect) {
  let raw;
  try { raw = JSON.parse(text); } catch (e) { return { file, ok: false, errors: [`invalid JSON (${e.message})`] }; }
  if (raw?.schemaVersion === 1) {
    const errors = Object.keys(raw).filter((k) => !V1_KEYS.has(k)).map((k) => `unknown v1 key ${k}`);
    if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") errors.push("enabled must be a boolean");
    if (raw.$schema !== undefined && (typeof raw.$schema !== "string" || !raw.$schema.length)) errors.push("$schema must be a non-empty string");
    const m = migrateV1(raw, root, detect);
    return { file, ok: errors.length === 0, version: 1, config: errors.length ? null : m.config, errors, migrate: true };
  }
  const errors = validateV2(raw);
  return { file, ok: errors.length === 0, version: raw?.schemaVersion, config: errors.length ? null : raw, errors };
}

export function loadProjectConfig(root) {
  if (!root) return null;
  const file = path.join(root, CONFIG);
  const st = lstatOrNull(file);
  if (!st) return null;
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { return { file, ok: false, errors: [`invalid JSON (${e.message})`] }; }
  return interpretConfig(file, text, root, detectDirs);
}
