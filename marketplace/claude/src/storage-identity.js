import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { acquireDirectoryLockSync, directoryIdentities, ensureRealDirectory, readJson, revalidateDirectoryIdentities, writeJsonAtomic } from "./io.js";
import { isPathInside } from "./platform.js";
import { activeWorkspaceIds, listWorkspaceRecords } from "./state.js";

function receiptPath(config) {
  const state = path.resolve(config.locations.stateDir);
  for (const root of [config.root, config.cacheRoot, config.buildRoot, config.scratchRoot].filter(Boolean)) {
    if (state === path.resolve(root) || isPathInside(root, state)) {
      throw new Error(`Storage identity state must be outside managed storage: ${state}`);
    }
  }
  const key = crypto.createHash("sha256").update(path.resolve(config.buildRoot)).digest("hex");
  return path.join(state, "storage-identities", `${key}.json`);
}

function currentIdentity(config) {
  const directories = directoryIdentities(config.buildRoot);
  if (BigInt(directories.at(-1).ino) <= 0n) throw new Error(`Filesystem supplies no stable directory identity: ${config.buildRoot}`);
  return { buildRoot: path.resolve(config.buildRoot), identity: directories.at(-1), directories };
}

export function sameStorageIdentity(left, right) {
  return left?.dev === right.dev && left?.ino === right.ino && left?.birthtimeNs === right.birthtimeNs;
}

function readReceipt(config) {
  const file = receiptPath(config);
  if (!ensureRealDirectory(config.locations.stateDir, { label: "State directory" })
    || !ensureRealDirectory(path.dirname(file), { label: "Storage identity state directory" })) return { file, value: null };
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (error.code === "ENOENT") return { file, value: null }; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Invalid storage identity receipt: ${file}`);
  const value = readJson(file);
  if (value?.schemaVersion !== 1 || value?.owner !== "clean-development" || value.buildRoot !== path.resolve(config.buildRoot)
    || value.identity?.path !== path.resolve(config.buildRoot)
    || !/^\d+$/.test(value.identity?.dev ?? "") || !/^[1-9]\d*$/.test(value.identity?.ino ?? "") || !/^\d+$/.test(value.identity?.birthtimeNs ?? "")
    || typeof value.approvedAt !== "string" || !Number.isFinite(Date.parse(value.approvedAt))) {
    throw new Error(`Invalid storage identity receipt: ${file}`);
  }
  return { file, value };
}

function changedRoot(config) {
  return Object.assign(new Error(`Managed build root identity changed: ${config.buildRoot}. Review the mounted storage and run 'clean-development prepare' or setup explicitly before building.`), { code: "CLEAN_DEVELOPMENT_STORAGE_CHANGED" });
}

// Read-only inspection. A missing receipt remains compatible with legacy
// installations; dispatch binds it only after existing ownership is validated.
export function validateManagedBuildRoot(config) {
  const { value } = readReceipt(config);
  if (!value) return null;
  const current = currentIdentity(config);
  if (!sameStorageIdentity(value.identity, current.identity)) throw changedRoot(config);
  return current;
}

export function ensureManagedBuildRootIdentity(config, { legacyValidated = false } = {}) {
  return approveManagedBuildRoot(config, { legacyValidated });
}

// Only explicit prepare/setup supplies reapprove. Session-only preparation and
// ordinary command dispatch can establish first use, never replace a receipt.
export function approveManagedBuildRoot(config, { reapprove = false, legacyValidated = false } = {}) {
  const file = receiptPath(config);
  ensureRealDirectory(config.locations.stateDir, { create: true, label: "State directory" });
  ensureRealDirectory(path.dirname(file), { create: true, label: "Storage identity state directory" });
  const release = acquireDirectoryLockSync(`${file}.lock`);
  try {
    const { value } = readReceipt(config);
    const current = currentIdentity(config);
    if (value && sameStorageIdentity(value.identity, current.identity)) return current;
    if (value && !reapprove) throw changedRoot(config);
    if (!value && !reapprove && !legacyValidated
      && listWorkspaceRecords(config).some(({ value: record }) => path.resolve(record.buildRoot) === current.buildRoot)) {
      throw new Error(`Managed build root needs explicit preparation or a matching legacy ownership receipt: ${config.buildRoot}`);
    }
    if (reapprove && activeWorkspaceIds(config).size > 0) {
      throw new Error(`Cannot approve changed storage while Cargo leases are active or uncertain: ${config.buildRoot}`);
    }
    revalidateDirectoryIdentities(current.directories);
    writeJsonAtomic(file, { schemaVersion: 1, owner: "clean-development", buildRoot: current.buildRoot,
      identity: current.identity, approvedAt: new Date().toISOString() }, { expectedDirectories: directoryIdentities(path.dirname(file)) });
    revalidateDirectoryIdentities(current.directories);
    return current;
  } finally { release(); }
}
