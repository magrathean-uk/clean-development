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

const MAX_DIAGNOSTIC_WORKSPACE_ENTRIES = 4096;
const MAX_DIAGNOSTIC_WORKSPACE_RECORD_BYTES = 64 * 1024;

function readDiagnosticRecord(file) {
  let before;
  try { before = fs.lstatSync(file, { bigint: true }); }
  catch (error) { throw new Error(`Workspace record could not be inspected: ${error.code || "I/O error"}`); }
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("Workspace record is not a regular file");
  if (before.size > BigInt(MAX_DIAGNOSTIC_WORKSPACE_RECORD_BYTES)) throw new Error("Workspace record exceeds the 64 KiB diagnostic limit");
  let fd;
  let failure;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || String(opened.dev) !== String(before.dev) || String(opened.ino) !== String(before.ino)) {
      throw new Error("Workspace record changed while opening");
    }
    const buffer = Buffer.alloc(MAX_DIAGNOSTIC_WORKSPACE_RECORD_BYTES + 1);
    let count = 0;
    while (count < buffer.length) {
      const read = fs.readSync(fd, buffer, count, buffer.length - count, null);
      if (read === 0) break;
      count += read;
    }
    const afterFd = fs.fstatSync(fd, { bigint: true });
    const afterPath = fs.lstatSync(file, { bigint: true });
    if (count > MAX_DIAGNOSTIC_WORKSPACE_RECORD_BYTES) throw new Error("Workspace record exceeds the 64 KiB diagnostic limit");
    if (String(opened.dev) !== String(afterFd.dev) || String(opened.ino) !== String(afterFd.ino)
      || String(opened.dev) !== String(afterPath.dev) || String(opened.ino) !== String(afterPath.ino)
      || opened.size !== afterFd.size || opened.mtimeNs !== afterFd.mtimeNs || opened.ctimeNs !== afterFd.ctimeNs
      || afterFd.ctimeNs !== afterPath.ctimeNs || !afterPath.isFile() || afterPath.isSymbolicLink()) {
      throw new Error("Workspace record changed during inspection");
    }
    try { return JSON.parse(buffer.subarray(0, count).toString("utf8")); }
    catch { throw new Error("Workspace record JSON is malformed"); }
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); }
      catch { if (!failure) throw new Error("Workspace record could not be closed after inspection"); }
    }
  }
}

function sameDirectoryIdentity(stat, identity) {
  return String(stat.dev) === String(identity.dev) && String(stat.ino) === String(identity.ino);
}

function currentIdentity(config) {
  const directories = directoryIdentities(config.buildRoot);
  if (BigInt(directories.at(-1).ino) <= 0n) throw new Error(`Filesystem supplies no stable directory identity: ${config.buildRoot}`);
  const root = directories.at(-1);
  if (BigInt(root.birthtimeNs) <= 0n) throw new Error(`Filesystem supplies no usable stable directory birth time for managed storage: ${config.buildRoot}`);
  const identity = { path: root.path, dev: root.dev, ino: root.ino, birthtimeNs: root.birthtimeNs };
  return { buildRoot: path.resolve(config.buildRoot), identity, directories };
}

// Receipt creation is the only path allowed to probe timestamp stability. A
// unique empty child changes the root ctime; stable birthtime must remain fixed.
// Cleanup is an exact empty-directory rmdir, never recursive deletion.
function verifyStableBirthtime(config, snapshots) {
  const root = path.resolve(config.buildRoot);
  revalidateDirectoryIdentities(snapshots);
  const before = fs.lstatSync(root, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink() || before.birthtimeNs <= 0n) {
    throw new Error(`Filesystem supplies no usable stable directory birth time for managed storage: ${root}`);
  }
  const probe = path.join(root, `.clean-development-identity-probe-${process.pid}-${crypto.randomUUID()}`);
  let probeIdentity = null;
  let probeCreated = false;
  let primaryError = null;
  try {
    fs.mkdirSync(probe, { mode: 0o700 });
    probeCreated = true;
    const created = fs.lstatSync(probe, { bigint: true });
    if (!created.isDirectory() || created.isSymbolicLink()) throw new Error(`Storage identity probe is not a real directory: ${probe}`);
    probeIdentity = { dev: String(created.dev), ino: String(created.ino) };
    const after = fs.lstatSync(root, { bigint: true });
    if (!after.isDirectory() || after.isSymbolicLink() || !sameDirectoryIdentity(after, { dev: String(before.dev), ino: String(before.ino) })) {
      throw new Error(`Managed storage directory changed during identity probe: ${root}`);
    }
    if (after.birthtimeNs !== before.birthtimeNs || after.ctimeNs === before.ctimeNs) {
      throw new Error(`Filesystem does not provide a verifiably stable directory birth time for managed storage: ${root}`);
    }
  } catch (error) {
    primaryError = error;
  } finally {
    if (probeIdentity) {
      try {
        // ctime may be unusable for identity, but dev/inode plus real-directory
        // checks still ensure cleanup does not follow a replaced ancestor.
        for (const snapshot of snapshots) {
          const currentAncestor = fs.lstatSync(snapshot.path, { bigint: true });
          if (!currentAncestor.isDirectory() || currentAncestor.isSymbolicLink() || !sameDirectoryIdentity(currentAncestor, snapshot)) {
            throw new Error("ancestor-changed");
          }
        }
        const current = fs.lstatSync(probe, { bigint: true });
        if (!current.isDirectory() || current.isSymbolicLink() || !sameDirectoryIdentity(current, probeIdentity) || fs.readdirSync(probe).length !== 0) {
          throw new Error(`Storage identity probe changed; retained for inspection: ${probe}`);
        }
        fs.rmdirSync(probe);
      } catch (error) {
        const cleanupCode = typeof error.code === "string" && /^[A-Z0-9_-]{1,48}$/.test(error.code) ? error.code : "UNKNOWN";
        const cleanup = { code: cleanupCode, path: probe, retained: true };
        if (!primaryError) {
          primaryError = new Error(`Could not safely remove storage identity probe (${cleanupCode}): ${probe}`);
          primaryError.code = "CLEAN_DEVELOPMENT_STORAGE_PROBE_CLEANUP";
          primaryError.cleanup = cleanup;
        } else {
          primaryError.cleanup = cleanup;
          primaryError.message += `; probe cleanup uncertain (${cleanupCode}): ${probe}`;
        }
      }
    } else if (probeCreated) {
      // Without a captured inode, never remove this path: it may have been
      // replaced after creation. Preserve the original failure and identify
      // the private directory that must be inspected.
      const cleanup = { code: "IDENTITY_UNVERIFIED", path: probe, retained: true };
      if (!primaryError) {
        primaryError = new Error(`Storage identity probe could not be verified; retained for inspection: ${probe}`);
        primaryError.code = "CLEAN_DEVELOPMENT_STORAGE_PROBE_UNVERIFIED";
      } else {
        primaryError.cleanup = cleanup;
        primaryError.message += `; probe retained without verified identity: ${probe}`;
      }
    }
  }
  if (primaryError) throw primaryError;
  revalidateDirectoryIdentities(snapshots);
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
    || !/^\d+$/.test(value.identity?.dev ?? "") || !/^[1-9]\d*$/.test(value.identity?.ino ?? "") || !/^[1-9]\d*$/.test(value.identity?.birthtimeNs ?? "")
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

/** Read-only doctor view that also detects receipts missing from bound records. */
export function inspectManagedBuildRootIdentity(config) {
  try {
    const current = validateManagedBuildRoot(config);
    if (current) return { ok: true, status: "approved", detail: `Approved storage identity is present for ${config.buildRoot}` };
    const collection = path.join(config.locations.stateDir, "workspaces");
    let directory;
    try { directory = fs.lstatSync(collection, { bigint: true }); }
    catch (error) {
      if (error.code === "ENOENT") return { ok: true, status: "unbound", detail: "No global storage identity receipt or workspace records; legacy storage remains unbound" };
      return { ok: false, status: "uncertain", detail: `Workspace record collection is inaccessible: ${error.message}` };
    }
    if (!directory.isDirectory() || directory.isSymbolicLink() || fs.realpathSync.native(collection) !== path.resolve(collection)) {
      return { ok: false, status: "uncertain", detail: "Workspace record collection is not a canonical real directory" };
    }
    const bindings = [];
    let handle;
    try {
      handle = fs.opendirSync(collection);
      let entries = 0;
      let entry;
      while ((entry = handle.readSync()) !== null) {
        entries += 1;
        if (entries > MAX_DIAGNOSTIC_WORKSPACE_ENTRIES) {
          return { ok: false, status: "uncertain", detail: `Workspace record collection exceeds the ${MAX_DIAGNOSTIC_WORKSPACE_ENTRIES}-entry diagnostic limit` };
        }
        if (!entry.name.endsWith(".json")) continue;
        const file = path.join(collection, entry.name);
        try {
          const record = readDiagnosticRecord(file);
          if (record?.schemaVersion !== 1 || typeof record.workspaceId !== "string" || typeof record.workspace !== "string"
            || typeof record.ownershipId !== "string" || typeof record.buildRoot !== "string" || typeof record.path !== "string"
            || typeof record.lastUsedAt !== "string" || typeof record.pinned !== "boolean") {
            throw new Error("Workspace record is partial or invalid");
          }
          if (path.resolve(record.buildRoot) === path.resolve(config.buildRoot) && record.storageIdentity) bindings.push(file);
        } catch (error) {
          return { ok: false, status: "uncertain", detail: `Workspace record collection cannot be verified (${error.message}); inspect it before assuming storage is unbound` };
        }
      }
    } catch (error) {
      return { ok: false, status: "uncertain", detail: `Workspace record collection is inaccessible or uncertain: ${error.message}` };
    } finally {
      if (handle) { try { handle.closeSync(); } catch {} }
    }
    const afterDirectory = fs.lstatSync(collection, { bigint: true });
    if (String(directory.dev) !== String(afterDirectory.dev) || String(directory.ino) !== String(afterDirectory.ino)
      || directory.mtimeNs !== afterDirectory.mtimeNs || directory.ctimeNs !== afterDirectory.ctimeNs) {
      return { ok: false, status: "uncertain", detail: "Workspace record collection changed during inspection" };
    }
    if (bindings.length === 0) {
      return { ok: true, status: "unbound", detail: "No global storage identity receipt or identity-bound workspace records; legacy storage remains unbound" };
    }
    return { ok: false, status: "missing", detail: `Storage identity receipt is missing while ${bindings.length} workspace record(s) remain bound; inspect storage and run 'clean-development prepare' explicitly` };
  } catch (error) {
    return { ok: false, status: "invalid", detail: error.message };
  }
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
    verifyStableBirthtime(config, current.directories);
    revalidateDirectoryIdentities(current.directories);
    writeJsonAtomic(file, { schemaVersion: 1, owner: "clean-development", buildRoot: current.buildRoot,
      identity: current.identity, approvedAt: new Date().toISOString() }, { expectedDirectories: directoryIdentities(path.dirname(file)) });
    revalidateDirectoryIdentities(current.directories);
    return current;
  } finally { release(); }
}
