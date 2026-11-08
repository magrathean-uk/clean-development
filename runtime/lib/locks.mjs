// Recovery is explicit and requires proof that the recorded owner no longer exists. Age is not proof.
// One exception is automatic: a lifecycle or housekeeping lock whose owner recorded a boot id (kern.bootsessionuuid)
// other than this boot's. No process from an earlier boot survives a reboot, and a pid check alone is unsafe because
// pids are reused after one. Wall-clock evidence (acquiredAt before kern.boottime) is reported but never acts: XNU
// shifts kern.boottime when the clock is set, so a forward correction makes a same-boot lock look older than boot.
import fs from "node:fs";
import path from "node:path";
import { logPath, stateDir } from "./conf.mjs";
import { appendLog, bootIdentity, children, lstatOrNull, normBootId, readJsonOrNull, withLock } from "./fsutil.mjs";

const NAMES = ["lifecycle", "housekeeping", "install", "lock-recovery", "install-recovery"];
export const RECLAIMABLE = ["lifecycle", "housekeeping"];
// Legacy records (no boot id) acquired this long before kern.boottime are reported as probably orphaned.
export const BOOT_MARGIN_MS = 5000;
export const lockFile = (env, name) => path.join(stateDir(env), `${name}.lock`);
// Recovery guards. Every recovery (this runtime, 0.6.3, a process that cannot read the boot id) holds the shared
// guard lock-recovery.lock while it checks and unlinks, so all protocols exclude one another. A process that can read
// the boot id first takes this boot's outer guard lock-recovery.<bootId>.lock; only holders of it may unlink a shared
// guard stranded by an earlier boot (or, explicitly, by a dead owner), so that guard cannot be swapped between their
// check and unlink. An outer guard stranded by a reboot has another boot's name and is never used again.
const GUARD = /^lock-recovery\.([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})\.lock$/;
export const SHARED_GUARD = "lock-recovery";
export const guardName = (boot) => { const id = normBootId(boot?.id); return id ? `lock-recovery.${id}` : null; };
export const guardFile = (env, boot) => lockFile(env, guardName(boot) || SHARED_GUARD);

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "ESRCH" ? false : null; }
}

// Proof that the owner record belongs to an earlier boot, or null. Only two valid, different boot ids prove it;
// a missing, malformed or equal id (or an unreadable current one) never does.
export function rebootProof(owner, boot) {
  if (!owner || typeof owner.token !== "string" || !owner.token) return null;
  const mine = normBootId(boot?.id), theirs = normBootId(owner.bootId);
  return mine && theirs && mine !== theirs ? "boot id changed" : null;
}

function inspectFile(file, name, boot, extra = {}) {
  const st = lstatOrNull(file);
  if (!st) return null;
  const regular = st.isFile() && !st.isSymbolicLink();
  const owner = regular ? readJsonOrNull(file) : null;
  const alive = regular ? pidAlive(owner?.pid) : null;
  const orphanedByReboot = regular ? rebootProof(owner, boot) : null;
  // A record without a valid boot id that predates kern.boottime by the wall clock: likely a reboot, possibly a
  // clock step. Report only; explicit recovery decides.
  const at = typeof owner?.acquiredAt === "string" ? Date.parse(owner.acquiredAt) : NaN;
  const legacyBeforeBoot = regular && !orphanedByReboot && !normBootId(owner?.bootId) && Number.isFinite(boot?.time) && Number.isFinite(at) && at < boot.time - BOOT_MARGIN_MS;
  return { name, file, owner, alive, inode: st.ino, device: st.dev, orphanedByReboot, reclaimable: !!orphanedByReboot && RECLAIMABLE.includes(name), legacyBeforeBoot, ...extra };
}

export function inspectLocks(env, { boot = bootIdentity(env) } = {}) {
  const current = guardName(boot), out = NAMES.map((name) => inspectFile(lockFile(env, name), name, boot));
  if (current) out.push(inspectFile(lockFile(env, current), current, boot, { guardBoot: normBootId(boot.id), staleGuard: false }));
  let entries;
  try { entries = children(stateDir(env), 5000, { requireComplete: true }); } catch {
    out.push({ name: "lock-recovery.*", file: path.join(stateDir(env), "lock-recovery.*.lock"), owner: null, alive: null, inspectionIncomplete: true });
    entries = [];
  }
  for (const m of entries.map((d) => GUARD.exec(d.name)).filter(Boolean).sort((x, y) => x[0].localeCompare(y[0])))
    // Without this boot's id no outer guard can be called an earlier boot's: report it as unknown, never as harmless.
    if (m[1] !== normBootId(boot?.id)) out.push(inspectFile(path.join(stateDir(env), m[0]), m[0].slice(0, -5), boot, current ? { guardBoot: m[1], staleGuard: true } : { guardBoot: m[1], guardUnknown: true }));
  return out.filter(Boolean);
}
const inspectOne = (env, name, boot) => inspectFile(lockFile(env, name), name, boot);

// Removes the observed lock only while holding this boot's recovery guard and only if it is still the same file
// (inode, device, token) with the same reboot proof. Returns { status: "reclaimed" | "absent" | "refused", ... } and
// never throws for a refusal, so a hook falls back to the existing "lifecycle lock busy" path.
const defaultLog = (env) => (m) => appendLog(logPath(env), m);
// Unlinks file only if it is still the regular file observed (inode, device, token) and accept(owner) holds.
function unlinkObserved(observed, accept) {
  const st = lstatOrNull(observed.file);
  if (!st) return { status: "absent" };
  const owner = st.isFile() && !st.isSymbolicLink() ? readJsonOrNull(observed.file) : null;
  if (st.ino !== observed.inode || st.dev !== observed.device || typeof owner?.token !== "string" || owner.token !== observed.owner?.token)
    return { status: "refused", reason: "lock ownership changed" };
  const why = accept(owner);
  if (!why) return { status: "refused", reason: "proof no longer holds", owner };
  fs.unlinkSync(observed.file);
  return { status: "removed", owner, why };
}
// Runs fn holding the outer guard (when the boot id is readable) and the shared guard; a shared guard whose owner
// recorded another boot's id is reclaimed under the outer guard first. Returns withLock's { locked, result }.
function withRecoveryGuards(env, boot, fn, log) {
  const shared = lockFile(env, SHARED_GUARD), outer = guardName(boot);
  const takeShared = () => {
    const r = withLock(shared, fn, { boot });
    if (!r.locked || !outer) return r;
    const g = inspectFile(shared, SHARED_GUARD, boot);
    if (!g?.orphanedByReboot) return r;
    const u = unlinkObserved(g, (owner) => rebootProof(owner, boot));
    if (u.status === "removed") log(`${SHARED_GUARD}.lock reclaimed: orphaned by reboot (${u.why}); owner pid ${u.owner.pid} token ${u.owner.token} bootId ${u.owner.bootId}; current bootId ${normBootId(boot.id)}`);
    return u.status === "refused" ? r : withLock(shared, fn, { boot });
  };
  if (!outer) return takeShared();
  const o = withLock(lockFile(env, outer), takeShared, { boot });
  return o.locked ? o : o.result;
}

export function reclaimOrphanedLock(env, observed, { boot = bootIdentity(env), log = defaultLog(env) } = {}) {
  if (!observed || !RECLAIMABLE.includes(observed.name)) return { status: "refused", reason: "not a reclaimable lock" };
  if (!observed.orphanedByReboot || !normBootId(boot?.id)) return { status: "refused", reason: "no reboot proof" };
  const guard = withRecoveryGuards(env, boot, () => {
    const u = unlinkObserved(observed, (owner) => rebootProof(owner, boot));
    if (u.status === "absent") return { status: "absent", name: observed.name };
    if (u.status === "refused") return { status: "refused", reason: u.reason === "lock ownership changed" ? u.reason : "reboot proof no longer holds" };
    log(`${observed.name}.lock reclaimed: orphaned by reboot (${u.why}); owner pid ${u.owner.pid} token ${u.owner.token} acquiredAt ${u.owner.acquiredAt ?? "unknown"} bootId ${u.owner.bootId}; current bootId ${normBootId(boot.id)} bootTime ${Number.isFinite(boot?.time) ? new Date(boot.time).toISOString() : "unknown"}`);
    return { status: "reclaimed", name: observed.name, proof: u.why, owner: u.owner };
  }, log);
  return guard.locked ? { status: "refused", reason: "another recovery owns the guard" } : guard.result;
}

// withLock for the lifecycle/housekeeping locks: when the lock is held by an owner from an earlier boot, reclaim it
// under the recovery guard and try once more. Every other held lock (live, same-boot dead, unverifiable, legacy) is
// returned as locked with recoveryRequired, exactly as withLock does.
export function withReclaimableLock(env, name, fn, { boot = bootIdentity(env), log } = {}) {
  if (!RECLAIMABLE.includes(name)) throw new Error(`${name} lock is not reclaimable`);
  const first = withLock(lockFile(env, name), fn, { boot });
  if (!first.locked) return first;
  const observed = inspectOne(env, name, boot);
  if (!observed?.reclaimable) return first;
  const reclaim = reclaimOrphanedLock(env, observed, { boot, ...(log ? { log } : {}) });
  if (reclaim.status !== "reclaimed" && reclaim.status !== "absent") return { ...first, reclaim };
  return { ...withLock(lockFile(env, name), fn, { boot }), reclaim };
}
export const withLifecycleLock = (env, fn, options) => withReclaimableLock(env, "lifecycle", fn, options);

// Explicit recovery. lifecycle/housekeeping: a provably dead owner or another boot's id, under both guards.
// lock-recovery (the shared guard itself): needs a readable boot id and only this boot's outer guard, since every
// other remover of a foreign shared guard holds that outer guard too.
export function recoverLock(env, name, { apply = false, boot = bootIdentity(env), log = defaultLog(env) } = {}) {
  if (![...RECLAIMABLE, SHARED_GUARD].includes(name)) throw new Error("recover only lifecycle/housekeeping/lock-recovery here; installer locks use install.sh --recover");
  const outer = guardName(boot);
  if (name === SHARED_GUARD && !outer) throw new Error("boot identity unreadable; cannot fence shared-guard recovery");
  const perform = () => {
    const l = inspectOne(env, name, boot);
    if (!l) return { status: "absent", name };
    if (l.alive !== false && !l.orphanedByReboot) throw new Error("owner is alive or unverifiable; refusing lock removal");
    if (!apply) return { status: "preview", ...l };
    const u = unlinkObserved(l, (owner) => rebootProof(owner, boot) || (pidAlive(owner.pid) === false ? "owner dead" : null));
    if (u.status === "refused") throw new Error(u.reason === "lock ownership changed" ? "lock ownership changed" : "owner is alive or unverifiable; refusing lock removal");
    if (u.status === "removed") log(`${name}.lock recovered explicitly (${u.why}); owner pid ${u.owner.pid} token ${u.owner.token}`);
    return { status: "recovered", name };
  };
  if (!apply) return perform();
  const r = name === SHARED_GUARD ? withLock(lockFile(env, outer), perform, { boot }) : withRecoveryGuards(env, boot, perform, log);
  if (r.locked) throw new Error("another recovery owns the guard; inspect it before retrying");
  return r.result;
}
