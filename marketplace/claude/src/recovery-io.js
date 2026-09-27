import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const MAX_RECOVERY_BYTES = 2 * 1024 * 1024;
export const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
export const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const identity = (stat) => ({ dev: String(stat.dev), ino: String(stat.ino) });

export function directoryIdentity(directory) {
  const resolved = path.resolve(directory);
  try {
    const stat = fs.lstatSync(resolved, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(resolved) !== resolved) {
      throw new Error(`Recovery requires a canonical real directory: ${resolved}`);
    }
    return identity(stat);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    // Validate the nearest existing ancestor even for an absent leaf.
    const parent = path.dirname(resolved);
    if (parent !== resolved) directoryIdentity(parent);
    return null;
  }
}

export function observeFile(file, limit = MAX_RECOVERY_BYTES) {
  if (!directoryIdentity(path.dirname(file))) return { state: "absent" };
  let initial;
  try { initial = fs.lstatSync(file, { bigint: true }); }
  catch (error) { if (error.code === "ENOENT") return { state: "absent" }; throw error; }
  if (!initial.isFile() || initial.isSymbolicLink()) throw new Error(`Recovery retains non-regular file: ${file}`);
  if (initial.size > BigInt(limit)) throw new Error(`Recovery file exceeds ${limit} bytes: ${file}`);
  let fd;
  let failure;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !equal(identity(initial), identity(opened))) throw new Error(`Recovery file changed while opening: ${file}`);
    const buffer = Buffer.alloc(limit + 1);
    let count = 0;
    while (count < buffer.length) {
      const read = fs.readSync(fd, buffer, count, buffer.length - count, count);
      if (!read) break;
      count += read;
    }
    if (count > limit) throw new Error(`Recovery file exceeds ${limit} bytes: ${file}`);
    const after = fs.fstatSync(fd, { bigint: true });
    const current = fs.lstatSync(file, { bigint: true });
    if (!current.isFile() || current.isSymbolicLink() || !equal(identity(opened), identity(current))
      || opened.size !== after.size || opened.mtimeNs !== after.mtimeNs || opened.ctimeNs !== after.ctimeNs
      || after.ctimeNs !== current.ctimeNs) {
      throw new Error(`Recovery file changed while reading: ${file}`);
    }
    const bytes = Buffer.from(buffer.subarray(0, count));
    return { state: "file", ...identity(current), mode: Number(current.mode & 0o777n),
      size: count, sha256: digest(bytes), bytes };
  } catch (error) { failure = error; throw error; }
  finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); }
      catch (error) { if (!failure) throw error; failure.recoveryCloseError = error.message; }
    }
  }
}

export function fingerprint(observation) {
  const { bytes, ...result } = observation;
  return result;
}

export function requireDirectory(directory, expected) {
  const actual = directoryIdentity(directory);
  if (!actual || (expected && !equal(actual, expected))) throw new Error(`Recovery directory is missing or changed: ${directory}; restore the original location, then re-plan.`);
  return actual;
}

// Explicit repair only. No mkdir of a missing parent, truncation of a target,
// source/receipt-selected execution, or deletion of residual repair evidence.
export function publishRepair(file, bytes, { before, parent, mode = 0o600, assertHeld = () => {}, stagingDirectory, stagingParent }) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (bytes.length > MAX_RECOVERY_BYTES) throw new Error("Recovery publication exceeds the byte limit");
  const directory = path.dirname(file);
  stagingDirectory ||= directory;
  stagingParent ||= parent;
  const assertTarget = () => {
    assertHeld();
    requireDirectory(directory, parent);
    requireDirectory(stagingDirectory, stagingParent);
    if (!equal(fingerprint(observeFile(file)), before)) throw new Error(`Recovery candidate changed: ${file}; re-plan.`);
  };
  assertTarget();
  const stage = path.join(stagingDirectory, `.clean-development-recovery-${crypto.randomUUID()}.tmp`);
  let fd;
  let failure;
  try {
    fd = fs.openSync(stage, "wx", 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    const staged = observeFile(stage);
    if (staged.sha256 !== digest(bytes)) throw new Error(`Recovery staging verification failed: ${stage}`);
    assertTarget();
    if (before.state === "absent") {
      // link is atomic and fails with EEXIST; rename would overwrite a new,
      // unowned file appearing after the final absence check.
      fs.linkSync(stage, file);
    } else fs.renameSync(stage, file);
    assertHeld();
    requireDirectory(directory, parent);
    const published = observeFile(file);
    if (published.sha256 !== staged.sha256 || !equal(identity(published), identity(staged))) {
      throw new Error(`Recovery publication changed: ${file}`);
    }
    return { path: file, sha256: published.sha256, retainedStage: before.state === "absent" ? stage : null };
  } catch (error) {
    failure = error;
    // Preserve the initiating error object/code; never let failed cleanup mask it.
    error.recovery = { ...error.recovery, candidate: file, retainedStage: stage };
    throw error;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); }
      catch (error) { if (!failure) throw error; failure.recoveryCloseError = error.message; }
    }
  }
}

function lockSnapshot(directory) {
  const dir = directoryIdentity(directory);
  if (!dir) return null;
  const owner = observeFile(path.join(directory, "owner.json"), 16 * 1024);
  if (owner.state !== "file") throw new Error(`Recovery lock has no ownership record: ${directory}`);
  const value = JSON.parse(owner.bytes.toString("utf8"));
  if (value.schemaVersion !== 1 || typeof value.token !== "string" || !value.token
    || !Number.isInteger(value.pid) || value.pid <= 0 || typeof value.acquiredAt !== "string"
    || !Number.isFinite(Date.parse(value.acquiredAt))) throw new Error(`Recovery lock has invalid ownership: ${directory}`);
  return { dir, owner: fingerprint(owner), value };
}

function dead(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === "ESRCH"; }
}

// Compatible with setup/runtime locks, but unlike the general lock primitive
// this explicit recovery path never creates missing parents or removes an
// ownerless/invalid lock. Confirmed-dead lock directories are retained by rename.
async function acquireRecoveryLock(directory, parent, timeoutMs, retained) {
  const started = Date.now();
  let detail = "busy";
  while (true) {
    requireDirectory(path.dirname(directory), parent);
    let created = false;
    try { fs.mkdirSync(directory, { mode: 0o700 }); created = true; }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    if (created) {
      requireDirectory(path.dirname(directory), parent);
      const ownDir = requireDirectory(directory);
      const ownerPath = path.join(directory, "owner.json");
      const value = { schemaVersion: 1, token: crypto.randomUUID(), pid: process.pid, acquiredAt: new Date().toISOString() };
      // An interrupted owner publication is intentionally retained as ambiguous.
      fs.writeFileSync(ownerPath, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
      const own = lockSnapshot(directory);
      if (!equal(ownDir, own.dir) || own.value.token !== value.token) throw new Error(`Recovery lock changed during acquisition: ${directory}`);
      const assertHeld = () => {
        requireDirectory(path.dirname(directory), parent);
        if (!equal(lockSnapshot(directory), own)) throw new Error(`Recovery no longer owns lock: ${directory}`);
      };
      return {
        assertHeld,
        release() {
          try {
            assertHeld();
            fs.unlinkSync(ownerPath);
            fs.rmdirSync(directory);
          } catch (error) {
            retained.push({ path: directory, reason: `Lock retained: ${error.message}` });
          }
        }
      };
    }
    try {
      const snapshot = lockSnapshot(directory);
      if (!snapshot) continue;
      detail = `owned by PID ${snapshot.value.pid}`;
      if (dead(snapshot.value.pid)) {
        const saved = `${directory}.recovery-stale-${crypto.randomUUID()}`;
        requireDirectory(path.dirname(directory), parent);
        if (!equal(lockSnapshot(directory), snapshot) || !dead(snapshot.value.pid)) continue;
        fs.renameSync(directory, saved);
        retained.push({ path: saved, reason: "Confirmed-dead lock retained for inspection" });
        if (!equal(lockSnapshot(saved), snapshot)) {
          const error = new Error(`Lock identity changed while retaining ${saved}`);
          error.code = "ERECOVERYIDENTITY";
          throw error;
        }
        continue;
      }
    } catch (error) {
      if (error.code === "ENOENT") continue;
      if (error.code === "ERECOVERYIDENTITY") throw error;
      detail = error.message;
      // No owner or uncertain identity is never evidence of a stale lock.
    }
    if (Date.now() - started >= timeoutMs) {
      const error = new Error(`Recovery lock unavailable: ${directory} (${detail}). Wait for the active operation, or independently establish ownership before manual intervention; no uncertain lock was removed.`);
      error.code = "ERECOVERYLOCK";
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export async function acquireRecoveryLocks(stateDir, { timeoutMs = 30_000 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 30_000) throw new Error("Invalid recovery lock timeout");
  const parent = requireDirectory(stateDir);
  const locks = [];
  const retained = [];
  try {
    for (const name of ["setup.lock", "runtime.lock"]) locks.push(await acquireRecoveryLock(path.join(stateDir, name), parent, timeoutMs, retained));
  } catch (error) {
    for (const lock of locks.reverse()) lock.release();
    error.recovery = { ...error.recovery, retainedLocks: retained };
    throw error;
  }
  return {
    retained,
    assertHeld() { for (const lock of locks) lock.assertHeld(); },
    release() { for (const lock of [...locks].reverse()) lock.release(); }
  };
}
