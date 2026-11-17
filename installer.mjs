#!/usr/bin/env node
// Immutable runtime publication plus journalled, recoverable activation of the owned files.
// Unrelated harness settings, trust state, native accounts, existing releases and policy overlays are preserved.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { homeDir, hookShimPath, hookShimText, loadConf, logPath, stateDir } from "./runtime/lib/conf.mjs";
import { appendLog, lstatOrNull, readJsonOrNull, safeDirectory, syncDirectory, writeFileAtomic } from "./runtime/lib/fsutil.mjs";
import { probeLock, readHeldBody, stateFsSupported, testStop, unlinkHeld, withLock } from "./install-lock.mjs";
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
function writeFileAtomicCreateOnly(file, data, mode = 0o600, { durable = false } = {}) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { mode, flag: "wx" });
    fs.chmodSync(tmp, mode);
    if (durable) {
      const fd = fs.openSync(tmp, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    // A same-directory hard link publishes the complete file atomically and fails with EEXIST
    // instead of replacing a host-local file created after preflight.
    fs.linkSync(tmp, file);
    if (durable) syncDirectory(dir);
    fs.unlinkSync(tmp);
    if (durable) syncDirectory(dir);
  } finally { try { fs.unlinkSync(tmp); } catch { /* promoted or never created */ } }
}
function options(args) {
  const o = { config: false, replaceConfig: false, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--config": o.config = true; break;
      case "--replace-config": o.replaceConfig = true; break;
      case "--dry-run": o.dryRun = true; break;
      case "--record-dir": o.recordDir = args[++i]; if (!o.recordDir || o.recordDir.startsWith("-")) throw new Error("--record-dir needs a directory"); break;
      case "--recover": o.recover = args[++i]; if (!o.recover || o.recover.startsWith("-")) throw new Error("--recover needs a transaction ID"); break;
      case "--rollback": o.rollback = args[++i]; if (!o.rollback || o.rollback.startsWith("-")) throw new Error("--rollback needs a transaction ID"); break;
      case "--accept-current": o.acceptCurrent = true; break;
      case "--help": case "-h": o.help = true; break;
      default: throw new Error(`unknown argument: ${args[i]}`);
    }
  }
  if (o.replaceConfig && !o.config) throw new Error("--replace-config requires --config");
  if (o.acceptCurrent && !o.recover) throw new Error("--accept-current requires --recover");
  if (o.recover && (o.config || o.replaceConfig || o.dryRun || o.recordDir)) throw new Error("--recover cannot be combined with install options");
  if (o.rollback && (o.recover || o.acceptCurrent || o.config || o.replaceConfig || o.dryRun || o.recordDir)) throw new Error("--rollback cannot be combined with other options");
  return o;
}
// The CLI launcher and the version-less hook shim switch releases. env.zsh and storage policy switch only with
// --config; the optional Colima shim is installed only when the explicit source manifest lists it.
function ownedFiles(env) {
  const machine = path.join(homeDir(env), "dev", "machine");
  return [path.join(machine, "bin", "clean-development"), path.join(machine, "env.zsh"), path.join(machine, "storage.conf"), hookShimPath(env),
    path.join(machine, "bin", "colima"), path.join(machine, "env.private.zsh"),
    ...["childenv-allow.list", "codex-homes.list", "claude-settings.list", "claude-profiles.list"].map((name) => path.join(stateDir(env), name)),
    ...hookTargets(env).map((target) => target.path)];
}
function hookTargets(env) {
  return [{ harness: "claude", path: path.join(homeDir(env), ".claude", "settings.json") },
    { harness: "codex", path: path.join(homeDir(env), ".codex", "hooks.json") }];
}
function plannedHooks(src, env) {
  const python = ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"].find((p) => fs.existsSync(p)) || "python3";
  return hookTargets(env).map((target) => {
    const { bytes, mode } = activationState(homeDir(env), target.path);
    const result = spawnSync(python, ["-I", "-B", path.join(src, "scripts", "plan-hooks.py"), src, target.harness, target.path], {
      env: { ...env, PYTHONHOME: "", PYTHONPATH: "" }, encoding: "utf8", timeout: 10000
    });
    if (result.status !== 0 || result.error) throw new Error(`hook preflight: ${result.stderr || result.error?.message || result.status}`);
    // Preserve an already-current document byte for byte, including its permissions.
    const data = bytes !== null && JSON.stringify(JSON.parse(bytes)) === JSON.stringify(JSON.parse(result.stdout)) ? bytes : result.stdout;
    return { path: target.path, data, mode: mode ?? 0o600, plannedBefore: { hash: bytes === null ? null : hash(bytes), mode } };
  });
}
function checkedRecordDir(dir) {
  dir = path.resolve(dir);
  let anchor = dir;
  while (!lstatOrNull(anchor) && path.dirname(anchor) !== anchor) anchor = path.dirname(anchor);
  if (!safeDirectory(anchor, dir)) throw new Error(`unsafe rollback record directory: ${dir}`);
  return dir;
}
function sourceCommit(src, env) {
  const cleanEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("GIT_")));
  const result = spawnSync("git", ["-C", src, "rev-parse", "HEAD"], {
    env: { ...cleanEnv, GIT_OPTIONAL_LOCKS: "0" }, encoding: "utf8", timeout: 10000
  });
  const commit = result.stdout?.trim();
  return result.status === 0 && /^[a-f0-9]{40,64}$/.test(commit) ? commit : "unavailable (source is not a Git checkout)";
}
function recordRollback(src, env, journal, receipt, recordDir) {
  const previous = journal.files.find((entry) => entry.path === hookShimPath(env));
  const shim = previous?.beforeHash ? fs.readFileSync(path.join(path.dirname(receipt), "files", String(previous.index)), "utf8") : "";
  const target = shim.split("\n").find((line) => line.startsWith("rt=")) || "(no previous active target)";
  const from = target.match(/\/(\d+\.\d+\.\d+)'?$/)?.[1] || "none";
  const file = path.join(checkedRecordDir(recordDir), `rollback-${journal.id}-from-${from}-to-${journal.version}.md`);
  const command = `${quote(path.isAbsolute(env.CLEAN_DEV_NODE || "") ? env.CLEAN_DEV_NODE : process.execPath)} ${quote(path.join(path.resolve(src), "installer.mjs"))} --rollback ${quote(journal.id)}`;
  const text = `# Release rollback\n\nTransaction: ${journal.id}\nFrom version: ${from}\nTo version: ${journal.version}\nSource commit: ${sourceCommit(src, env)}\nPrevious active target: ${target}\nReceipt: ${receipt}\nRollback command (restores activation files and hooks; retains both releases):\n\n\`\`\`sh\n${command}\n\`\`\`\n`;
  writeFileAtomicCreateOnly(file, text, 0o600, { durable: true });
  return file;
}
const PRIVATE_SIDECARS = new Map([
  ["machine/env.private.zsh", (env) => path.join(homeDir(env), "dev", "machine", "env.private.zsh")],
  ["machine/clean-env-allow.list", (env) => path.join(stateDir(env), "childenv-allow.list")],
  ["machine/clean-development/codex-homes.list", (env) => path.join(stateDir(env), "codex-homes.list")],
  ["machine/clean-development/claude-settings.list", (env) => path.join(stateDir(env), "claude-settings.list")],
  ["machine/clean-development/claude-profiles.list", (env) => path.join(stateDir(env), "claude-profiles.list")],
  ["clean-development/machine/colima", (env) => path.join(homeDir(env), "dev", "machine", "bin", "colima")]
]);
function readTrustedSource(file, label) {
  let fd;
  const sourceStat = lstatOrNull(file);
  if (!sourceStat || !sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error(`unsafe ${label}: ${file}`);
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(fd), uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (!opened.isFile() || (uid !== null && opened.uid !== uid) || (opened.mode & 0o022)) throw new Error(`unsafe ${label}: ${file}`);
    return fs.readFileSync(fd);
  } catch (e) {
    if (e.message?.startsWith(`unsafe ${label}:`)) throw e;
    throw new Error(`cannot read ${label}: ${file}: ${e.code || e.message}`);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function privateSidecars(src, env) {
  const parent = path.resolve(src, ".."), manifestPath = path.join(parent, ".clean-development-private-sidecars.json");
  if (!lstatOrNull(manifestPath)) return [];
  let manifest;
  try { manifest = JSON.parse(readTrustedSource(manifestPath, "private sidecar manifest").toString("utf8")); }
  catch (e) { throw new Error(`invalid private sidecar manifest: ${e.message}`); }
  if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.sidecars) ||
      manifest.sidecars.some((item) => typeof item !== "string" || !PRIVATE_SIDECARS.has(item)) ||
      new Set(manifest.sidecars).size !== manifest.sidecars.length) throw new Error(`invalid private sidecar manifest: expected schemaVersion 1 and unique known sidecars`);
  const files = [];
  for (const relative of manifest.sidecars) {
    const source = path.join(parent, relative), data = readTrustedSource(source, "private sidecar source");
    const target = PRIVATE_SIDECARS.get(relative)(env), targetStat = lstatOrNull(target);
    if (targetStat) {
      if (!targetStat.isFile() && !targetStat.isSymbolicLink()) throw new Error(`unsafe private sidecar target: ${target}`);
      continue; // Existing host-local extensions and registries are user-managed.
    }
    files.push({ path: target, data, mode: relative.endsWith("/colima") ? 0o755 : 0o600, createOnly: true, source });
  }
  return files;
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
export function restore(journal, dir, env, { acceptCurrent = false } = {}) {
  const allowed = new Set(ownedFiles(env)), conflicts = [], preserved = [];
  const conflict = (file) => (acceptCurrent ? preserved : conflicts).push(file);
  for (const entry of [...journal.files].reverse()) {
    if (!entry.intent) continue;
    if (!allowed.has(entry.path) || !safeDirectory(homeDir(env), path.dirname(entry.path))) throw new Error("unsafe recovery target");
    const st = lstatOrNull(entry.path);
    if (st && (!st.isFile() || st.isSymbolicLink())) { conflict(entry.path); continue; }
    const current = st ? hash(fs.readFileSync(entry.path)) : null;
    if (current === entry.beforeHash && (!st || (st.mode & 0o777) === entry.beforeMode)) continue;
    if (current !== entry.afterHash || (st && (st.mode & 0o777) !== entry.afterMode)) { conflict(entry.path); continue; }
    if (entry.beforeHash === null) fs.unlinkSync(entry.path);
    else {
      const backup = path.join(dir, "files", String(entry.index));
      const bytes = fs.readFileSync(backup);
      if (hash(bytes) !== entry.beforeHash) throw new Error("recovery backup digest mismatch");
      writeFileAtomic(entry.path, bytes, entry.beforeMode, { durable: true });
    }
  }
  journal.status = conflicts.length ? "recovery-required" : preserved.length ? "recovered-preserving-conflicts" : "rolled-back";
  journal.conflicts = conflicts;
  journal.preserved = preserved;
  saveJournal(path.join(dir, "receipt.json"), journal);
  return { status: journal.status, conflicts, preserved };
}

export function installPackage(src, env, { config = false, replaceConfig = false, dryRun = false, recordDir, onPhase = () => {} } = {}) {
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
  const node = quote(path.isAbsolute(env.CLEAN_DEV_NODE || "") ? env.CLEAN_DEV_NODE : process.execPath);
  const cli = quote(path.join(dest, "bin", "clean-development.mjs")), fallback = quote(path.join(dest, "bin", "clean-development"));
  const files = [{ path: ownedFiles(env)[0], data: `#!/bin/sh\nnode=${node}\nnode_ok() { [ -x "$1" ] && "$1" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major < 20 || (major === 20 && minor < 12) ? 1 : 0)' >/dev/null 2>&1; }\nif node_ok "$node"; then exec "$node" ${cli} "$@"; fi\nexec ${fallback} "$@"\n`, mode: 0o755 },
    { path: ownedFiles(env)[3], data: hookShimText(env, version), mode: 0o755 }];
  if (config) {
    const sidecars = privateSidecars(src, env);
    files.push(...sidecars);
    files.push({ path: ownedFiles(env)[1], data: fs.readFileSync(path.join(src, "machine", "env.zsh")), mode: 0o644 });
    if (useSourcePolicy) files.push({ path: policyFile, data: fs.readFileSync(path.join(src, "machine", "storage.conf")), mode: 0o644 });
  }
  files.push(...plannedHooks(src, env));
  recordDir = checkedRecordDir(recordDir || path.join(machine, "runtime", "clean-development", "rollback"));
  for (const file of files) {
    const st = lstatOrNull(file.path);
    if (!safeDirectory(home, path.dirname(file.path)) || (st && (!st.isFile() || st.isSymbolicLink()))) throw new Error(`unsafe activation target: ${file.path}`);
  }
  for (const dir of ["lib", "bin"]) for (const f of fs.readdirSync(path.join(runtime, dir)).filter((f) => f.endsWith(".mjs"))) check(process.execPath, ["--check", path.join(runtime, dir, f)], env);
  for (const f of ["cd-hook", "clean-development"]) check("/bin/sh", ["-n", path.join(runtime, "bin", f)], env);
  const colimaSidecar = files.find((f) => f.path === ownedFiles(env)[4]);
  if (config && colimaSidecar) check("/bin/sh", ["-n", colimaSidecar.source], env);
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
  requireStateFs(env);
  recoverStrandedGuard(env, { explicit: false });
  return withInstallLock(env, { explicit: false }, () => {
    const receiptRoot = path.join(stateDir(env), "installations"), receiptRootStat = lstatOrNull(receiptRoot);
    if (receiptRootStat && (!receiptRootStat.isDirectory() || receiptRootStat.isSymbolicLink())) throw new Error(`unsafe install receipts directory: ${receiptRoot}`);
    const pending = receiptRootStat ? fs.readdirSync(receiptRoot).flatMap((entry) => {
      const dir = path.join(receiptRoot, entry), receiptFile = path.join(dir, "receipt.json");
      if (!lstatOrNull(dir)?.isDirectory() || lstatOrNull(dir)?.isSymbolicLink()) return [];
      const receiptStat = lstatOrNull(receiptFile);
      if (!receiptStat?.isFile() || receiptStat.isSymbolicLink()) return [];
      const receipt = readJsonOrNull(receiptFile);
      return receipt && !["committed", "rolled-back", "recovered-preserving-conflicts"].includes(receipt.status) ? [{ id: receipt.id, file: receiptFile, status: receipt.status }] : [];
    }) : [];
    if (pending.length) throw new Error(`unfinished install transaction ${pending[0].id || "(unknown)"} (${pending[0].status}) needs recovery before another install; inspect ${pending[0].file} and run install.sh --recover ID (or --recover ID --accept-current after reviewing a conflicting edit)`);
    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
    const dir = path.join(stateDir(env), "installations", id);
    fs.mkdirSync(path.join(dir, "files"), { recursive: true, mode: 0o700 });
    const journal = { schemaVersion: 1, id, status: "prepared", ...plan, files: [] };
    const receipt = path.join(dir, "receipt.json");
    try {
      for (const [index, file] of files.entries()) {
        const { bytes, mode } = activationState(home, file.path);
        if (file.plannedBefore && ((bytes === null ? null : hash(bytes)) !== file.plannedBefore.hash || mode !== file.plannedBefore.mode))
          throw new Error(`hook changed after preflight: ${file.path}`);
        if (bytes) writeFileAtomic(path.join(dir, "files", String(index)), bytes, 0o600, { durable: true });
        journal.files.push({ index, path: file.path, createOnly: file.createOnly === true, beforeHash: bytes === null ? null : hash(bytes), beforeMode: mode,
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
      journal.rollbackRecord = recordRollback(src, env, journal, receipt, recordDir);
      saveJournal(receipt, journal); onPhase("rollback-recorded");
      for (const [index, file] of files.entries()) {
        const current = activationState(home, file.path), expected = journal.files[index];
        if (file.createOnly && (expected.beforeHash !== null || current.bytes !== null)) {
          onPhase(`file-preserved-${index}`);
          continue;
        }
        if ((current.bytes === null ? null : hash(current.bytes)) !== expected.beforeHash || current.mode !== expected.beforeMode)
          throw new Error(`activation conflict: ${file.path}`);
        // Refused pre-activation edits are not ours to restore, even when they happen to
        // match the planned output. Journal write intent only after validating the backup.
        expected.intent = true; saveJournal(receipt, journal);
        try {
          if (file.createOnly) writeFileAtomicCreateOnly(file.path, file.data, file.mode, { durable: true });
          else writeFileAtomic(file.path, file.data, file.mode, { durable: true });
        } catch (e) {
          if (!file.createOnly || e.code !== "EEXIST") throw e;
          expected.intent = false; saveJournal(receipt, journal);
          onPhase(`file-preserved-${index}`);
          continue;
        }
        onPhase(`file-${index}`);
      }
      ensureLayout(conf.internalRoot);
      const d = detect(conf, env);
      if (d.mode === "external") ensureLayout(conf.externalCache);
      onPhase("layout-ready");
      journal.status = "committed"; journal.completedAt = new Date().toISOString(); saveJournal(receipt, journal);
      return { ...plan, status: "committed", receipt, rollbackRecord: journal.rollbackRecord, mode: d.mode };
    } catch (e) {
      journal.error = e.message;
      try { restore(journal, dir, env); } catch (recovery) { journal.status = "recovery-required"; journal.recoveryError = recovery.message; saveJournal(receipt, journal); }
      throw new Error(`${e.message}; transaction ${journal.status}, recovery bytes: ${dir}`);
    }
  });
}

// Installer locks. install.lock serialises installer runs and
// install-recovery.lock is its guard. The installer releases each lock it holds by owner release inside withLock
// (Removal rule, contract 1: own fd, own token, no guard, no probe), whatever the outcome. Every removal of a file
// this run did not create is a recovery (contract 2): it holds the inode's flock through a free probe (a live probe is
// refused whatever its pid says), holds install-recovery.lock for install.lock (nothing for the guard itself), needs
// the dead-pid proof and --recover for a legacy body, and unlinks through unlinkHeld after the inode, device and
// token re-check through the held fd. An empty, unparseable or unreadable body is refused by every route.
const INSTALL_LOCK = "install", INSTALL_GUARD = "install-recovery";
const installerLockPath = (env, name) => path.join(stateDir(env), `${name}.lock`);
function installerLog(env, line) { appendLog(logPath(env), line); console.error(`install.sh: ${line}`); }
function pidDead(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try { process.kill(pid, 0); return false; } catch (e) { return e.code === "ESRCH" ? true : e.code === "EPERM" ? false : null; }
}
const liveRefusal = (name, explicit) => name === INSTALL_GUARD ? "another recovery is active; retry later; no files changed"
  : explicit ? "installer may still be alive; refusing recovery" : "install lock busy; no files changed";
const field = (v) => (v === undefined || v === null || v === "" ? "null" : String(v));
const ownerFields = (o) => `harness ${field(o?.harness)} session ${field(o?.sessionId)} event ${field(o?.event)}`;
const recoveryLine = (name, proof, o) => `${name}.lock ${proof}; owner pid ${field(o.pid)} token ${o.token} ${ownerFields(o)} acquiredAt ${field(o.acquiredAt)}`;
// Interface 1, Logging: a run that still returns locked logs `install.lock busy: owner <live|exited|legacy|unreadable>
// pid <p> harness <h> session <s> event <e>` for install.lock, or `install.lock busy: guard <live|legacy|unreadable>`
// when install-recovery.lock blocks it. `owner` is the body of the file classified (null when unreadable).
function logBusy(env, name, cls, owner) {
  if (name === INSTALL_GUARD) installerLog(env, `${INSTALL_LOCK}.lock busy: guard ${cls === "exited" ? "live" : cls}`);
  else installerLog(env, `${INSTALL_LOCK}.lock busy: owner ${cls} pid ${field(owner?.pid)} ${ownerFields(owner)}`);
}
// Classifies a file this process holds no flock on (a separate probe; it unlinks nothing). A free format-2 file is
// `exited`; a guard that is still in the way after its retry was lost to another recoverer and is reported `live`.
function classifyHeld(file) {
  const probe = probeLock(file);
  if (probe.state === "live") return { cls: "live", owner: readJsonOrNull(file) };
  if (probe.state === "absent") return { cls: "exited", owner: null };
  if (probe.state !== "free") return { cls: "unreadable", owner: null };
  try {
    let text;
    try { text = readHeldBody(probe.fd); } catch { return { cls: "unreadable", owner: null }; }
    const owner = parseBody(text);
    if (!owner) return { cls: "unreadable", owner: null };
    return { cls: owner.lockFormat === 2 ? "exited" : "legacy", owner };
  } finally { fs.closeSync(probe.fd); }
}
// Complete body: an owner record only when readHeldBody returned the whole file and that text is
// one JSON object with a non-empty string token; null for an empty, unparseable, incomplete or tokenless body.
function parseBody(text) {
  if (typeof text !== "string") return null;
  try { const o = JSON.parse(text); return o && typeof o === "object" && !Array.isArray(o) && typeof o.token === "string" && o.token ? o : null; } catch { return null; }
}
const errText = (e) => [e?.syscall, e?.code || e?.message].filter(Boolean).join(" ");
// Returns "recovered" or "absent"; throws the refusal (logged with its busy record) and leaves the file on its inode.
function recoverInstallerLock(env, name, { explicit }) {
  const file = installerLockPath(env, name), probe = probeLock(file);
  const refuse = (why, message, busy) => {
    installerLog(env, `${name}.lock recovery refused: ${why}`);
    const b = typeof busy === "function" ? busy() : busy;
    logBusy(env, name, b.cls, b.owner);
    return new Error(message);
  };
  if (probe.state === "absent") return "absent";
  if (probe.state === "live") throw refuse("owner live (lock held)", liveRefusal(name, explicit), { cls: "live", owner: readJsonOrNull(file) });
  if (probe.state !== "free") throw refuse(`unreadable (${probe.reason})`, `cannot read ${name}.lock (${probe.reason}); inspect manually; no files changed`, { cls: "unreadable", owner: null });
  try {
    let text;
    try { text = readHeldBody(probe.fd); } catch (e) {
      throw refuse(`unreadable (${errText(e)})`, `cannot read ${name}.lock (${errText(e)}); inspect manually; no files changed`, { cls: "unreadable", owner: null });
    }
    const owner = parseBody(text);
    if (!owner)
      throw refuse("empty or unparseable body", `cannot verify old ${name}.lock owner; inspect manually; no files changed`, { cls: "unreadable", owner: null });
    let line;
    if (owner.lockFormat === 2) line = recoveryLine(name, "reclaimed: owner exited (lock free)", owner);
    else {
      const legacy = { cls: "legacy", owner };
      if (!explicit) throw refuse(`owner legacy pid ${owner.pid}`, `${name}.lock has a legacy owner (pid ${owner.pid}); only install.sh --recover ID recovers it; no files changed`, legacy);
      const dead = pidDead(owner.pid);
      if (dead === false) throw refuse(`owner legacy pid ${owner.pid} alive`, liveRefusal(name, true), legacy);
      if (dead !== true) throw refuse(`owner legacy pid ${owner.pid} unverifiable`, `cannot verify old ${name}.lock owner; inspect manually; no files changed`, legacy);
      line = recoveryLine(name, "recovered explicitly (owner dead)", owner);
    }
    testStop("reclaim:before-unlink");
    // The re-check reads the complete body through the held fd (the prefix unlinkHeld passes is ignored); it runs only
    // while the path still names the probed inode, and records what it observed when it fails.
    let changed = null;
    const same = () => {
      let now;
      try { now = readHeldBody(probe.fd); } catch (e) { changed = { why: `unreadable (${errText(e)})`, busy: { cls: "unreadable", owner: null } }; return false; }
      const o = parseBody(now);
      if (!o) changed = { why: "empty or unparseable body", busy: { cls: "unreadable", owner: null } };
      else if (o.token !== owner.token) changed = { why: `token ${o.token}`, busy: { cls: o.lockFormat === 2 ? "exited" : "legacy", owner: o } };
      return !changed;
    };
    let removed;
    try { removed = unlinkHeld(file, probe.fd, same); } catch (e) {
      throw refuse(`cannot remove (${errText(e)}); owner pid ${owner.pid} token ${owner.token}`, `cannot remove ${name}.lock (${errText(e)}); inspect manually; no files changed`, { cls: owner.lockFormat === 2 ? "exited" : "legacy", owner });
    }
    // The same inode, whose body changed while this fd held its flock: probing it now would read this fd's own flock as
    // live, so the busy record names what the re-check read.
    if (!removed && changed)
      throw refuse(`body changed between probe and unlink: ${changed.why}; owner pid ${owner.pid} token ${owner.token}`, `cannot verify old ${name}.lock owner; inspect manually; no files changed`, changed.busy);
    // A replacement is another inode, so probing it does not conflict with the flock this fd holds on the old one.
    if (!removed)
      throw refuse(`replaced between probe and unlink; owner pid ${owner.pid} token ${owner.token}`, `${name}.lock was replaced during recovery and left; no files changed`, () => classifyHeld(file));
    installerLog(env, line);
    return "recovered";
  } finally { fs.closeSync(probe.fd); }
}
const unsupportedError = (name, reason) => new Error(`${name}.lock unsupported: ${reason}; no files changed`);
// Interface 1, Supported state filesystem: checked before any installer lock is recovered or created, so an
// unsupported state volume refuses with nothing unlinked. Only Darwin can take or recover a flock (probeLock reads
// unreadable and withLock refuses elsewhere; the Linux test substitute cannot be installed on Darwin).
function requireStateFs(env) {
  if (process.platform !== "darwin") return;
  const dir = stateDir(env);
  fs.mkdirSync(dir, { recursive: true });
  const check = stateFsSupported(dir, env);
  if (!check.supported) throw unsupportedError(INSTALL_LOCK, check.reason);
}
// install-recovery.lock first: a stranded guard is recovered under its own flock before anything else.
function recoverStrandedGuard(env, { explicit }) {
  if (lstatOrNull(installerLockPath(env, INSTALL_GUARD))) recoverInstallerLock(env, INSTALL_GUARD, { explicit });
}
// Runs fn holding install-recovery.lock; a guard that appeared meanwhile is recovered and acquisition retried once.
function withInstallGuard(env, { explicit }, fn) {
  const guard = installerLockPath(env, INSTALL_GUARD);
  let g = withLock(guard, fn);
  if (g.locked && !g.unsupported) { recoverInstallerLock(env, INSTALL_GUARD, { explicit }); g = withLock(guard, fn); }
  if (g.unsupported) throw unsupportedError(INSTALL_GUARD, g.unsupported);
  if (g.locked) {
    const b = classifyHeld(guard); logBusy(env, INSTALL_GUARD, b.cls, b.owner);
    throw new Error("another recovery is active or needs inspection; no files changed");
  }
  return g.result;
}
// Runs fn holding install.lock; a held lock is recovered under install-recovery.lock and acquisition retried once.
function withInstallLock(env, { explicit }, fn) {
  const lock = installerLockPath(env, INSTALL_LOCK);
  let r = withLock(lock, fn);
  if (r.locked && !r.unsupported) {
    withInstallGuard(env, { explicit }, () => recoverInstallerLock(env, INSTALL_LOCK, { explicit }));
    r = withLock(lock, fn);
  }
  if (r.unsupported) throw unsupportedError(INSTALL_LOCK, r.unsupported);
  if (r.locked) {
    const b = classifyHeld(lock); logBusy(env, INSTALL_LOCK, b.cls, b.owner);
    throw new Error(explicit ? "another installer started; retry recovery later" : "install lock busy or requires explicit recovery; no files changed");
  }
  return r.result;
}

function recover(id, env, { acceptCurrent = false, rollback = false } = {}) {
  if (!/^[A-Za-z0-9-]+$/.test(id)) throw new Error("invalid transaction ID");
  const dir = path.join(stateDir(env), "installations", id), file = path.join(dir, "receipt.json");
  const journal = readJsonOrNull(file);
  if (!journal || journal.id !== id || (rollback ? journal.status !== "committed" : ["committed", "rolled-back", "recovered-preserving-conflicts"].includes(journal.status))) throw new Error(rollback ? "no committed transaction with that ID" : "no unfinished transaction with that ID");
  requireStateFs(env);
  recoverStrandedGuard(env, { explicit: true });
  return withInstallGuard(env, { explicit: true }, () => {
    recoverInstallerLock(env, INSTALL_LOCK, { explicit: true });
    const lock = installerLockPath(env, INSTALL_LOCK);
    const r = withLock(lock, () => restore(journal, dir, env, { acceptCurrent }));
    if (r.unsupported) throw unsupportedError(INSTALL_LOCK, r.unsupported);
    if (r.locked) {
      const b = classifyHeld(lock); logBusy(env, INSTALL_LOCK, b.cls, b.owner);
      throw new Error("another installer started; retry recovery later");
    }
    return { ...r.result, receipt: file };
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const o = options(process.argv.slice(2));
    if (o.help) console.log("usage: install.sh [--dry-run] [--config [--replace-config]] [--record-dir DIR] | --recover TRANSACTION_ID [--accept-current] | --rollback TRANSACTION_ID");
    else console.log(JSON.stringify(o.rollback ? recover(o.rollback, process.env, { rollback: true }) : o.recover ? recover(o.recover, process.env, { acceptCurrent: o.acceptCurrent }) : installPackage(path.dirname(fileURLToPath(import.meta.url)), process.env, o), null, 2));
  } catch (e) { console.error(`install.sh: ${e.message}`); process.exitCode = /unknown argument|requires --config|cannot be combined|needs a transaction|--record-dir needs|--accept-current requires/.test(e.message) ? 2 : 1; }
}
