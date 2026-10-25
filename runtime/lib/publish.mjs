// Promote a regular file to durable storage without deleting its source or clobbering a destination.
// Destination-side copy + verification + atomic hard-link publication works across source devices.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { homeDir, stateDir } from "./conf.mjs";
import { canonicalLocation, createLease, updateLease } from "./leases.mjs";
import { canonicalPath, lstatOrNull, safeDirectory, strictlyBelow, syncDirectory, withLock, writeFileAtomic } from "./fsutil.mjs";
import { findProjectRoot, loadProjectConfig } from "./project.mjs";

const digest = (p) => {
  const h = createHash("sha256"), buf = Buffer.alloc(1024 * 1024), fd = fs.openSync(p, "r");
  try { let n; while ((n = fs.readSync(fd, buf, 0, buf.length, null))) h.update(buf.subarray(0, n)); } finally { fs.closeSync(fd); }
  return h.digest("hex");
};

export function publishFile(conf, env, source, destination, { kind = "evidence", apply = false, onPhase = () => {},
  temporaryRoots = [env.TMPDIR, "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"] } = {}) {
  if (!conf.valid) throw new Error("invalid storage configuration");
  if (!["work", "evidence"].includes(kind)) throw new Error("kind must be work or evidence");
  source = canonicalLocation(source); destination = canonicalLocation(destination);
  const st = lstatOrNull(source);
  if (!st?.isFile() || st.isSymbolicLink()) throw new Error("publication source must be a regular file, not a link");
  for (const disposable of [conf.internalRoot, conf.externalCache, env.CLEAN_DEV_SCRATCH, env.CLEAN_DEV_BUILDS, ...temporaryRoots].filter(Boolean)) {
    const p = canonicalPath(disposable) || canonicalLocation(disposable);
    if (destination === p || strictlyBelow(p, destination)) throw new Error("publication destination must be durable, outside cache and temporary storage");
  }
  const project = findProjectRoot(path.dirname(destination), homeDir(env)), pc = loadProjectConfig(project);
  for (const rel of [...(pc?.config?.buildDirs || []), ...(pc?.config?.depDirs || [])]) {
    const disposable = canonicalLocation(path.join(project, rel));
    if (destination === disposable || strictlyBelow(disposable, destination)) throw new Error("publication destination is a declared disposable project directory");
  }
  const plan = { schemaVersion: 1, id: randomUUID(), kind, source, destination, bytes: st.size, mode: st.mode & 0o777 };
  if (!apply) return { ...plan, sourceDigest: digest(source), status: "preview" };
  const lock = path.join(stateDir(env), "lifecycle.lock");
  const acquired = withLock(lock, () => createLease(conf, env, [source], { owner: `publication ${plan.id}`, publicationId: plan.id }));
  if (acquired.locked) throw new Error("lifecycle locked; source lease was not acquired, publication not started");
  let record, receipt, succeeded = false;
  try {
    const dir = path.join(stateDir(env), "publications");
    if (!safeDirectory(stateDir(env), dir, { missingAnchor: true })) throw new Error("unsafe publication registry");
    receipt = path.join(dir, `${plan.id}.json`);
    record = { ...plan, sourceDigest: digest(source), sourceLease: acquired.result.id, status: "prepared", createdAt: new Date().toISOString() };
    const save = () => writeFileAtomic(receipt, JSON.stringify(record, null, 2) + "\n", 0o600, { durable: true });
    save();
    const tmp = path.join(path.dirname(destination), `.cd-publish-${plan.id}`);
    try {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, tmp, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(tmp, plan.mode);
      const fd = fs.openSync(tmp, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      onPhase("copied");
      const current = fs.statSync(source);
      if (current.ino !== st.ino || current.dev !== st.dev || current.size !== st.size || current.mtimeMs !== st.mtimeMs
        || digest(tmp) !== record.sourceDigest || digest(source) !== record.sourceDigest) throw new Error("source changed during publication; original retained");
      try { fs.linkSync(tmp, destination); } catch (e) {
        const dest = lstatOrNull(destination);
        if (e.code !== "EEXIST" || !dest?.isFile() || dest.isSymbolicLink() || digest(destination) !== record.sourceDigest || (dest.mode & 0o777) !== plan.mode) throw e;
      }
      syncDirectory(path.dirname(destination));
      onPhase("published");
      record.status = "completed"; record.destinationDigest = digest(destination); record.completedAt = new Date().toISOString(); save();
      // Removing this extra link is not part of publication success; never mask a completed receipt.
      try { fs.unlinkSync(tmp); } catch { record.recoveryCopy = tmp; save(); }
      succeeded = true;
      return { ...record, receipt };
    } catch (e) {
      record.status = "failed"; record.error = e.code || e.message; record.recoveryCopy = lstatOrNull(tmp) ? tmp : null; save();
      throw new Error(`publication failed (${record.error}); source retained; receipt ${receipt}`);
    }
  } catch (e) {
    throw new Error(`${e.message}; source held by lease ${acquired.result.id} until explicit recovery`);
  } finally {
    // Pending/failed publication is unique unfinished work, not an expiring consumer job. Even
    // parent death or a multi-hour copy cannot expose its sole source to retention cleanup.
    if (succeeded) try { withLock(lock, () => updateLease(env, acquired.result.id, { release: true, recoveryConfirmed: true })); } catch { /* durable hold remains; inspect sourceLease */ }
  }
}
