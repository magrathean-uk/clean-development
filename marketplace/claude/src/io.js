import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

function validateRealDirectory(directory, label) {
  const resolved = path.resolve(directory);
  const details = fs.lstatSync(resolved);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`${label} is not a real directory: ${resolved}`);
  }
  if (fs.realpathSync.native(resolved) !== resolved) {
    throw new Error(`${label} resolves through an unexpected symlink: ${resolved}`);
  }
}

export function ensureRealDirectory(directory, { create = false, label = "Directory" } = {}) {
  const resolved = path.resolve(directory);
  if (fs.existsSync(resolved)) {
    validateRealDirectory(resolved, label);
    return true;
  }

  const missing = [];
  let existing = resolved;
  while (!fs.existsSync(existing)) {
    missing.unshift(existing);
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  validateRealDirectory(existing, label);
  if (!create) return false;

  for (const target of missing) {
    try {
      fs.mkdirSync(target, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    validateRealDirectory(target, label);
  }
  return true;
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw new Error(`Cannot read ${file}: ${error.message}`);
  }
}

export function writeJsonAtomic(file, value) {
  writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sameIdentity(stat, identity) {
  return String(stat.dev) === String(identity.dev) && String(stat.ino) === String(identity.ino);
}

export function writeJsonExclusive(file, value, { expectedParent = null } = {}) {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  const parent = path.dirname(file);
  if (expectedParent) {
    const parentStat = fs.lstatSync(parent, { bigint: true });
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || !sameIdentity(parentStat, expectedParent)) {
      throw new Error(`Project directory changed after review: ${parent}`);
    }
  } else {
    fs.mkdirSync(parent, { recursive: true });
  }
  let descriptor;
  let createdIdentity;
  try {
    descriptor = fs.openSync(file, "wx", 0o600);
    createdIdentity = fs.fstatSync(descriptor, { bigint: true });
    fs.writeFileSync(descriptor, contents);
    fs.fsyncSync(descriptor);
    if (expectedParent) {
      const parentAfter = fs.lstatSync(parent, { bigint: true });
      const fileAfter = fs.lstatSync(file, { bigint: true });
      if (
        !parentAfter.isDirectory() || parentAfter.isSymbolicLink() || !sameIdentity(parentAfter, expectedParent)
        || !fileAfter.isFile() || fileAfter.isSymbolicLink() || !sameIdentity(fileAfter, createdIdentity)
      ) throw new Error(`Project directory changed while saving reviewed configuration: ${parent}`);
    }
  } catch (error) {
    if (createdIdentity) {
      try { fs.ftruncateSync(descriptor, 0); } catch {}
      try {
        const current = fs.lstatSync(file, { bigint: true });
        if (current.isFile() && !current.isSymbolicLink() && sameIdentity(current, createdIdentity)) fs.unlinkSync(file);
      } catch {}
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function writeTextAtomic(file, contents, { mode = 0o600 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let outputMode = mode;
  try {
    outputMode = fs.statSync(file).mode & 0o777;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, contents, { mode: outputMode });
  fs.chmodSync(temporary, outputMode);
  fs.renameSync(temporary, file);
}

function leafSymlinkReferent(file) {
  let current = path.resolve(file);
  const visited = new Set();
  while (true) {
    let details;
    try {
      details = fs.lstatSync(current);
    } catch (error) {
      if (error.code === "ENOENT") return current;
      throw error;
    }
    if (!details.isSymbolicLink()) return current;
    if (visited.has(current)) throw new Error(`Refusing cyclic JSON symlink: ${file}`);
    visited.add(current);
    const target = fs.readlinkSync(current);
    const physicalParent = fs.realpathSync(path.dirname(current));
    current = path.resolve(physicalParent, target);
  }
}

export function writeJsonAtomicFollowingLeafSymlink(file, value) {
  writeJsonAtomic(leafSymlinkReferent(file), value);
}

export function writeTextAtomicFollowingLeafSymlink(file, contents, options) {
  writeTextAtomic(leafSymlinkReferent(file), contents, options);
}

export function appendLine(file, line) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${line}\n`, "utf8");
}

export function directorySize(root) {
  let total = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile()) {
        try {
          total += fs.statSync(target).size;
        } catch {
          // A concurrent build may remove an entry between listing and stat.
        }
      }
    }
  }
  return total;
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function lockAgeMs(directory) {
  try {
    return Date.now() - fs.statSync(directory).mtimeMs;
  } catch {
    return 0;
  }
}

function removeLockDirectory(directory, expectedToken = null) {
  const ownerFile = path.join(directory, "owner.json");
  if (expectedToken) {
    const owner = readJson(ownerFile, null);
    if (owner?.token !== expectedToken) return false;
  }
  try {
    fs.unlinkSync(ownerFile);
  } catch (error) {
    if (error.code !== "ENOENT") return false;
  }
  try {
    fs.rmdirSync(directory);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    return false;
  }
}

export async function acquireDirectoryLock(directory, { timeoutMs = 30_000 } = {}) {
  const token = crypto.randomUUID();
  const started = Date.now();
  ensureRealDirectory(path.dirname(directory), { create: true, label: "Lock parent" });
  while (true) {
    try {
      fs.mkdirSync(directory);
      validateRealDirectory(directory, "Lock directory");
      writeJsonAtomic(path.join(directory, "owner.json"), {
        schemaVersion: 1,
        token,
        pid: process.pid,
        acquiredAt: new Date().toISOString()
      });
      return () => removeLockDirectory(directory, token);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }

    try {
      validateRealDirectory(directory, "Lock directory");
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }

    let owner = null;
    try {
      owner = readJson(path.join(directory, "owner.json"), null);
    } catch {
      // A crashed writer may have left an incomplete lock owner file.
    }
    const age = lockAgeMs(directory);
    const stale = owner ? (!processIsAlive(owner.pid) && age > 1_000) : age > 5_000;
    if (stale) {
      if (removeLockDirectory(directory, owner?.token || null)) continue;
    }
    if (Date.now() - started >= timeoutMs) throw new Error(`Timed out waiting for setup lock: ${directory}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export function acquireDirectoryLockSync(directory, { timeoutMs = 30_000 } = {}) {
  const token = crypto.randomUUID();
  const started = Date.now();
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  ensureRealDirectory(path.dirname(directory), { create: true, label: "Lock parent" });
  while (true) {
    try {
      fs.mkdirSync(directory);
      validateRealDirectory(directory, "Lock directory");
      writeJsonAtomic(path.join(directory, "owner.json"), {
        schemaVersion: 1,
        token,
        pid: process.pid,
        acquiredAt: new Date().toISOString()
      });
      return () => removeLockDirectory(directory, token);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }

    try {
      validateRealDirectory(directory, "Lock directory");
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }

    let owner = null;
    try {
      owner = readJson(path.join(directory, "owner.json"), null);
    } catch {
      // A crashed writer may have left an incomplete lock owner file.
    }
    const age = lockAgeMs(directory);
    const stale = owner ? (!processIsAlive(owner.pid) && age > 1_000) : age > 5_000;
    if (stale) {
      if (removeLockDirectory(directory, owner?.token || null)) continue;
    }
    if (Date.now() - started >= timeoutMs) throw new Error(`Timed out waiting for runtime lock: ${directory}`);
    Atomics.wait(waiter, 0, 0, 50);
  }
}
