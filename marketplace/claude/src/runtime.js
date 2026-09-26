import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { environmentForTool, OWNERSHIP_MARKER } from "./adapters.js";
import { resolveConfig } from "./config.js";
import { SHIM_TOOLS, SUPPORTED_AGENTS, VERSION } from "./constants.js";
import { acquireDirectoryLockSync, ensureRealDirectory, readJson, writeJsonAtomic } from "./io.js";
import { canonicalizePotentialPath, environmentValue, isPathInside, prependUniquePath, setEnvironmentValue } from "./platform.js";
import { environmentWithoutSessionRouting, normalizeSessionMode, SESSION_MODE_ENV } from "./session.js";
import { acquireWorkspaceLock, createLease, listWorkspaceRecords, recordWorkspace, workspaceRecord } from "./state.js";
import { identifyWorkspace } from "./workspace.js";

const RUNTIME_MARKER = ".clean-development-runtime.json";
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function packageRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function quoteSh(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function fileHash(file) {
  return sha256(fs.readFileSync(file));
}

function copyRuntime(source, destination, installationId) {
  const temporary = `${destination}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.mkdirSync(temporary);
  for (const entry of ["bin", "src", "package.json"]) {
    fs.cpSync(path.join(source, entry), path.join(temporary, entry), { recursive: true });
  }
  writeJsonAtomic(path.join(temporary, RUNTIME_MARKER), {
    schemaVersion: 1,
    owner: "clean-development",
    version: VERSION,
    installationId,
    createdAt: new Date().toISOString()
  });
  try {
    fs.renameSync(temporary, destination);
    return true;
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
    return false;
  }
}

function walkFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Refusing symlink in owned runtime: ${target}`);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile()) files.push(target);
      else throw new Error(`Refusing special file in owned runtime: ${target}`);
    }
  }
  return files.sort();
}

function runtimeInventory(source, versionRoot) {
  const records = [];
  for (const entry of ["bin", "src", "package.json"]) {
    const sourcePath = path.join(source, entry);
    const sourceFiles = fs.statSync(sourcePath).isDirectory() ? walkFiles(sourcePath) : [sourcePath];
    for (const file of sourceFiles) {
      const relative = path.relative(source, file);
      const installed = path.join(versionRoot, relative);
      if (!fs.existsSync(installed) || fs.lstatSync(installed).isSymbolicLink() || fileHash(installed) !== fileHash(file)) {
        throw new Error(`Installed runtime does not match package content: ${installed}`);
      }
      records.push({ path: installed, sha256: fileHash(installed) });
    }
  }
  const marker = path.join(versionRoot, RUNTIME_MARKER);
  records.push({ path: marker, sha256: fileHash(marker) });
  return records;
}

function validInventoryRecord(record) {
  return record
    && typeof record.path === "string"
    && path.isAbsolute(record.path)
    && typeof record.sha256 === "string"
    && /^[0-9a-f]{64}$/i.test(record.sha256);
}

function sourceRuntimeRecords(source, versionRoot) {
  const records = [];
  for (const entry of ["bin", "src", "package.json"]) {
    const sourcePath = path.join(source, entry);
    const sourceFiles = fs.statSync(sourcePath).isDirectory() ? walkFiles(sourcePath) : [sourcePath];
    for (const file of sourceFiles) {
      records.push({ path: path.join(versionRoot, path.relative(source, file)), sha256: fileHash(file) });
    }
  }
  return records;
}

function runtimeReceipt(config) {
  const file = path.join(config.locations.stateDir, "runtime.json");
  if (!fs.existsSync(file)) return null;
  ensureRealDirectory(config.locations.stateDir, { label: "State directory" });
  const details = fs.lstatSync(file);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error(`Runtime receipt is not a real file: ${file}`);
  const receipt = readJson(file, null);
  if (
    receipt?.schemaVersion !== 2
    || typeof receipt.version !== "string"
    || !SEMVER.test(receipt.version)
    || !["installed", "uninstalled"].includes(receipt.status)
    || typeof receipt.installationId !== "string"
    || !receipt.installationId
    || typeof receipt.versionRoot !== "string"
    || typeof receipt.binDir !== "string"
    || typeof receipt.node !== "string"
    || !path.isAbsolute(receipt.node)
    || typeof receipt.source !== "string"
    || !path.isAbsolute(receipt.source)
    || typeof receipt.binDirectoryCreated !== "boolean"
    || !Array.isArray(receipt.ownedFiles)
    || !Array.isArray(receipt.runtimeFiles)
    || !receipt.ownedFiles.every(validInventoryRecord)
    || !receipt.runtimeFiles.every(validInventoryRecord)
  ) throw new Error(`Invalid runtime receipt: ${file}`);

  const versionRoot = path.resolve(config.locations.runtimeDir, receipt.version);
  if (
    !isPathInside(config.locations.runtimeDir, versionRoot)
    || path.resolve(receipt.versionRoot) !== versionRoot
    || path.resolve(receipt.binDir) !== path.resolve(config.locations.binDir)
  ) {
    throw new Error(`Runtime receipt paths do not match this installation: ${file}`);
  }
  const ownedPaths = receipt.ownedFiles.map((entry) => path.resolve(entry.path));
  const runtimePaths = receipt.runtimeFiles.map((entry) => path.resolve(entry.path));
  if (new Set(ownedPaths).size !== ownedPaths.length || new Set(runtimePaths).size !== runtimePaths.length) {
    throw new Error(`Runtime receipt contains duplicate inventory entries: ${file}`);
  }
  const allowedLaunchers = new Set(launcherSpecifications(versionRoot, config.locations.binDir).specifications.map((entry) => path.resolve(entry.path)));
  if (ownedPaths.some((entry) => !allowedLaunchers.has(entry))) {
    throw new Error(`Runtime receipt contains an unknown launcher path: ${file}`);
  }
  const markerPath = path.join(versionRoot, RUNTIME_MARKER);
  if (!runtimePaths.includes(markerPath) || runtimePaths.some((entry) => entry !== markerPath && !isPathInside(versionRoot, entry))) {
    throw new Error(`Runtime receipt contains an unsafe runtime inventory: ${file}`);
  }

  if (receipt.version === VERSION) {
    const expectedLaunchers = launcherSpecifications(versionRoot, config.locations.binDir, receipt.node).specifications;
    const expectedLauncherMap = new Map(expectedLaunchers.map((entry) => [path.resolve(entry.path), entry.sha256]));
    if (receipt.ownedFiles.length !== expectedLauncherMap.size || receipt.ownedFiles.some((entry) => expectedLauncherMap.get(path.resolve(entry.path)) !== entry.sha256)) {
      throw new Error(`Runtime receipt launcher inventory does not match ${VERSION}: ${file}`);
    }
    const expectedRuntime = sourceRuntimeRecords(packageRoot(), versionRoot);
    const expectedRuntimeMap = new Map(expectedRuntime.map((entry) => [path.resolve(entry.path), entry.sha256]));
    const nonMarker = receipt.runtimeFiles.filter((entry) => path.resolve(entry.path) !== markerPath);
    if (nonMarker.length !== expectedRuntimeMap.size || nonMarker.some((entry) => expectedRuntimeMap.get(path.resolve(entry.path)) !== entry.sha256)) {
      throw new Error(`Runtime receipt file inventory does not match ${VERSION}: ${file}`);
    }
  }
  return receipt;
}

function validateRuntimeRoot(versionRoot, installationId = null, expectedVersion = VERSION) {
  if (!fs.existsSync(versionRoot)) throw new Error(`Runtime is missing: ${versionRoot}`);
  const stat = fs.lstatSync(versionRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(versionRoot) !== path.resolve(versionRoot)) {
    throw new Error(`Runtime is not a real directory: ${versionRoot}`);
  }
  const markerFile = path.join(versionRoot, RUNTIME_MARKER);
  if (!fs.existsSync(markerFile) || fs.lstatSync(markerFile).isSymbolicLink()) throw new Error(`Refusing unowned runtime directory: ${versionRoot}`);
  const marker = readJson(markerFile, null);
  if (marker?.owner !== "clean-development" || marker?.version !== expectedVersion || !marker?.installationId) {
    throw new Error(`Refusing unowned runtime directory: ${versionRoot}`);
  }
  if (installationId && marker.installationId !== installationId) throw new Error(`Runtime ownership receipt does not match: ${versionRoot}`);
  return marker;
}

function archiveRuntimeReceipt(config, receipt) {
  if (!receipt?.version || !receipt?.installationId || receipt.version === VERSION) return null;
  const safeVersion = String(receipt.version).replace(/[^A-Za-z0-9._-]/g, "-");
  const safeId = String(receipt.installationId).replace(/[^A-Za-z0-9._-]/g, "-");
  const directory = path.join(config.locations.stateDir, "runtime-receipts");
  ensureRealDirectory(directory, { create: true, label: "Runtime receipt directory" });
  const file = path.join(directory, `${safeVersion}-${safeId}.json`);
  writeJsonAtomic(file, receipt);
  return file;
}

function archivedReceiptName(receipt) {
  const safeVersion = String(receipt.version).replace(/[^A-Za-z0-9._-]/g, "-");
  const safeId = String(receipt.installationId).replace(/[^A-Za-z0-9._-]/g, "-");
  return `${safeVersion}-${safeId}.json`;
}

function readArchivedRuntimeReceipt(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  const receipt = readJson(file, null);
  const validFiles = Array.isArray(receipt?.runtimeFiles) && receipt.runtimeFiles.every((entry) => (
    entry
    && typeof entry.path === "string"
    && path.isAbsolute(entry.path)
    && typeof entry.sha256 === "string"
    && /^[0-9a-f]{64}$/i.test(entry.sha256)
  ));
  if (
    receipt?.schemaVersion !== 2
    || typeof receipt.version !== "string"
    || !receipt.version
    || typeof receipt.installationId !== "string"
    || !receipt.installationId
    || typeof receipt.versionRoot !== "string"
    || !path.isAbsolute(receipt.versionRoot)
    || !validFiles
    || path.basename(file) !== archivedReceiptName(receipt)
  ) return null;
  return receipt;
}

function runtimeReceiptDirectory(config, { create = false } = {}) {
  const directory = path.join(config.locations.stateDir, "runtime-receipts");
  return ensureRealDirectory(directory, { create, label: "Runtime receipt directory" }) ? directory : null;
}

function verifyInventory(records, versionRoot) {
  for (const record of records) {
    const file = path.resolve(record.path);
    if (!isPathInside(versionRoot, file) || !fs.existsSync(file)) throw new Error(`Owned runtime file is missing or unsafe: ${file}`);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || fileHash(file) !== record.sha256) {
      throw new Error(`Owned runtime file was modified: ${file}`);
    }
  }
}

function writeExecutable(file, contents) {
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, contents, { mode: 0o755 });
  fs.chmodSync(temporary, 0o755);
  fs.renameSync(temporary, file);
}

function launcherSpecifications(versionRoot, binDir, node = process.execPath) {
  const cli = path.join(versionRoot, "bin", "clean-development.js");
  const shim = path.join(versionRoot, "bin", "clean-development-shim.js");
  const specifications = [];
  const add = (name, contents) => specifications.push({ path: path.join(binDir, name), contents, sha256: sha256(contents) });
  if (process.platform === "win32") {
    add("clean-development.cmd", `@echo off\r\n"${node}" "${cli}" %*\r\n`);
    for (const tool of SHIM_TOOLS) add(`${tool}.cmd`, `@echo off\r\n"${node}" "${shim}" ${tool} %*\r\n`);
  } else {
    add("clean-development", `#!/bin/sh\nexec ${quoteSh(node)} ${quoteSh(cli)} "$@"\n`);
    add("clean-development-shell-env", [
      "#!/bin/sh",
      `if [ -z "\${${SESSION_MODE_ENV}+x}" ]; then`,
      `  ${SESSION_MODE_ENV}=skip`,
      `  export ${SESSION_MODE_ENV}`,
      "fi",
      `_clean_development_bin=${quoteSh(binDir)}`,
      'case "${PATH:-}" in',
      '  "${_clean_development_bin}"|"${_clean_development_bin}:"*) ;;',
      '  *) PATH="${_clean_development_bin}${PATH:+:${PATH}}" ;;',
      "esac",
      "export PATH",
      `if [ "\${${SESSION_MODE_ENV}}" = "skip" ]; then`,
      "  unset CLEAN_DEVELOPMENT_ACTIVE",
      "else",
      "  export CLEAN_DEVELOPMENT_ACTIVE=1",
      "fi",
      "unset _clean_development_bin",
      ""
    ].join("\n"));
    for (const tool of SHIM_TOOLS) {
      add(tool, `#!/bin/sh\nexec ${quoteSh(node)} ${quoteSh(shim)} ${quoteSh(tool)} "$@"\n`);
    }
  }
  for (const agent of Object.keys(SUPPORTED_AGENTS)) {
    const filename = process.platform === "win32" ? `clean-development-${agent}.cmd` : `clean-development-${agent}`;
    if (process.platform === "win32") add(filename, `@echo off\r\n"${node}" "${cli}" agent ${agent} -- %*\r\n`);
    else add(filename, `#!/bin/sh\nexec ${quoteSh(node)} ${quoteSh(cli)} agent ${quoteSh(agent)} -- "$@"\n`);
  }
  return { cli, specifications };
}

function ensureRuntimeUnlocked(config, { automatic = false } = {}) {
  const receiptFile = path.join(config.locations.stateDir, "runtime.json");
  const previous = runtimeReceipt(config);
  if (automatic && previous?.status !== "installed") return null;
  archiveRuntimeReceipt(config, previous);
  const versionRoot = path.join(config.locations.runtimeDir, VERSION);
  let installationId = previous?.version === VERSION ? previous.installationId : null;
  ensureRealDirectory(config.locations.runtimeDir, { create: true, label: "Runtime directory" });
  if (!fs.existsSync(versionRoot)) {
    installationId = crypto.randomUUID();
    if (!copyRuntime(packageRoot(), versionRoot, installationId)) installationId = null;
  }
  const marker = validateRuntimeRoot(versionRoot, installationId);
  installationId = marker.installationId;
  const runtimeFiles = previous?.installationId === installationId && Array.isArray(previous.runtimeFiles)
    ? previous.runtimeFiles
    : runtimeInventory(packageRoot(), versionRoot);
  verifyInventory(runtimeFiles, versionRoot);
  const binExisted = fs.existsSync(config.locations.binDir);
  ensureRealDirectory(config.locations.binDir, { create: true, label: "Runtime bin directory" });
  const { cli, specifications } = launcherSpecifications(versionRoot, config.locations.binDir);
  const previousFiles = new Map((previous?.ownedFiles || []).map((entry) => [path.resolve(entry.path), entry.sha256]));
  for (const specification of specifications) {
    if (!fs.existsSync(specification.path)) continue;
    const stat = fs.lstatSync(specification.path);
    const priorHash = previousFiles.get(path.resolve(specification.path));
    if (!stat.isFile() || stat.isSymbolicLink() || !priorHash || fileHash(specification.path) !== priorHash) {
      throw new Error(`Refusing to overwrite unowned or modified runtime file: ${specification.path}`);
    }
  }
  for (const specification of specifications) {
    if (fs.existsSync(specification.path) && fileHash(specification.path) === specification.sha256) {
      fs.chmodSync(specification.path, 0o755);
      continue;
    }
    writeExecutable(specification.path, specification.contents);
  }
  const ownedFiles = specifications.map(({ path: file, sha256: digest }) => ({ path: file, sha256: digest }));
  writeJsonAtomic(receiptFile, {
    schemaVersion: 2,
    version: VERSION,
    status: "installed",
    installationId,
    node: process.execPath,
    source: packageRoot(),
    versionRoot,
    binDir: config.locations.binDir,
    binDirectoryCreated: previous?.binDirectoryCreated === true || !binExisted,
    ownedFiles,
    runtimeFiles,
    installedAt: new Date().toISOString()
  });
  return { versionRoot, binDir: config.locations.binDir, cli };
}

export function ensureRuntime(config, options = {}) {
  if (options.automatic) {
    const receiptFile = path.join(config.locations.stateDir, "runtime.json");
    if (!fs.existsSync(receiptFile)) return null;
    if (runtimeReceipt(config)?.status !== "installed") return null;
  }
  const releaseLock = acquireDirectoryLockSync(path.join(config.locations.stateDir, "runtime.lock"));
  try {
    return ensureRuntimeUnlocked(config, options);
  } finally {
    releaseLock();
  }
}

export function runtimeHealth(config) {
  try {
    const receipt = runtimeReceipt(config);
    if (!receipt) return { ok: false, detail: "not installed" };
    if (receipt.status !== "installed") return { ok: false, detail: `${receipt.version} (${receipt.status})` };
    if (receipt.version !== VERSION) return { ok: false, detail: `${receipt.version} installed; run clean-development update for ${VERSION}` };
    if (!ensureRealDirectory(config.locations.runtimeDir, { label: "Runtime directory" })) {
      return { ok: false, detail: `Runtime directory is missing: ${config.locations.runtimeDir}` };
    }
    if (!ensureRealDirectory(config.locations.binDir, { label: "Runtime bin directory" })) {
      return { ok: false, detail: `Runtime bin directory is missing: ${config.locations.binDir}` };
    }
    validateRuntimeRoot(receipt.versionRoot, receipt.installationId, receipt.version);
    verifyInventory(receipt.runtimeFiles, receipt.versionRoot);
    verifyInventory(receipt.ownedFiles, config.locations.binDir);
    try {
      fs.accessSync(receipt.node, fs.constants.X_OK);
    } catch {
      throw new Error(`Runtime Node executable is unavailable: ${receipt.node}`);
    }
    for (const record of receipt.ownedFiles) {
      try {
        fs.accessSync(record.path, fs.constants.X_OK);
      } catch {
        throw new Error(`Runtime launcher is not executable: ${record.path}`);
      }
    }
    return { ok: true, detail: `${receipt.version} (${receipt.status})` };
  } catch (error) {
    return { ok: false, detail: error.message };
  }
}

function removeMatchingFile(record, allowedParent, removed, retained) {
  const file = path.resolve(record.path);
  if (!isPathInside(allowedParent, file) || !fs.existsSync(file)) return;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || fileHash(file) !== record.sha256) {
    retained.push(file);
    return;
  }
  fs.unlinkSync(file);
  removed.push(file);
}

function removeEmptyOwnedDirectories(root, records) {
  const directories = new Set(records.map((record) => path.dirname(path.resolve(record.path))));
  directories.add(path.resolve(root));
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
    if (directory !== path.resolve(root) && !isPathInside(root, directory)) continue;
    try {
      fs.rmdirSync(directory);
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
    }
  }
}

export function runtimeRemovalPlan(config) {
  const current = runtimeReceipt(config);
  const files = [];
  if (current) files.push(...(current.ownedFiles || []).map((entry) => entry.path), ...(current.runtimeFiles || []).map((entry) => entry.path));
  const archivedReceipts = [];
  const archiveDirectory = runtimeReceiptDirectory(config);
  let names = [];
  if (archiveDirectory) {
    try {
      names = fs.readdirSync(archiveDirectory).filter((name) => name.endsWith(".json"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  for (const name of names) {
    const archiveFile = path.join(archiveDirectory, name);
    const receipt = readArchivedRuntimeReceipt(archiveFile);
    if (!receipt) continue;
    files.push(...(receipt.runtimeFiles || []).map((entry) => entry.path));
    archivedReceipts.push(archiveFile);
  }
  return {
    files: [...new Set(files)],
    archivedReceipts,
    retained: [config.root, config.locations.configPath, config.locations.stateDir]
  };
}

function removeRuntimeUnlocked(config) {
  const receiptFile = path.join(config.locations.stateDir, "runtime.json");
  const receipt = runtimeReceipt(config);
  const result = { removed: [], retained: [] };
  if (!receipt) return result;
  if (fs.existsSync(config.locations.binDir)) {
    ensureRealDirectory(config.locations.binDir, { label: "Runtime bin directory" });
  }
  if (fs.existsSync(config.locations.runtimeDir)) {
    ensureRealDirectory(config.locations.runtimeDir, { label: "Runtime directory" });
  }
  for (const record of receipt.ownedFiles || []) removeMatchingFile(record, config.locations.binDir, result.removed, result.retained);
  if (receipt.binDirectoryCreated) {
    try {
      fs.rmdirSync(config.locations.binDir);
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
    }
  }
  removeVersionedRuntime(config, receipt, result);
  const archiveDirectory = runtimeReceiptDirectory(config);
  let archiveNames = [];
  if (archiveDirectory) {
    try {
      archiveNames = fs.readdirSync(archiveDirectory).filter((name) => name.endsWith(".json"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  for (const name of archiveNames) {
    const archiveFile = path.join(archiveDirectory, name);
    const archived = readArchivedRuntimeReceipt(archiveFile);
    if (!archived) continue;
    if (removeVersionedRuntime(config, archived, result)) fs.unlinkSync(archiveFile);
  }
  if (archiveDirectory) {
    try {
      fs.rmdirSync(archiveDirectory);
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
    }
  }
  writeJsonAtomic(receiptFile, { ...receipt, status: "uninstalled", removedAt: new Date().toISOString(), retainedFiles: result.retained });
  return result;
}

export function removeRuntime(config) {
  const releaseLock = acquireDirectoryLockSync(path.join(config.locations.stateDir, "runtime.lock"));
  try {
    return removeRuntimeUnlocked(config);
  } finally {
    releaseLock();
  }
}

function removeVersionedRuntime(config, receipt, result) {
  const versionRoot = path.resolve(receipt.versionRoot || path.join(config.locations.runtimeDir, receipt.version || VERSION));
  if (!isPathInside(config.locations.runtimeDir, versionRoot)) {
    result.retained.push(`${versionRoot} (unsafe path)`);
    return false;
  }
  if (!fs.existsSync(versionRoot)) return true;
  try {
    validateRuntimeRoot(versionRoot, receipt.installationId, receipt.version || VERSION);
    const runtimeFiles = [...(receipt.runtimeFiles || [])].sort((left, right) => right.path.length - left.path.length);
    for (const record of runtimeFiles) removeMatchingFile(record, versionRoot, result.removed, result.retained);
    removeEmptyOwnedDirectories(versionRoot, runtimeFiles);
    return !fs.existsSync(versionRoot);
  } catch (error) {
    if (error.code !== "ENOENT") result.retained.push(`${versionRoot} (${error.message})`);
    return error.code === "ENOENT";
  }
}

function candidateNames(executable, env) {
  if (process.platform !== "win32") return [executable];
  const extension = path.extname(executable);
  if (extension) return [executable];
  const pathExt = (environmentValue(env, "PATHEXT") || ".EXE;.CMD;.BAT;.COM").split(";");
  return [...pathExt.map((item) => `${executable}${item.toLowerCase()}`), ...pathExt.map((item) => `${executable}${item.toUpperCase()}`), executable];
}

function sameFile(left, right) {
  try {
    const a = fs.statSync(left);
    const b = fs.statSync(right);
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

function isGeneratedShim(file) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, "r");
    const prefix = Buffer.alloc(4096);
    const bytes = fs.readSync(descriptor, prefix, 0, prefix.length, 0);
    const contents = prefix.toString("utf8", 0, bytes);
    return contents.includes("clean-development-shim.js")
      || (contents.includes("import { runTool }") && contents.includes("import { resolveConfig }"));
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function resolveExecutable(executable, env, excludedDirectory) {
  if (executable.includes(path.sep) || (path.sep === "\\" && executable.includes("/"))) return path.resolve(executable);
  const excluded = excludedDirectory ? canonicalizePotentialPath(excludedDirectory) : null;
  const directories = (environmentValue(env, "PATH") || "").split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    if (excluded && canonicalizePotentialPath(directory) === excluded) continue;
    for (const name of candidateNames(executable, env)) {
      const candidate = path.join(directory, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (excluded && isPathInside(excluded, candidate)) continue;
        if (excluded && sameFile(candidate, path.join(excluded, name))) continue;
        if (isGeneratedShim(candidate)) continue;
        return candidate;
      } catch {
        // Keep searching PATH.
      }
    }
  }
  return null;
}

function escapeCmd(value) {
  return value.replace(/[()\[\]%!^"`<>&|;, *?]/g, (character) => `^${character}`);
}

function quoteWindowsArgument(value) {
  // Quote for the Windows argv parser before protecting cmd.exe metacharacters.
  let quoted = '"';
  let backslashes = 0;
  for (const character of String(value)) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    quoted += "\\".repeat(character === '"' ? backslashes * 2 + 1 : backslashes) + character;
    backslashes = 0;
  }
  return quoted + "\\".repeat(backslashes * 2) + '"';
}

export function windowsBatchInvocation(command, args, env) {
  if ([command, ...args].some((value) => /[\r\n\0]/.test(String(value)))) {
    throw new Error("Windows batch commands cannot contain newlines or NUL bytes");
  }
  const doubleEscape = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(command);
  const escapedArgs = args.map((value) => {
    const escaped = escapeCmd(quoteWindowsArgument(value));
    return doubleEscape ? escapeCmd(escaped) : escaped;
  });
  const commandLine = [escapeCmd(path.win32.normalize(command)), ...escapedArgs].join(" ");
  return {
    command: environmentValue(env, "ComSpec") || "cmd.exe",
    args: ["/d", "/v:off", "/s", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true
  };
}

export function spawnInherited(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const env = options.env || process.env;
    const invocation = process.platform === "win32" && /\.(cmd|bat)$/i.test(command)
      ? windowsBatchInvocation(command, args, env)
      : { command, args };
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd || process.cwd(), env, stdio: "inherit", windowsHide: false,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments || false
    });
    try {
      options.onSpawn?.(child);
    } catch (error) {
      child.once("error", () => {});
      try {
        child.kill();
      } catch {
        // The child may not have reached a running state.
      }
      reject(error);
      return;
    }
    const forward = (signal) => {
      try {
        child.kill(signal);
      } catch {
        // The process may have exited between signal receipt and forwarding.
      }
    };
    process.once("SIGINT", forward);
    process.once("SIGTERM", forward);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      process.removeListener("SIGINT", forward);
      process.removeListener("SIGTERM", forward);
      const signalNumber = signal ? os.constants.signals[signal] : null;
      resolve(signal ? 128 + (signalNumber || 1) : (code ?? 1));
    });
  });
}

function managedCargoTargetOwners(config, target, cwd) {
  if (!target) return [];
  const resolvedTarget = canonicalizePotentialPath(path.resolve(cwd, target));
  const owners = [];
  for (const { value } of listWorkspaceRecords(config)) {
    const buildPath = path.resolve(value.path);
    if (resolvedTarget !== buildPath && !isPathInside(buildPath, resolvedTarget)) continue;
    if (buildPath !== path.join(path.resolve(value.buildRoot), value.workspaceId)
      || path.dirname(buildPath) !== path.resolve(value.buildRoot)
      || canonicalizePotentialPath(buildPath) !== buildPath) continue;
    const markerPath = path.join(buildPath, OWNERSHIP_MARKER);
    if (!fs.existsSync(markerPath)) continue;
    const stat = fs.lstatSync(markerPath);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    const marker = readJson(markerPath, null);
    if (marker?.owner === "clean-development" && marker.ownershipId === value.ownershipId
      && marker.workspaceId === value.workspaceId && marker.workspace === value.workspace) {
      owners.push(value);
    }
  }
  owners.sort((left, right) => path.resolve(right.path).length - path.resolve(left.path).length);
  if (owners[0] && resolvedTarget === path.resolve(owners[0].path)) {
    throw new Error(`Refusing Cargo target at the owned build directory itself: ${owners[0].path}. Use a subdirectory so cargo clean preserves the ownership marker.`);
  }
  return owners;
}

function cargoTargetSelection(args, preview) {
  for (let index = 0; index < args.length && args[index] !== "--"; index += 1) {
    if (args[index] === "--target-dir") return { directory: args[index + 1], explicit: true };
    if (args[index].startsWith("--target-dir=")) return { directory: args[index].slice("--target-dir=".length), explicit: true };
  }
  return { directory: environmentValue(preview.env, "CARGO_TARGET_DIR"), explicit: !Object.hasOwn(preview.applied, "CARGO_TARGET_DIR") };
}

function rejectUnownedManagedTarget(config, target, cwd, owners) {
  if (!target) return;
  const resolvedTarget = canonicalizePotentialPath(path.resolve(cwd, target));
  const roots = [config.buildRoot, ...listWorkspaceRecords(config).map(({ value }) => value.buildRoot).filter(path.isAbsolute)];
  for (const root of new Set(roots)) {
    const resolvedRoot = canonicalizePotentialPath(root);
    if ((resolvedTarget === resolvedRoot || isPathInside(resolvedRoot, resolvedTarget))
      && !owners.some((owner) => canonicalizePotentialPath(owner.buildRoot) === resolvedRoot)) {
      throw new Error(`Refusing unowned explicit Cargo target inside managed build root: ${resolvedTarget}. Use normal managed routing first, or choose a target outside managed build roots.`);
    }
  }
}

export async function runTool(tool, args, { config, cwd = process.cwd(), env = process.env } = {}) {
  if (!SHIM_TOOLS.includes(tool)) throw new Error(`Unsupported shim tool: ${tool}`);
  const sessionMode = normalizeSessionMode(environmentValue(env, SESSION_MODE_ENV));
  if (sessionMode === "skip") {
    const childEnv = environmentWithoutSessionRouting(env, config.locations.binDir);
    const executable = resolveExecutable(tool, childEnv, config.locations.binDir);
    if (!executable) throw new Error(`Cannot find the real '${tool}' executable outside ${config.locations.binDir}`);
    return spawnInherited(executable, args, { cwd, env: childEnv });
  }
  const workspace = identifyWorkspace(tool, args, cwd);
  const effectiveConfig = workspace.effectiveCwd === path.resolve(cwd)
    ? config
    : resolveConfig({ cwd: workspace.effectiveCwd, env });
  if (effectiveConfig.enabled === false || effectiveConfig.tools?.[tool] === false) {
    const childEnv = environmentWithoutSessionRouting(env, effectiveConfig.locations.binDir);
    const executable = resolveExecutable(tool, childEnv, effectiveConfig.locations.binDir);
    if (!executable) throw new Error(`Cannot find the real '${tool}' executable outside ${effectiveConfig.locations.binDir}`);
    return spawnInherited(executable, args, { cwd, env: childEnv });
  }
  const executable = resolveExecutable(tool, env, effectiveConfig.locations.binDir);
  if (!executable) throw new Error(`Cannot find the real '${tool}' executable outside ${effectiveConfig.locations.binDir}`);
  const preview = tool === "cargo" ? environmentForTool(tool, args, { config: effectiveConfig, cwd, env, create: false }) : null;
  const targetSelection = preview ? cargoTargetSelection(args, preview) : null;
  const targetDirectory = targetSelection?.directory;
  let targetOwners = [];
  const releaseLocks = [];
  const leases = [];
  let execution = null;
  let routed;
  try {
    for (let attempt = 0; tool === "cargo" && attempt < 5; attempt += 1) {
      targetOwners = managedCargoTargetOwners(effectiveConfig, targetDirectory, cwd);
      const lockTargets = [{ workspaceId: workspace.id, buildRoot: effectiveConfig.buildRoot }];
      for (const owner of targetOwners) {
        if (!lockTargets.some((target) => target.workspaceId === owner.workspaceId && target.buildRoot === owner.buildRoot)) lockTargets.push(owner);
      }
      lockTargets.sort((left, right) => {
        const a = `${left.buildRoot}/${left.workspaceId}`;
        const b = `${right.buildRoot}/${right.workspaceId}`;
        return a < b ? -1 : a > b ? 1 : 0;
      });
      for (const target of lockTargets) releaseLocks.push(await acquireWorkspaceLock(effectiveConfig, target.workspaceId, target.buildRoot));
      const currentOwners = managedCargoTargetOwners(effectiveConfig, targetDirectory, cwd);
      const stable = currentOwners.length === targetOwners.length && currentOwners.every((owner, index) =>
        ["workspaceId", "workspace", "buildRoot", "path", "ownershipId"].every((key) => owner[key] === targetOwners[index][key]));
      if (stable) {
        targetOwners = currentOwners;
        if (targetSelection.explicit) rejectUnownedManagedTarget(effectiveConfig, targetDirectory, cwd, targetOwners);
        break;
      }
      while (releaseLocks.length > 0) releaseLocks.pop()();
      if (attempt === 4) throw new Error("Managed Cargo target ownership kept changing before execution; retry the command");
    }
    const existingBuildRecord = tool === "cargo"
      ? workspaceRecord(effectiveConfig, workspace.id, effectiveConfig.buildRoot).value
      : null;
    routed = environmentForTool(tool, args, { config: effectiveConfig, cwd, env, create: true, existingBuildRecord });
    if (routed.ownedBuild) {
      recordWorkspace(effectiveConfig, routed.workspace, routed.ownedBuild);
    }
    for (const targetOwner of targetOwners) {
      if (targetOwner.path === routed.ownedBuild?.path) continue;
      recordWorkspace(
        { ...effectiveConfig, buildRoot: targetOwner.buildRoot },
        { id: targetOwner.workspaceId, root: targetOwner.workspace },
        { path: targetOwner.path, ownershipId: targetOwner.ownershipId }
      );
    }
    if (tool === "cargo") {
      leases.push(createLease(effectiveConfig, routed.workspace, tool));
      const leasedIds = new Set([routed.workspace.id]);
      for (const targetOwner of targetOwners) {
        if (leasedIds.has(targetOwner.workspaceId)) continue;
        leases.push(createLease(effectiveConfig, { id: targetOwner.workspaceId, root: targetOwner.workspace }, tool));
        leasedIds.add(targetOwner.workspaceId);
      }
      execution = spawnInherited(executable, args, {
        cwd,
        env: routed.env,
        onSpawn: (child) => { for (const lease of leases) lease.updatePid(child.pid); }
      });
    }
  } catch (error) {
    for (const lease of leases) lease.release();
    throw error;
  } finally {
    for (const release of releaseLocks.reverse()) release();
  }
  execution ||= spawnInherited(executable, args, { cwd, env: routed.env });
  try {
    return await execution;
  } finally {
    for (const lease of leases) lease.release();
  }
}

export async function runWithShims(command, args, { config, cwd = process.cwd(), env = process.env } = {}) {
  const sessionMode = normalizeSessionMode(environmentValue(env, SESSION_MODE_ENV));
  if (sessionMode === "skip") {
    const childEnv = environmentWithoutSessionRouting(env, config.locations.binDir);
    const executable = resolveExecutable(command, childEnv, config.locations.binDir);
    if (!executable) throw new Error(`Cannot find executable: ${command}`);
    return spawnInherited(executable, args, { cwd, env: childEnv });
  }
  const runtime = ensureRuntime(config);
  const childEnv = { ...env, CLEAN_DEVELOPMENT_ACTIVE: "1" };
  setEnvironmentValue(childEnv, "PATH", prependUniquePath(environmentValue(childEnv, "PATH"), runtime.binDir));
  if (SHIM_TOOLS.includes(command)) return runTool(command, args, { config, cwd, env: childEnv });
  const executable = resolveExecutable(command, childEnv, runtime.binDir);
  if (!executable) throw new Error(`Cannot find executable: ${command}`);
  let forwarded = args;
  if (command === SUPPORTED_AGENTS.codex) {
    const separator = args.indexOf("--");
    const insertion = separator === -1 ? args.length : separator;
    const routedMode = sessionMode || "session-only";
    forwarded = [
      ...args.slice(0, insertion),
      "-c", "allow_login_shell=false",
      "-c", `shell_environment_policy.set.${SESSION_MODE_ENV}=${JSON.stringify(routedMode)}`,
      ...args.slice(insertion)
    ];
  }
  return spawnInherited(executable, forwarded, { cwd, env: childEnv });
}
