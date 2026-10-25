// clean-development 0.6.0: external volume detection (by name + mount + writable probe) and cache-root layout.
import fs from "node:fs";
import path from "node:path";
import { children, safeDirectory, sizeBytes } from "./fsutil.mjs";

// Strict check used by hooks: the mount point named /Volumes/<EXTERNAL_VOLUME> is a different device from its parent
// (a real mount, not a stale empty folder), and EXTERNAL_CACHE accepts a real file write (catches read-only mounts
// and macOS privacy denials that access(2) does not report).
// Test only: DEV_STORAGE_VOLUME_TEST=absent forces "absent"; =mounted (alias: present) skips the device comparison
// (same-device fixtures); the directory and write probes still apply.
export function detect(conf, env = process.env, { probe = true, create = true } = {}) {
  const out = { mode: "internal", root: conf.internalRoot, mounted: false, writable: false, reason: "" };
  if (!conf.valid) { out.reason = "storage.conf invalid"; return out; }
  if (env.DEV_STORAGE_VOLUME_TEST === "absent") { out.reason = "test: volume treated as absent"; return out; }
  const mp = conf.mountPoint;
  let mpStat;
  try { mpStat = fs.statSync(mp); } catch { out.reason = `${mp} not mounted`; return out; }
  if (env.DEV_STORAGE_VOLUME_TEST !== "mounted" && env.DEV_STORAGE_VOLUME_TEST !== "present") {
    try {
      const parent = fs.statSync(path.dirname(mp));
      if (parent.dev === mpStat.dev) { out.reason = `${mp} exists but is not a mount point`; return out; }
    } catch { out.reason = `${path.dirname(mp)} unreadable`; return out; }
  }
  out.mounted = true;
  if (!safeDirectory(mp, conf.externalCache)) { out.reason = "external cache has an unsafe redirected layout"; return out; }
  try {
    if (create) fs.mkdirSync(conf.externalCache, { recursive: true });
    if (!fs.statSync(conf.externalCache).isDirectory()) throw new Error("not a directory");
  } catch (e) { out.reason = `${conf.externalCache} unusable (${e.code || e.message})`; return out; }
  if (probe) {
    const f = path.join(conf.externalCache, `probe-${process.pid}-${Date.now()}.tmp`);
    try { fs.writeFileSync(f, "x"); fs.unlinkSync(f); } catch (e) {
      out.reason = `${conf.externalCache} not writable (${e.code || e.message})`; return out;
    }
  } else {
    try { fs.accessSync(conf.externalCache, fs.constants.W_OK | fs.constants.X_OK); } catch (e) {
      out.reason = `${conf.externalCache} not writable (${e.code})`; return out;
    }
  }
  out.writable = true;
  out.mode = "external";
  out.root = conf.externalCache;
  out.reason = `${conf.externalVolume} mounted and writable`;
  return out;
}

// Cheap check used for reaping: is the external cache present right now (no write)?
export function externalAvailable(conf, env = process.env) {
  return detect(conf, env, { probe: false, create: false }).mode === "external";
}

export function rootFor(conf, mode) { return mode === "external" ? conf.externalCache : conf.internalRoot; }

export function layout(root) {
  return {
    root,
    deps: path.join(root, "deps"),
    builds: path.join(root, "builds"),
    scratch: path.join(root, "scratch"),
    trash: path.join(root, "trash"),
    derivedData: path.join(root, "builds", "DerivedData")
  };
}

export function ensureLayout(root) {
  const l = layout(root);
  for (const d of [l.deps, l.builds, l.scratch, l.trash]) {
    if (!safeDirectory(root, d, { missingAnchor: true })) throw new Error(`unsafe cache layout: ${d}`);
  }
  for (const d of [l.deps, l.builds, l.scratch, l.trash]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return l;
}

// Top-level entries of a cache root that 0.6.0 does not manage (anything but deps/ builds/ scratch/ trash/ and probe files).
// They are outside the dependency cap and the pruning rules, so doctor and status report them with sizes.
export const MANAGED_TOP = new Set(["deps", "builds", "scratch", "trash"]);
export function rootExtras(root, { sizes = true, timeoutMs = 15000 } = {}) {
  return children(root).filter((d) => !MANAGED_TOP.has(d.name) && !/^probe-.*\.tmp$/.test(d.name) && d.name !== ".DS_Store")
    .map((d) => ({ name: d.name, path: path.join(root, d.name), bytes: sizes ? sizeBytes(path.join(root, d.name), timeoutMs) : null }));
}

export function freeBytes(p) {
  try { const s = fs.statfsSync(p); return Number(s.bavail) * Number(s.bsize); } catch { return null; }
}

export const GB = 1024 ** 3;
export const fmtGB = (b) => (b === null || b === undefined ? "unknown" : `${(b / GB).toFixed(b < 10 * GB ? 1 : 0)} GB`);
