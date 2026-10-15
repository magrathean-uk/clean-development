import fs from "node:fs";
import path from "node:path";

const MAX_OWNER_BYTES = 16 * 1024;
const MAX_OWNER_READ_BYTES = MAX_OWNER_BYTES + 1;

function sameIdentity(left, right) {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

function processState(pid) {
  try {
    process.kill(pid, 0);
    return "active";
  } catch (error) {
    if (error.code === "ESRCH") return "stale";
    if (error.code === "EPERM") return "active";
    return "uncertain";
  }
}

function inspectGuard(file) {
  let stat;
  try { stat = fs.lstatSync(file, { bigint: true }); }
  catch (error) {
    if (error.code === "ENOENT") return { present: false };
    return { present: false, error: error.message };
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return { present: true, valid: false, detail: "Removal guard is not a real directory" };
  let handle;
  try {
    const real = fs.realpathSync.native(file);
    handle = fs.opendirSync(file);
    const first = handle.readSync();
    handle.closeSync();
    handle = null;
    const current = fs.lstatSync(file, { bigint: true });
    if (real !== path.resolve(file) || !sameIdentity(stat, current)) return { present: true, valid: false, detail: "Removal guard changed during inspection" };
    if (first !== null) return { present: true, valid: false, detail: "Removal guard contains retained evidence" };
    return { present: true, valid: true, identity: stat };
  } catch (error) {
    return { present: true, valid: false, detail: `Removal guard could not be inspected: ${error.message}` };
  } finally {
    if (handle) { try { handle.closeSync(); } catch {} }
  }
}

function inspectOwner(directory) {
  let dirStat;
  try { dirStat = fs.lstatSync(directory, { bigint: true }); }
  catch (error) { return { status: "uncertain", detail: `Lock could not be inspected: ${error.message}` }; }
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return { status: "uncertain", detail: "Lock path is not a real directory" };
  try {
    if (fs.realpathSync.native(directory) !== path.resolve(directory)) return { status: "uncertain", detail: "Lock path is not canonical" };
    const ownerFile = path.join(directory, "owner.json");
    const before = fs.lstatSync(ownerFile, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(MAX_OWNER_BYTES)) {
      return { status: "uncertain", detail: "Lock owner record is not a bounded regular file" };
    }
    const fd = fs.openSync(ownerFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    let bytes;
    try {
      const opened = fs.fstatSync(fd, { bigint: true });
      if (!opened.isFile() || !sameIdentity(before, opened)) return { status: "uncertain", detail: "Lock owner record changed while opening" };
      const buffer = Buffer.alloc(MAX_OWNER_READ_BYTES);
      let count = 0;
      while (count < buffer.length) {
        const read = fs.readSync(fd, buffer, count, buffer.length - count, null);
        if (read === 0) break;
        count += read;
      }
      bytes = buffer.subarray(0, count);
      const afterFd = fs.fstatSync(fd, { bigint: true });
      const afterFile = fs.lstatSync(ownerFile, { bigint: true });
      if (bytes.length > MAX_OWNER_BYTES || !sameIdentity(opened, afterFd) || !sameIdentity(opened, afterFile)
        || opened.size !== afterFd.size || opened.mtimeNs !== afterFd.mtimeNs || opened.ctimeNs !== afterFd.ctimeNs
        || afterFd.ctimeNs !== afterFile.ctimeNs) {
        return { status: "uncertain", detail: "Lock owner record changed during inspection" };
      }
    } finally { fs.closeSync(fd); }
    const afterDir = fs.lstatSync(directory, { bigint: true });
    if (!sameIdentity(dirStat, afterDir)) return { status: "uncertain", detail: "Lock directory changed during inspection" };
    let owner;
    try { owner = JSON.parse(bytes.toString("utf8")); }
    catch { return { status: "uncertain", detail: "Lock owner record is malformed JSON" }; }
    if (owner?.schemaVersion !== 1 || typeof owner.token !== "string" || !owner.token.trim()
      || !Number.isInteger(owner.pid) || owner.pid <= 0 || owner.pid > 2_147_483_647
      || typeof owner.acquiredAt !== "string" || !Number.isFinite(Date.parse(owner.acquiredAt))) {
      return { status: "uncertain", detail: "Lock owner record is malformed" };
    }
    const state = processState(owner.pid);
    if (state === "active") return { status: "active", pid: owner.pid, detail: `Operation is active under PID ${owner.pid}` };
    if (state === "stale") return { status: "stale", pid: owner.pid, detail: `Owner PID ${owner.pid} is no longer running; inspect the retained lock before recovery` };
    return { status: "uncertain", pid: owner.pid, detail: `Could not determine whether owner PID ${owner.pid} is running` };
  } catch (error) {
    return { status: "uncertain", detail: `Lock state is inaccessible or uncertain: ${error.message}` };
  }
}

function inspectLock(stateDir, name) {
  const directory = path.join(stateDir, name);
  const guardFile = `${directory}.removal-guard`;
  const guard = inspectGuard(guardFile);
  if (guard.error) return { name, status: "uncertain", ok: false, detail: `Removal guard state is inaccessible: ${guard.error}` };
  let present = true;
  try { fs.lstatSync(directory); }
  catch (error) {
    if (error.code === "ENOENT") present = false;
    else return { name, status: "uncertain", ok: false, detail: `Lock state is inaccessible: ${error.message}` };
  }
  const lock = present ? inspectOwner(directory) : { status: "absent", detail: "No lifecycle lock is present" };
  if (guard.present && !guard.valid) return { name, status: "uncertain", ok: false, detail: guard.detail };
  if (guard.present && lock.status === "active") {
    return { name, status: "uncertain", ok: true, pid: lock.pid,
      detail: `A removal guard is present alongside a valid live lock held by PID ${lock.pid}; this can be a normal release in progress, and doctor left it unchanged` };
  }
  if (guard.present) {
    return { name, status: "uncertain", ok: false,
      detail: `${guardFile} is present without a verifiable live lock; it may be retained evidence or an interrupted removal. Inspect it; doctor did not change it.` };
  }
  if (lock.status === "active") return { name, ...lock, ok: true };
  if (lock.status === "absent") return { name, ...lock, ok: true };
  return { name, ...lock, ok: false };
}

/** Read-only view of setup/runtime locks and their sibling removal guards. */
export function inspectLifecycleLocks(stateDir) {
  let state;
  try {
    state = fs.lstatSync(stateDir, { bigint: true });
    if (!state.isDirectory() || state.isSymbolicLink() || fs.realpathSync.native(stateDir) !== path.resolve(stateDir)) {
      return ["setup.lock", "runtime.lock"].map((name) => ({ name, status: "uncertain", ok: false, detail: "State directory is not a canonical real directory" }));
    }
  } catch (error) {
    if (error.code === "ENOENT") return ["setup.lock", "runtime.lock"].map((name) => ({ name, status: "absent", ok: true, detail: "State directory is not initialized" }));
    return ["setup.lock", "runtime.lock"].map((name) => ({ name, status: "uncertain", ok: false, detail: `State directory is inaccessible: ${error.message}` }));
  }
  return ["setup.lock", "runtime.lock"].map((name) => inspectLock(stateDir, name));
}
