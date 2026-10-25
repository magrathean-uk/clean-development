#!/usr/bin/env node
// Immutable runtime publication plus journalled, recoverable activation of the owned files.
// No harness settings, trust state, native accounts, existing release or policy overlay is removed.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { homeDir, loadConf, stateDir } from "./runtime/lib/conf.mjs";
import { lstatOrNull, readJsonOrNull, safeDirectory, syncDirectory, withLock, writeFileAtomic } from "./runtime/lib/fsutil.mjs";
import { detect, ensureLayout, layout } from "./runtime/lib/storage.mjs";
import { DIGEST_ALGORITHM, treeDigest } from "./runtime/lib/release.mjs";
export { treeDigest } from "./runtime/lib/release.mjs";

const hash = (b) => createHash("sha256").update(b).digest("hex");
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
function check(command, args, env) {
  const r = spawnSync(command, args, { env: { ...env, BASH_ENV: "/dev/null", ENV: "/dev/null", NODE_OPTIONS: "", NODE_PATH: "" }, encoding: "utf8", timeout: 10000 });
  if (r.status !== 0 || r.error) throw new Error(`preflight ${command}: ${r.stderr || r.error?.message || r.status}`);
}
function syncTree(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) syncTree(p);
    else { const fd = fs.openSync(p, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
  }
  syncDirectory(dir);
}
function options(args) {
  const o = { config: false, replaceConfig: false, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--config": o.config = true; break;
      case "--replace-config": o.replaceConfig = true; break;
      case "--dry-run": o.dryRun = true; break;
      case "--recover": o.recover = args[++i]; if (!o.recover || o.recover.startsWith("-")) throw new Error("--recover needs a transaction ID"); break;
      case "--help": case "-h": o.help = true; break;
      default: throw new Error(`unknown argument: ${args[i]}`);
    }
  }
  if (o.replaceConfig && !o.config) throw new Error("--replace-config requires --config");
  if (o.recover && (o.config || o.replaceConfig || o.dryRun)) throw new Error("--recover cannot be combined with install options");
  return o;
}
function ownedFiles(env) {
  const machine = path.join(homeDir(env), "dev", "machine");
  return [path.join(machine, "bin", "clean-development"), path.join(machine, "env.zsh"), path.join(machine, "storage.conf")];
}
function activationState(home, file) {
  if (!safeDirectory(home, path.dirname(file))) throw new Error(`unsafe activation target: ${file}`);
  let st;
  try { st = fs.lstatSync(file); } catch (e) { if (e.code !== "ENOENT") throw e; }
  if (st && (!st.isFile() || st.isSymbolicLink())) throw new Error(`unsafe activation target: ${file}`);
  return { bytes: st ? fs.readFileSync(file) : null, mode: st ? st.mode & 0o777 : null };
}
function saveJournal(file, journal) { writeFileAtomic(file, JSON.stringify(journal, null, 2) + "\n", 0o600, { durable: true }); }

// Recovery touches only intended activation files, only if their current bytes are this transaction's
// output (or already restored). A concurrent/user edit is a conflict, never overwritten by rollback.
export function restore(journal, dir, env) {
  const allowed = new Set(ownedFiles(env)), conflicts = [];
  for (const entry of [...journal.files].reverse()) {
    if (!entry.intent) continue;
    if (!allowed.has(entry.path) || !safeDirectory(homeDir(env), path.dirname(entry.path))) throw new Error("unsafe recovery target");
    const st = lstatOrNull(entry.path);
    if (st && (!st.isFile() || st.isSymbolicLink())) { conflicts.push(entry.path); continue; }
    const current = st ? hash(fs.readFileSync(entry.path)) : null;
    if (current === entry.beforeHash && (!st || (st.mode & 0o777) === entry.beforeMode)) continue;
    if (current !== entry.afterHash || (st && (st.mode & 0o777) !== entry.afterMode)) { conflicts.push(entry.path); continue; }
    if (entry.beforeHash === null) fs.unlinkSync(entry.path);
    else {
      const backup = path.join(dir, "files", String(entry.index));
      const bytes = fs.readFileSync(backup);
      if (hash(bytes) !== entry.beforeHash) throw new Error("recovery backup digest mismatch");
      writeFileAtomic(entry.path, bytes, entry.beforeMode, { durable: true });
    }
  }
  journal.status = conflicts.length ? "recovery-required" : "rolled-back";
  journal.conflicts = conflicts;
  saveJournal(path.join(dir, "receipt.json"), journal);
  return conflicts;
}

export function installPackage(src, env, { config = false, replaceConfig = false, dryRun = false, onPhase = () => {} } = {}) {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 20 || (major === 20 && minor < 12)) throw new Error("Node >= 20.12 required");
  const home = homeDir(env), machine = path.join(home, "dev", "machine");
  const runtime = path.join(src, "runtime"), version = fs.readFileSync(path.join(runtime, "VERSION"), "utf8").trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("invalid release version");
  const digest = treeDigest(runtime);
  const dest = path.join(machine, "runtime", "clean-development", version);
  const policyFile = path.join(machine, "storage.conf");
  const useSourcePolicy = config && (replaceConfig || !lstatOrNull(policyFile));
  const conf = loadConf(env, useSourcePolicy ? { text: fs.readFileSync(path.join(src, "machine", "storage.conf"), "utf8") } : {});
  if (!conf.valid) throw new Error(`storage.conf invalid: ${conf.errors.join("; ")}`);
  if (!safeDirectory(home, machine)) throw new Error("unsafe machine directory topology");
  if (lstatOrNull(dest) && treeDigest(dest) !== digest) throw new Error(`immutable release differs: ${dest}; bump the version, never replace active bytes`);
  const files = [{ path: ownedFiles(env)[0], data: `#!/bin/sh\nexec ${quote(path.join(dest, "bin", "clean-development"))} "$@"\n`, mode: 0o755 }];
  if (config) {
    files.push({ path: ownedFiles(env)[1], data: fs.readFileSync(path.join(src, "machine", "env.zsh")), mode: 0o644 });
    if (useSourcePolicy) files.push({ path: policyFile, data: fs.readFileSync(path.join(src, "machine", "storage.conf")), mode: 0o644 });
  }
  for (const file of files) {
    const st = lstatOrNull(file.path);
    if (!safeDirectory(home, path.dirname(file.path)) || (st && (!st.isFile() || st.isSymbolicLink()))) throw new Error(`unsafe activation target: ${file.path}`);
  }
  for (const dir of ["lib", "bin"]) for (const f of fs.readdirSync(path.join(runtime, dir)).filter((f) => f.endsWith(".mjs"))) check(process.execPath, ["--check", path.join(runtime, dir, f)], env);
  for (const f of ["cd-hook", "clean-development"]) check("/bin/sh", ["-n", path.join(runtime, "bin", f)], env);
  if (config) for (const shell of ["/bin/zsh", "/bin/bash"]) check(shell, ["-f", "-n", path.join(src, "machine", "env.zsh")], env);
  const candidates = [conf.internalRoot];
  if (detect(conf, env, { probe: false, create: false }).mode === "external") candidates.push(conf.externalCache);
  for (const root of candidates) for (const sub of ["deps", "builds", "scratch", "trash"]) {
    if (!safeDirectory(root, layout(root)[sub], { missingAnchor: true })) throw new Error(`unsafe cache layout: ${layout(root)[sub]}`);
  }
  const plan = { version, digest, digestAlgorithm: DIGEST_ALGORITHM, runtime: dest,
    files: files.map((f) => f.path), policy: useSourcePolicy ? "install source policy" : "preserve existing policy/defaults" };
  onPhase("preflight");
  if (dryRun) return { status: "preview", ...plan };
  // Validate all paths before creating a journal/lock or publishing a release.
  if (!safeDirectory(home, stateDir(env)) || !safeDirectory(home, path.dirname(dest))) throw new Error("unsafe install state/runtime topology");
  const r = withLock(path.join(stateDir(env), "install.lock"), () => {
    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
    const dir = path.join(stateDir(env), "installations", id);
    fs.mkdirSync(path.join(dir, "files"), { recursive: true, mode: 0o700 });
    const journal = { schemaVersion: 1, id, status: "prepared", ...plan, files: [] };
    const receipt = path.join(dir, "receipt.json");
    try {
      for (const [index, file] of files.entries()) {
        const { bytes, mode } = activationState(home, file.path);
        if (bytes) writeFileAtomic(path.join(dir, "files", String(index)), bytes, 0o600, { durable: true });
        journal.files.push({ index, path: file.path, beforeHash: bytes === null ? null : hash(bytes), beforeMode: mode,
          afterHash: hash(file.data), afterMode: file.mode, intent: false });
      }
      saveJournal(receipt, journal);
      if (lstatOrNull(dest) && treeDigest(dest) !== digest) throw new Error("immutable release changed after preflight");
      if (!lstatOrNull(dest)) {
        const stage = `${dest}.installing-${id}`;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.cpSync(runtime, stage, { recursive: true, errorOnExist: true, force: false });
        if (treeDigest(stage) !== digest) throw new Error("staged release digest mismatch");
        syncTree(stage);
        onPhase("staged");
        fs.renameSync(stage, dest);
        syncDirectory(path.dirname(dest));
      }
      journal.status = "activating"; saveJournal(receipt, journal); onPhase("runtime-published");
      for (const [index, file] of files.entries()) {
        const current = activationState(home, file.path), expected = journal.files[index];
        if ((current.bytes === null ? null : hash(current.bytes)) !== expected.beforeHash || current.mode !== expected.beforeMode)
          throw new Error(`activation conflict: ${file.path}`);
        // Refused pre-activation edits are not ours to restore, even when they happen to
        // match the planned output. Journal write intent only after validating the backup.
        expected.intent = true; saveJournal(receipt, journal);
        writeFileAtomic(file.path, file.data, file.mode, { durable: true });
        onPhase(`file-${index}`);
      }
      ensureLayout(conf.internalRoot);
      const d = detect(conf, env);
      if (d.mode === "external") ensureLayout(conf.externalCache);
      onPhase("layout-ready");
      journal.status = "committed"; journal.completedAt = new Date().toISOString(); saveJournal(receipt, journal);
      return { ...plan, status: "committed", receipt, mode: d.mode };
    } catch (e) {
      journal.error = e.message;
      try { restore(journal, dir, env); } catch (recovery) { journal.status = "recovery-required"; journal.recoveryError = recovery.message; saveJournal(receipt, journal); }
      throw new Error(`${e.message}; transaction ${journal.status}, recovery bytes: ${dir}`);
    }
  });
  if (r.locked) throw new Error("install lock busy or requires explicit recovery; no files changed");
  return r.result;
}

function recover(id, env) {
  if (!/^[A-Za-z0-9-]+$/.test(id)) throw new Error("invalid transaction ID");
  const dir = path.join(stateDir(env), "installations", id), file = path.join(dir, "receipt.json");
  const journal = readJsonOrNull(file);
  if (!journal || journal.id !== id || journal.status === "committed") throw new Error("no unfinished transaction with that ID");
  const result = withLock(path.join(stateDir(env), "install-recovery.lock"), () => {
    const lock = path.join(stateDir(env), "install.lock"), owner = readJsonOrNull(lock);
    if (lstatOrNull(lock)) {
      if (!Number.isInteger(owner?.pid) || owner.pid <= 1) throw new Error("cannot verify old installer lock owner; inspect manually");
      try { process.kill(owner.pid, 0); throw new Error("installer may still be alive; refusing recovery"); } catch (e) { if (e.code !== "ESRCH") throw e; }
      fs.unlinkSync(lock);
    }
    const r = withLock(lock, () => restore(journal, dir, env));
    if (r.locked) throw new Error("another installer started; retry recovery later");
    return { status: journal.status, conflicts: r.result, receipt: file };
  });
  if (result.locked) throw new Error("another recovery is active or needs inspection");
  return result.result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const o = options(process.argv.slice(2));
    if (o.help) console.log("usage: install.sh [--dry-run] [--config [--replace-config]] | --recover TRANSACTION_ID");
    else console.log(JSON.stringify(o.recover ? recover(o.recover, process.env) : installPackage(path.dirname(fileURLToPath(import.meta.url)), process.env, o), null, 2));
  } catch (e) { console.error(`install.sh: ${e.message}`); process.exitCode = /unknown argument|requires --config|cannot be combined|needs a transaction/.test(e.message) ? 2 : 1; }
}
