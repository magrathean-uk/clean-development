import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

export const DEFAULT_FOOTPRINT_LIMITS = Object.freeze({ maxEntries: 20000, maxDepth: 32, maxDurationMs: 2000 });
const HARD_LIMITS = { maxEntries: 200000, maxDepth: 128, maxDurationMs: 60000 };

function selectedRoots(roots) {
  if (!Array.isArray(roots) || !roots.length || roots.length > 32) throw new Error("Footprint observation requires 1 to 32 explicit roots");
  const names = new Set(), paths = new Set();
  return roots.map((root) => {
    if (!root || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(root.name || "") || typeof root.path !== "string" || !path.isAbsolute(root.path)) {
      throw new Error("Footprint roots require distinct names and absolute paths");
    }
    const resolved = path.resolve(root.path);
    if (resolved === path.parse(resolved).root || resolved === path.resolve(os.homedir())) throw new Error("Footprint observation refuses broad roots");
    if (names.has(root.name) || paths.has(resolved)) throw new Error("Footprint roots must be distinct");
    names.add(root.name); paths.add(resolved);
    return { name: root.name, path: resolved };
  });
}

function limitsFor(options) {
  const limits = { ...DEFAULT_FOOTPRINT_LIMITS, ...options };
  for (const [key, maximum] of Object.entries(HARD_LIMITS)) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > maximum) throw new Error(`Invalid footprint limit: ${key}`);
  }
  if (Object.keys(limits).some((key) => !Object.hasOwn(HARD_LIMITS, key))) throw new Error("Unknown footprint limit");
  return limits;
}

/** Inspect metadata only. No child command, content, or per-file names are recorded. */
export function snapshotFootprint(roots, { limits: requested = {} } = {}) {
  const selected = selectedRoots(roots), limits = limitsFor(requested), started = performance.now();
  let entriesVisited = 0;
  const observations = selected.map((root) => {
    const item = { ...root, exists: null, identity: null, entries: 0, files: 0, directories: 0,
      logicalBytes: 0, symlinks: 0, specialFiles: 0, skippedMounts: 0, complete: true, reasons: [] };
    const incomplete = (reason) => { item.complete = false; if (!item.reasons.includes(reason)) item.reasons.push(reason); };
    const available = () => {
      if (entriesVisited >= limits.maxEntries) { incomplete("entry-limit"); return false; }
      if (performance.now() - started >= limits.maxDurationMs) { incomplete("time-limit"); return false; }
      return true;
    };
    const details = (file) => {
      if (!available()) return null;
      entriesVisited += 1; item.entries += 1;
      try { return fs.lstatSync(file); }
      catch (error) { incomplete(error.code === "ENOENT" ? "changed-during-scan" : "unreadable"); return null; }
    };
    // Reject aliases in any existing ancestor before opening the selected root.
    // lstat inspects the link itself; no linked directory is enumerated.
    let ancestor = path.parse(root.path).root;
    for (const component of path.relative(ancestor, root.path).split(path.sep).filter(Boolean)) {
      if (!available()) return item;
      ancestor = path.join(ancestor, component);
      let stat;
      try { stat = fs.lstatSync(ancestor); }
      catch (error) {
        if (error.code === "ENOENT") { item.exists = false; return item; }
        incomplete("unreadable"); return item;
      }
      entriesVisited += 1;
      if (stat.isSymbolicLink()) { incomplete("symlink-boundary"); return item; }
      if (ancestor !== root.path && !stat.isDirectory()) { incomplete("non-directory-boundary"); return item; }
    }
    const initial = details(root.path);
    if (!initial) return item;
    item.exists = true; item.identity = { dev: String(initial.dev), ino: String(initial.ino) };
    const visit = (file, stat, depth) => {
      if (stat.isSymbolicLink()) { item.symlinks += 1; incomplete("symlink-skipped"); return; }
      if (stat.dev !== initial.dev) { item.skippedMounts += 1; incomplete("mount-skipped"); return; }
      if (stat.isFile()) {
        item.files += 1; item.logicalBytes += stat.size;
        if (!Number.isSafeInteger(item.logicalBytes)) incomplete("byte-overflow");
        return;
      }
      if (!stat.isDirectory()) { item.specialFiles += 1; incomplete("special-file-skipped"); return; }
      item.directories += 1;
      if (depth >= limits.maxDepth) { incomplete("depth-limit"); return; }
      let directory;
      try {
        directory = fs.opendirSync(file);
        const sameDirectory = () => {
          const current = fs.lstatSync(file);
          if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino) {
            incomplete("changed-during-scan"); return false;
          }
          return true;
        };
        if (!sameDirectory()) return;
        let entry;
        while (available() && (entry = directory.readSync())) {
          if (!sameDirectory()) break;
          const target = path.join(file, entry.name), child = details(target);
          if (child) visit(target, child, depth + 1);
        }
      } catch { incomplete("unreadable"); }
      finally { if (directory) { try { directory.closeSync(); } catch { incomplete("unreadable"); } } }
    };
    visit(root.path, initial, 0);
    try {
      const current = fs.lstatSync(root.path);
      if (current.isSymbolicLink() || current.dev !== initial.dev || current.ino !== initial.ino || current.mtimeMs !== initial.mtimeMs) {
        incomplete("changed-during-scan");
      }
    } catch { incomplete("changed-during-scan"); }
    return item;
  });
  return { schemaVersion: 1, kind: "selected-root-footprint", limits, entriesVisited,
    durationMs: Math.round(performance.now() - started), complete: observations.every((item) => item.complete),
    roots: observations, scope: "selected roots, aggregate metadata, no contents; bounded non-atomic observation" };
}

/** A partial observation has an unknown clean result, never a clean certificate. */
export function compareFootprints(before, after) {
  if (before?.kind !== "selected-root-footprint" || after?.kind !== before.kind) throw new Error("Footprint comparison requires observations");
  const previous = new Map(before.roots.map((root) => [root.name, root]));
  if (previous.size !== after.roots.length || after.roots.some((root) => previous.get(root.name)?.path !== root.path)) {
    throw new Error("Footprint comparison requires the same selected roots");
  }
  const deltas = after.roots.map((root) => {
    const prior = previous.get(root.name);
    const delta = { name: root.name, path: root.path, complete: prior.complete && root.complete,
      existenceChanged: prior.exists !== root.exists, identityChanged: JSON.stringify(prior.identity) !== JSON.stringify(root.identity),
      files: root.files - prior.files, directories: root.directories - prior.directories,
      logicalBytes: root.logicalBytes - prior.logicalBytes, symlinks: root.symlinks - prior.symlinks,
      specialFiles: root.specialFiles - prior.specialFiles };
    delta.changed = delta.existenceChanged || delta.identityChanged || [delta.files, delta.directories, delta.logicalBytes, delta.symlinks, delta.specialFiles].some((value) => value !== 0);
    return delta;
  });
  const complete = before.complete && after.complete && deltas.every((delta) => delta.complete);
  return { complete, changed: deltas.some((delta) => delta.changed), clean: complete ? !deltas.some((delta) => delta.changed) : null, deltas };
}
