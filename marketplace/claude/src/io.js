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

// Metadata is not a stream. Bound both the declared size and bytes actually
// read, since a regular file can grow (or report a misleading size) after stat.
export const MAX_METADATA_BYTES = 1024 * 1024;

function validateMetadataFile(details, file) {
  if (!details.isFile()) throw new Error(`Metadata must be a regular file: ${file}`);
  if (details.size > MAX_METADATA_BYTES) throw new Error(`Metadata exceeds ${MAX_METADATA_BYTES} bytes: ${file}`);
}

export function readTextMetadata(file) {
  // Keep supported regular-file symlinks readable; ownership callers impose
  // their own stronger path checks. Reject known special files before opening.
  validateMetadataFile(fs.statSync(file), file);
  let descriptor;
  try {
    // On POSIX this prevents a FIFO substituted between stat and open from
    // waiting for a writer. Recheck the actual descriptor before reading it.
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
    validateMetadataFile(fs.fstatSync(descriptor), file);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const chunks = [];
    let total = 0;
    while (total <= MAX_METADATA_BYTES) {
      const size = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, MAX_METADATA_BYTES + 1 - total), null);
      if (size === 0) return Buffer.concat(chunks, total).toString("utf8");
      total += size;
      if (total > MAX_METADATA_BYTES) throw new Error(`Metadata exceeds ${MAX_METADATA_BYTES} bytes: ${file}`);
      chunks.push(Buffer.from(buffer.subarray(0, size)));
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function readJson(file, fallback = null) {
  try {
    const parsed = JSON.parse(readTextMetadata(file));
    // Valid JSON numeric syntax can overflow Number to Infinity. Rewriting
    // such a value with JSON.stringify would silently replace it with null.
    // Use an iterative walk: a reviver recurses through deeply nested input.
    const pending = [parsed];
    while (pending.length) {
      const value = pending.pop();
      if (typeof value === "number" && !Number.isFinite(value)) throw new Error("JSON contains a non-finite number");
      if (value && typeof value === "object") {
        for (const child of Object.values(value)) pending.push(child);
      }
    }
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    // V8 SyntaxError messages can quote secret-bearing file contents. Do not
    // retain the parser error as a cause, either; report the source, not bytes.
    const reason = error instanceof SyntaxError ? "Invalid JSON" : error.message;
    throw new Error(`Cannot read ${file}: ${reason}`);
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
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Only ESRCH proves absence; permission and other lookup errors retain the lock.
    return error.code !== "ESRCH";
  }
}

// A token alone is not authority to remove an arbitrary path. Bind ownership
// to the real directory and regular owner file that were actually inspected.
// Missing/malformed metadata is uncertain, not evidence of a crashed owner.
function readLockSnapshot(directory) {
  try {
    validateRealDirectory(directory, "Lock directory");
    const identity = fs.lstatSync(directory, { bigint: true });
    const ownerFile = path.join(directory, "owner.json");
    const ownerIdentity = fs.lstatSync(ownerFile, { bigint: true });
    if (!identity.isDirectory() || identity.isSymbolicLink() || !ownerIdentity.isFile() || ownerIdentity.isSymbolicLink()) return null;
    const contents = fs.readFileSync(ownerFile, "utf8");
    const owner = JSON.parse(contents);
    if (
      owner?.schemaVersion !== 1 || typeof owner.token !== "string" || !owner.token.trim()
      || !Number.isInteger(owner.pid) || owner.pid <= 0 || owner.pid > 2_147_483_647
      || typeof owner.acquiredAt !== "string" || !Number.isFinite(Date.parse(owner.acquiredAt))
      || !sameIdentity(fs.lstatSync(ownerFile, { bigint: true }), ownerIdentity)
      || !sameIdentity(fs.lstatSync(directory, { bigint: true }), identity)
    ) return null;
    return { identity, ownerIdentity, owner, contents };
  } catch {
    return null;
  }
}

function removeLockDirectory(directory, expected) {
  const current = readLockSnapshot(directory);
  if (
    !current || !expected || current.contents !== expected.contents
    || !sameIdentity(current.identity, expected.identity)
    || !sameIdentity(current.ownerIdentity, expected.ownerIdentity)
  ) return false;
  try {
    fs.unlinkSync(path.join(directory, "owner.json"));
  } catch {
    return false;
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
      const identity = fs.lstatSync(directory, { bigint: true });
      writeJsonAtomic(path.join(directory, "owner.json"), {
        schemaVersion: 1,
        token,
        pid: process.pid,
        acquiredAt: new Date().toISOString()
      });
      const owned = readLockSnapshot(directory);
      if (!owned || owned.owner.token !== token || !sameIdentity(owned.identity, identity)) {
        throw new Error(`Cannot verify ownership of lock directory: ${directory}`);
      }
      return () => removeLockDirectory(directory, owned);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }

    try {
      validateRealDirectory(directory, "Lock directory");
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }

    const observed = readLockSnapshot(directory);
    if (observed && !processIsAlive(observed.owner.pid) && Date.now() - Number(observed.identity.mtimeMs) > 1_000) {
      if (removeLockDirectory(directory, observed)) continue;
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
      const identity = fs.lstatSync(directory, { bigint: true });
      writeJsonAtomic(path.join(directory, "owner.json"), {
        schemaVersion: 1,
        token,
        pid: process.pid,
        acquiredAt: new Date().toISOString()
      });
      const owned = readLockSnapshot(directory);
      if (!owned || owned.owner.token !== token || !sameIdentity(owned.identity, identity)) {
        throw new Error(`Cannot verify ownership of lock directory: ${directory}`);
      }
      return () => removeLockDirectory(directory, owned);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }

    try {
      validateRealDirectory(directory, "Lock directory");
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }

    const observed = readLockSnapshot(directory);
    if (observed && !processIsAlive(observed.owner.pid) && Date.now() - Number(observed.identity.mtimeMs) > 1_000) {
      if (removeLockDirectory(directory, observed)) continue;
    }
    if (Date.now() - started >= timeoutMs) throw new Error(`Timed out waiting for runtime lock: ${directory}`);
    Atomics.wait(waiter, 0, 0, 50);
  }
}
