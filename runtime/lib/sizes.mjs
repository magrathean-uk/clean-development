// Size measurements are explicit or detached; readers never invoke du.
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { homeDir, stateDir } from "./conf.mjs";
import { detect, layout, rootExtras } from "./storage.mjs";
import { lstatOrNull, readJsonOrNull, safeDirectory, sizeBytes, writeFileAtomic } from "./fsutil.mjs";

const cachePath = (env) => path.join(stateDir(env), "sizes.json");
const record = (x) => !!x && typeof x === "object" && !Array.isArray(x);
const bytes = (x) => x === null || (Number.isFinite(x) && x >= 0);

export function readSizeCache(env = process.env) {
  if (!lstatOrNull(cachePath(env))?.isFile()) return null;
  const c = readJsonOrNull(cachePath(env));
  if (!record(c) || c.schemaVersion !== 1 || typeof c.measuredAt !== "string" || !Number.isFinite(Date.parse(c.measuredAt))
    || !Number.isFinite(c.durationMs) || c.durationMs < 0 || !record(c.roots) || !record(c.trash)) return null;
  for (const [root, row] of Object.entries(c.roots)) if (!path.isAbsolute(root) || !record(row) || !record(row.extras)
    || !["deps", "builds", "scratch", "trash"].every((k) => bytes(row[k])) || !Object.values(row.extras).every(bytes)) return null;
  if (!Object.entries(c.trash).every(([p, n]) => path.isAbsolute(p) && bytes(n))) return null;
  return c;
}

export function trashPaths(conf, env = process.env) {
  return [...new Set([path.join(homeDir(env), ".Trash"), path.join(conf.mountPoint || `/Volumes/${conf.externalVolume}`, ".Trashes", String(process.getuid?.() ?? 501)),
    ...[conf.internalRoot, conf.externalCache].map((r) => layout(r).trash)])];
}

export function refreshSizes(conf, env = process.env, { perPathTimeoutMs = 120000, deadlineMs = 900000 } = {}) {
  const start = Date.now(), deadline = start + Math.max(0, deadlineMs), measured = new Map();
  const measure = (p) => {
    if (!measured.has(p)) {
      const left = deadline - Date.now();
      measured.set(p, left > 0 ? sizeBytes(p, Math.max(1, Math.min(perPathTimeoutMs, left))) : null);
    }
    return measured.get(p);
  };
  const roots = {}, external = detect(conf, env, { probe: false, create: false }).mode === "external";
  for (const root of [conf.internalRoot, ...(external ? [conf.externalCache] : [])]) {
    const safe = safeDirectory(root, root, { missingAnchor: true });
    const l = layout(root), row = Object.fromEntries(["deps", "builds", "scratch", "trash"].map((k) => [k, safe && safeDirectory(root, l[k], { missingAnchor: true }) ? measure(l[k]) : null]));
    row.extras = Object.fromEntries((safe ? rootExtras(root, { sizes: false }) : []).map((e) => [e.name, measure(e.path)]));
    roots[root] = row;
  }
  const trash = Object.fromEntries(trashPaths(conf, env).map((p) => [p, measured.has(p) ? measured.get(p) : measure(p)]));
  const cache = { schemaVersion: 1, measuredAt: new Date(start).toISOString(), durationMs: Date.now() - start, roots, trash };
  writeFileAtomic(cachePath(env), JSON.stringify(cache, null, 1) + "\n");
  return cache;
}

export function spawnSizeRefresh(env = process.env) {
  try {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../bin/cd-sizes.mjs", import.meta.url))], { env, detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch { return false; }
}
