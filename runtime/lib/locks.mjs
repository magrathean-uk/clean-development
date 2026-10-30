// Recovery is explicit and requires proof that the recorded owner no longer exists. Age is not proof.
import fs from "node:fs";
import path from "node:path";
import { stateDir } from "./conf.mjs";
import { lstatOrNull, readJsonOrNull, withLock } from "./fsutil.mjs";

const NAMES = ["lifecycle", "housekeeping", "install", "lock-recovery", "install-recovery"];
export function inspectLocks(env) {
  return NAMES.map((name) => {
    const file = path.join(stateDir(env), `${name}.lock`), st = lstatOrNull(file);
    if (!st) return null;
    const owner = readJsonOrNull(file);
    let alive = null;
    if (st.isFile() && !st.isSymbolicLink() && Number.isInteger(owner?.pid) && owner.pid > 1) {
      try { process.kill(owner.pid, 0); alive = true; } catch (e) { if (e.code === "ESRCH") alive = false; }
    }
    return { name, file, owner, alive, inode: st.ino, device: st.dev };
  }).filter(Boolean);
}
export function recoverLock(env, name, { apply = false } = {}) {
  if (!["lifecycle", "housekeeping"].includes(name)) throw new Error("recover only lifecycle/housekeeping here; installer locks use install.sh --recover");
  const perform = () => {
    const l = inspectLocks(env).find((l) => l.name === name);
    if (!l) return { status: "absent", name };
    if (l.alive !== false) throw new Error("owner is alive or unverifiable; refusing lock removal");
    if (!apply) return { status: "preview", ...l };
    const st = lstatOrNull(l.file), owner = readJsonOrNull(l.file);
    if (st?.ino !== l.inode || st?.dev !== l.device || owner?.token !== l.owner?.token) throw new Error("lock ownership changed");
    fs.unlinkSync(l.file);
    return { status: "recovered", name };
  };
  if (!apply) return perform();
  const r = withLock(path.join(stateDir(env), "lock-recovery.lock"), perform);
  if (r.locked) throw new Error("another recovery owns the guard; inspect it before retrying");
  return r.result;
}
