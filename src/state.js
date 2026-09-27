import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { OWNERSHIP_MARKER } from "./adapters.js";
import { acquireDirectoryLock, ensureRealDirectory, readJson, writeJsonAtomic } from "./io.js";
import { canonicalizePotentialPath, isPathInside } from "./platform.js";

function registryKey(workspaceId, buildRoot) {
  const digest = crypto.createHash("sha256").update(path.resolve(buildRoot)).digest("hex").slice(0, 8);
  return `${workspaceId}-${digest}`;
}

function stateCollection(config, name, { create = false } = {}) {
  const stateDir = config.locations.stateDir;
  if (!ensureRealDirectory(stateDir, { create, label: "State directory" })) return null;
  const directory = path.join(stateDir, name);
  if (!ensureRealDirectory(directory, { create, label: `State ${name} directory` })) return null;
  return directory;
}

function regularJsonFile(file) {
  try {
    const details = fs.lstatSync(file);
    return details.isFile() && !details.isSymbolicLink();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function readStateJson(file) {
  try {
    return readJson(file, null);
  } catch {
    // State is only evidence for ownership. A corrupt receipt must not make a
    // directory eligible for deletion or prevent inspection of other receipts.
    return null;
  }
}

function validWorkspaceRecord(value, file) {
  if (
    value?.schemaVersion !== 1
    || typeof value.workspaceId !== "string"
    || typeof value.workspace !== "string"
    || typeof value.ownershipId !== "string"
    || typeof value.buildRoot !== "string"
    || typeof value.path !== "string"
    || typeof value.lastUsedAt !== "string"
    || typeof value.pinned !== "boolean"
  ) return false;
  return path.basename(file) === `${registryKey(value.workspaceId, value.buildRoot)}.json`;
}

export function workspaceRecord(config, workspaceId, buildRoot = config.buildRoot) {
  const expectedDirectory = path.join(config.locations.stateDir, "workspaces");
  const file = path.join(expectedDirectory, `${registryKey(workspaceId, buildRoot)}.json`);
  const directory = stateCollection(config, "workspaces");
  if (!directory || !regularJsonFile(file)) return { file, value: null };
  const value = readStateJson(file);
  return { file, value: validWorkspaceRecord(value, file) ? value : null };
}

export function acquireWorkspaceLock(config, workspaceId, buildRoot = config.buildRoot) {
  const key = registryKey(workspaceId, buildRoot);
  const directory = stateCollection(config, "workspace-locks", { create: true });
  return acquireDirectoryLock(path.join(directory, `${key}.lock`));
}

function ownedBuildReasonUnchecked(config, value) {
  if (!value?.workspaceId || !value?.workspace || !value?.ownershipId || !value?.buildRoot || !value?.path) return "invalid-record";
  const configuredRoot = path.resolve(config.buildRoot);
  const recordedRoot = path.resolve(value.buildRoot);
  if (canonicalizePotentialPath(recordedRoot) !== canonicalizePotentialPath(configuredRoot)) return "different-build-root";
  const expected = path.join(configuredRoot, value.workspaceId);
  if (path.resolve(value.path) !== expected || !isPathInside(configuredRoot, value.path)) return "unsafe-path";
  if (path.dirname(path.resolve(value.path)) !== configuredRoot) return "unsafe-depth";
  if (!fs.existsSync(configuredRoot)) return "missing";
  const rootStat = fs.lstatSync(configuredRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || canonicalizePotentialPath(configuredRoot) !== configuredRoot) return "unsafe-build-root";
  if (!fs.existsSync(value.path)) return "missing";
  const targetStat = fs.lstatSync(value.path);
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink() || canonicalizePotentialPath(value.path) !== path.resolve(value.path)) return "unsafe-path";
  const markerFile = path.join(value.path, OWNERSHIP_MARKER);
  if (!fs.existsSync(markerFile)) return "unowned";
  const markerStat = fs.lstatSync(markerFile);
  if (!markerStat.isFile() || markerStat.isSymbolicLink()) return "unowned";
  const marker = readStateJson(markerFile);
  if (marker?.owner !== "clean-development" || marker?.ownershipId !== value.ownershipId || marker?.workspaceId !== value.workspaceId || marker?.workspace !== value.workspace) return "unowned";
  return null;
}

function ownedBuildReason(config, value) {
  try {
    return ownedBuildReasonUnchecked(config, value);
  } catch (error) {
    // An inspection race or permission failure is not evidence of ownership.
    return error.code === "ENOENT" ? "missing" : "unreadable";
  }
}

export function recordWorkspace(config, workspace, ownedBuild) {
  if (!ownedBuild?.path || !ownedBuild?.ownershipId) throw new Error("Cannot record a build directory without ownership proof");
  const workspaceBuildRoot = path.resolve(ownedBuild.path);
  const record = {
    schemaVersion: 1,
    workspaceId: workspace.id,
    workspace: workspace.root,
    ownershipId: ownedBuild.ownershipId,
    buildRoot: config.buildRoot,
    path: workspaceBuildRoot,
    lastUsedAt: new Date().toISOString(),
    pinned: false
  };
  const unsafe = ownedBuildReason(config, record);
  if (unsafe) throw new Error(`Cannot record build directory (${unsafe}): ${workspaceBuildRoot}`);
  const { file, value: previous } = workspaceRecord(config, workspace.id, config.buildRoot);
  if (previous?.pinned) record.pinned = true;
  stateCollection(config, "workspaces", { create: true });
  writeJsonAtomic(file, record);
  return { file, record };
}

export function createLease(config, workspace, tool) {
  const directory = stateCollection(config, "leases", { create: true });
  const file = path.join(directory, `${process.pid}-${workspace.id}-${crypto.randomUUID()}.json`);
  const startedAt = new Date().toISOString();
  let released = false;
  const write = (pid) => writeJsonAtomic(file, {
    schemaVersion: 1,
    pid,
    wrapperPid: process.pid,
    tool,
    workspaceId: workspace.id,
    workspace: workspace.root,
    startedAt
  });
  write(process.pid);
  return {
    updatePid(pid) {
      if (released || !Number.isInteger(pid) || pid <= 0) return;
      write(pid);
    },
    release() {
      released = true;
      try {
        fs.unlinkSync(file);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  };
}

const MAX_LEASE_BYTES = 64 * 1024;

function sameLeaseFile(left, right) {
  return right.isFile() && !right.isSymbolicLink()
    && left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

// Open only the regular file inspected by the caller, bound memory even if it
// grows after stat, and reject evidence replaced or rewritten during the read.
function readLease(file, before) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY
      | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!sameLeaseFile(before, opened) || opened.size > BigInt(MAX_LEASE_BYTES)) throw new Error("invalid lease file");
    const buffer = Buffer.alloc(MAX_LEASE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(descriptor, buffer, length, buffer.length - length, length);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_LEASE_BYTES || !sameLeaseFile(opened, fs.fstatSync(descriptor, { bigint: true }))
      || !sameLeaseFile(opened, fs.lstatSync(file, { bigint: true }))) throw new Error("lease changed during read");
    return JSON.parse(buffer.toString("utf8", 0, length));
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Only ESRCH proves the process absent. Permission and unexpected errors
    // must retain protection instead of interpreting uncertainty as idleness.
    return error.code !== "ESRCH";
  }
}

export function activeWorkspaceIds(config) {
  const directory = stateCollection(config, "leases");
  const active = new Set();
  if (!directory) return active;
  let names = [];
  try {
    names = fs.readdirSync(directory);
  } catch (error) {
    if (error.code === "ENOENT") return active;
    throw error;
  }
  for (const name of names) {
    const match = name.match(/^(\d+)-([a-z0-9-]+)-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/i);
    if (!match) continue;
    const file = path.join(directory, name);
    let stat;
    try {
      stat = fs.lstatSync(file, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink()) {
        active.add(match[2]);
        continue;
      }
    } catch (error) {
      if (error.code !== "ENOENT") active.add(match[2]);
      continue;
    }
    let lease;
    try {
      lease = readLease(file, stat);
    } catch {
      // A matching filename identifies the workspace even when a concurrent
      // write or filesystem fault makes its lease unreadable. Retain it rather
      // than risk pruning an active build.
      active.add(match[2]);
      continue;
    }
    const valid = lease?.schemaVersion === 1
      && lease.wrapperPid === Number(match[1])
      && Number.isSafeInteger(lease.wrapperPid) && lease.wrapperPid > 0
      && lease.workspaceId === match[2]
      && lease.tool === "cargo"
      && typeof lease.workspace === "string"
      && path.isAbsolute(lease.workspace)
      && typeof lease.startedAt === "string"
      && Number.isFinite(Date.parse(lease.startedAt))
      && Number.isSafeInteger(lease.pid)
      && lease.pid > 0;
    if (!valid) {
      // A matching lease that cannot establish it is stale must conservatively
      // protect its workspace from pruning.
      active.add(match[2]);
      continue;
    }
    if (processIsAlive(lease.pid)) active.add(lease.workspaceId);
    else {
      // A dead PID in an old inode is not proof that its replacement lease is
      // stale. Recheck after the process lookup before dropping protection.
      try {
        if (!sameLeaseFile(stat, fs.lstatSync(file, { bigint: true }))) active.add(match[2]);
      } catch { active.add(match[2]); }
    }
    // Inspection is strictly read-only, including stale leases. Deleting one
    // here could also race with the wrapper transferring it to its live child.
  }
  return active;
}

export function listWorkspaceRecords(config) {
  const directory = stateCollection(config, "workspaces");
  if (!directory) return [];
  let names = [];
  try {
    names = fs.readdirSync(directory).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return names.map((name) => {
    const file = path.join(directory, name);
    if (!regularJsonFile(file)) return null;
    const value = readStateJson(file);
    return validWorkspaceRecord(value, file) ? { file, value } : null;
  }).filter(Boolean);
}

export function prunePlan(config, { olderThanDays = config.retention.buildDays } = {}) {
  const days = Number(olderThanDays);
  if (!Number.isFinite(days) || days < 0) throw new Error(`Invalid retention age: ${olderThanDays}`);
  const active = activeWorkspaceIds(config);
  const threshold = Date.now() - days * 24 * 60 * 60 * 1000;
  return listWorkspaceRecords(config).map(({ file, value }) => {
    let reason = ownedBuildReason(config, value) || "eligible";
    if (reason === "eligible" && value.pinned) reason = "pinned";
    else if (reason === "eligible" && active.has(value.workspaceId)) reason = "active";
    else if (reason === "eligible" && !Number.isFinite(Date.parse(value.lastUsedAt))) reason = "invalid-record";
    else if (reason === "eligible" && Date.parse(value.lastUsedAt) >= threshold) reason = "recent";
    return { ...value, recordFile: file, pruneBefore: new Date(threshold).toISOString(), reason, eligible: reason === "eligible" };
  });
}

export async function applyPrune(config, plan) {
  const removed = [];
  for (const item of plan.filter((entry) => entry.eligible)) {
    const releaseLock = await acquireWorkspaceLock(config, item.workspaceId, item.buildRoot);
    try {
      if (!regularJsonFile(item.recordFile)) continue;
      const current = readStateJson(item.recordFile);
      const threshold = Date.parse(item.pruneBefore);
      if (!validWorkspaceRecord(current, item.recordFile) || !Number.isFinite(threshold)
        || current.ownershipId !== item.ownershipId || current.path !== item.path) continue;
      const active = activeWorkspaceIds(config);
      if (ownedBuildReason(config, current) || current.pinned || active.has(current.workspaceId)) continue;
      if (!Number.isFinite(Date.parse(current.lastUsedAt)) || Date.parse(current.lastUsedAt) >= threshold) continue;
      fs.rmSync(current.path, { recursive: true, force: false });
      fs.rmSync(item.recordFile, { force: true });
      removed.push(current.path);
    } finally {
      releaseLock();
    }
  }
  return removed;
}
