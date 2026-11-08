// A lifecycle/housekeeping lock orphaned by a reboot is reclaimed automatically and atomically; nothing else is.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sim, hook, cli } from "./helpers.mjs";
import { stateDir } from "../runtime/lib/conf.mjs";
import { bootIdentity, normBootId, parseDarwinBoot, readJsonOrNull, withLock, writeFileAtomic } from "../runtime/lib/fsutil.mjs";
import { guardFile, inspectLocks, rebootProof, reclaimOrphanedLock, recoverLock, withLifecycleLock, withReclaimableLock } from "../runtime/lib/locks.mjs";
import { doctor } from "../runtime/lib/doctor.mjs";

const OLD = "11111111-1111-4111-8111-111111111111", NOW = "22222222-2222-4222-8222-222222222222";
const BOOT_TIME = Date.parse("2025-06-01T14:14:08.158Z");
const boot = { id: NOW, time: BOOT_TIME };
const deadPid = () => { const c = spawnSync(process.execPath, ["-e", ""]); assert.equal(c.status, 0); return c.pid; };
const lockOf = (s, name = "lifecycle") => path.join(stateDir(s.env), `${name}.lock`);
const put = (file, owner) => { writeFileAtomic(file, JSON.stringify(owner)); return fs.lstatSync(file).ino; };
const preBoot = { acquiredAt: "2025-06-01T14:12:11.278Z" }, sameBoot = { acquiredAt: "2025-06-01T14:20:00.000Z" };
const logOf = (s) => { try { return fs.readFileSync(path.join(stateDir(s.env), "hook.log"), "utf8"); } catch { return ""; } };
const nolog = () => {};

test("boot identity parses sysctl output deterministically and only canonical UUIDs count", () => {
  assert.deepEqual(parseDarwinBoot(`c8b15f4d-a17b-415d-ab7b-70c5c4324ed3\n{ sec = 1748787248, usec = 158203 } Sun Jun  1 14:14:08 2025\n`),
    { id: "C8B15F4D-A17B-415D-AB7B-70C5C4324ED3", time: 1748787248158 });
  assert.deepEqual(parseDarwinBoot("\n\n"), { id: null, time: null }, "sandboxed sysctl prints nothing");
  assert.deepEqual(parseDarwinBoot("unreadable\n{ sec = x }"), { id: null, time: null });
  for (const bad of ["unreadable", "", " ", "1111", `${OLD}x`, `{${OLD}}`, 42, null, undefined]) assert.equal(normBootId(bad), null, String(bad));
  assert.equal(normBootId(` ${OLD.toLowerCase()}\n`), OLD);
  assert.deepEqual(bootIdentity({ DEV_STORAGE_VOLUME_TEST: "absent", CLEAN_DEV_TEST_BOOT: JSON.stringify(boot) }), boot);
  assert.deepEqual(bootIdentity({ DEV_STORAGE_VOLUME_TEST: "absent", CLEAN_DEV_TEST_BOOT: JSON.stringify({ id: "unreadable", time: 5 }) }), { id: null, time: 5 });
  assert.deepEqual(bootIdentity({ DEV_STORAGE_VOLUME_TEST: "absent", CLEAN_DEV_TEST_BOOT: "unknown" }), { id: null, time: null });
  // The override is test mode only.
  assert.deepEqual(bootIdentity({ CLEAN_DEV_TEST_BOOT: JSON.stringify(boot) }), bootIdentity({}));
});

test("withLock records the canonical boot id and time", () => {
  const s = sim({ mounted: false }), lock = lockOf(s);
  let seen;
  withLock(lock, () => { seen = readJsonOrNull(lock); }, { boot: { id: NOW.toLowerCase(), time: BOOT_TIME } });
  assert.equal(seen.bootId, NOW); assert.equal(seen.bootTime, new Date(BOOT_TIME).toISOString());
  assert.equal(seen.pid, process.pid); assert.equal(typeof seen.token, "string");
  withLock(lock, () => { seen = readJsonOrNull(lock); }, { boot: { id: "garbage", time: null } });
  assert.equal(seen.bootId, null); assert.equal(seen.bootTime, null);
  assert.equal(fs.existsSync(lock), false);
});

// Host smoke test: a sandbox may hide kern.bootsessionuuid; unreadable identity is supported behaviour, not a failure.
test("this Mac's boot identity, when readable", (t) => {
  const b = bootIdentity({});
  if (process.platform !== "darwin" || !b.id) { t.skip("boot identity unreadable here"); return; }
  assert.equal(normBootId(b.id), b.id);
  assert.ok(b.time > Date.parse("2020-01-01") && b.time <= Date.now());
});

test("rebootProof: only two valid, different boot ids prove a reboot; wall-clock age never does", () => {
  assert.equal(rebootProof({ token: "t", bootId: OLD }, boot), "boot id changed");
  assert.equal(rebootProof({ token: "t", bootId: OLD.toLowerCase() }, boot), "boot id changed");
  assert.equal(rebootProof({ token: "t", bootId: NOW.toLowerCase(), ...preBoot }, boot), null, "same boot, any case");
  assert.equal(rebootProof({ token: "t", bootId: OLD }, { id: null, time: BOOT_TIME }), null, "current id unreadable");
  assert.equal(rebootProof({ token: "t", bootId: OLD }, { id: "unreadable", time: BOOT_TIME }), null, "current id malformed");
  for (const bootId of ["unreadable", "x", "", null, 7, { a: 1 }]) assert.equal(rebootProof({ token: "t", bootId, ...preBoot }, boot), null, String(bootId));
  assert.equal(rebootProof({ token: "t", ...preBoot }, boot), null, "legacy acquiredAt before kern.boottime is not proof");
  assert.equal(rebootProof({ bootId: OLD }, boot), null, "no token, no proof");
  assert.equal(rebootProof({ token: "", bootId: OLD }, boot), null);
  assert.equal(rebootProof(null, boot), null);
});

test("a lock recorded in an earlier boot is reclaimed even when its pid is reused, and the reclaim is logged", () => {
  const s = sim({ mounted: false }), lock = lockOf(s);
  put(lock, { pid: process.pid, token: "old-boot", bootId: OLD, ...preBoot });
  const [l] = inspectLocks(s.env, { boot });
  assert.equal(l.alive, true); assert.equal(l.orphanedByReboot, "boot id changed"); assert.equal(l.reclaimable, true);
  let ran = false, inside;
  const r = withLifecycleLock(s.env, () => { ran = true; inside = readJsonOrNull(lock); return 42; }, { boot });
  assert.equal(r.locked, false); assert.equal(r.result, 42); assert.equal(ran, true);
  assert.equal(r.reclaim.status, "reclaimed"); assert.equal(r.reclaim.owner.token, "old-boot");
  assert.equal(inside.bootId, NOW); assert.notEqual(inside.token, "old-boot");
  assert.equal(fs.existsSync(lock), false);
  assert.equal(fs.existsSync(guardFile(s.env, boot)), false, "guard released");
  assert.equal(path.basename(guardFile(s.env, boot)), `lock-recovery.${NOW}.lock`);
  assert.match(logOf(s), /lifecycle\.lock reclaimed: orphaned by reboot \(boot id changed\); owner pid \d+ token old-boot .*bootId 11111111/);
});

test("a legacy record acquired before this boot is reported, not reclaimed; explicit recovery works", () => {
  const s = sim({ mounted: false }), lock = lockOf(s);
  put(lock, { pid: deadPid(), token: "legacy", ...preBoot });
  const [l] = inspectLocks(s.env, { boot });
  assert.equal(l.legacyBeforeBoot, true); assert.equal(l.orphanedByReboot, null); assert.equal(l.reclaimable, false);
  const r = withLifecycleLock(s.env, () => assert.fail("must not run"), { boot, log: nolog });
  assert.equal(r.locked, true); assert.equal(r.recoveryRequired, true); assert.equal(readJsonOrNull(lock).token, "legacy");
  assert.equal(recoverLock(s.env, "lifecycle", { apply: true, boot }).status, "recovered");
  assert.equal(fs.existsSync(lock), false);
});

test("a malformed recorded boot id never proves a reboot, even with a live pid", () => {
  const s = sim({ mounted: false }), lock = lockOf(s);
  put(lock, { pid: process.pid, token: "bad-id", bootId: "unreadable", ...preBoot });
  assert.equal(inspectLocks(s.env, { boot })[0].reclaimable, false);
  assert.equal(withLifecycleLock(s.env, () => assert.fail("must not run"), { boot, log: nolog }).locked, true);
  assert.throws(() => recoverLock(s.env, "lifecycle", { apply: true, boot }), /alive/);
  assert.equal(readJsonOrNull(lock).token, "bad-id");
});

test("the housekeeping lock is reclaimable too; installer locks are not", () => {
  const s = sim({ mounted: false });
  put(lockOf(s, "housekeeping"), { pid: process.pid, token: "hk", bootId: OLD });
  assert.equal(withReclaimableLock(s.env, "housekeeping", () => 1, { boot, log: nolog }).result, 1);
  const install = lockOf(s, "install");
  put(install, { pid: deadPid(), token: "inst", bootId: OLD, ...preBoot });
  const l = inspectLocks(s.env, { boot }).find((x) => x.name === "install");
  assert.equal(l.orphanedByReboot, "boot id changed"); assert.equal(l.reclaimable, false);
  assert.throws(() => withReclaimableLock(s.env, "install", () => 1, { boot }), /not reclaimable/);
  assert.equal(reclaimOrphanedLock(s.env, l, { boot, log: nolog }).status, "refused");
  assert.throws(() => recoverLock(s.env, "install", { apply: true, boot }), /installer locks/);
  assert.equal(withLock(install, () => assert.fail("installer lock must hold"), { boot }).locked, true);
  assert.equal(readJsonOrNull(install).token, "inst");
});

test("a dead owner from this boot still needs explicit recovery (boot id and legacy records)", () => {
  for (const owner of [{ bootId: NOW, ...preBoot }, { ...sameBoot }]) {
    const s = sim({ mounted: false }), lock = lockOf(s);
    put(lock, { pid: deadPid(), token: "same-boot", ...owner });
    const [l] = inspectLocks(s.env, { boot });
    assert.equal(l.alive, false); assert.equal(l.orphanedByReboot, null); assert.equal(l.reclaimable, false);
    const r = withLifecycleLock(s.env, () => assert.fail("must not run"), { boot, log: nolog });
    assert.equal(r.locked, true); assert.equal(r.recoveryRequired, true); assert.equal(r.reclaim, undefined);
    assert.equal(readJsonOrNull(lock).token, "same-boot");
    assert.equal(recoverLock(s.env, "lifecycle", { boot }).status, "preview");
    assert.equal(recoverLock(s.env, "lifecycle", { apply: true, boot }).status, "recovered");
    assert.equal(fs.existsSync(lock), false);
  }
});

test("a live owner from this boot is untouched, as is a legacy pre-boot record whose pid is live", () => {
  for (const owner of [{ bootId: NOW, ...sameBoot }, { ...sameBoot }, { ...preBoot }]) {
    const s = sim({ mounted: false }), lock = lockOf(s);
    const ino = put(lock, { pid: process.pid, token: "live", ...owner });
    const r = withLifecycleLock(s.env, () => assert.fail("must not run"), { boot, log: nolog });
    assert.equal(r.locked, true);
    assert.equal(fs.lstatSync(lock).ino, ino); assert.equal(readJsonOrNull(lock).token, "live");
    assert.throws(() => recoverLock(s.env, "lifecycle", { apply: true, boot }), /alive/);
    const [l] = inspectLocks(s.env, { boot });
    assert.equal(l.legacyBeforeBoot, !owner.bootId && owner.acquiredAt === preBoot.acquiredAt);
  }
});

test("an unreadable current boot id never proves a reboot for a record that has one", () => {
  const s = sim({ mounted: false }), lock = lockOf(s);
  put(lock, { pid: deadPid(), token: "t", bootId: OLD, ...preBoot });
  const r = withLifecycleLock(s.env, () => assert.fail("must not run"), { boot: { id: null, time: BOOT_TIME }, log: nolog });
  assert.equal(r.locked, true); assert.ok(fs.existsSync(lock));
});

test("reclaim refuses when the lock was replaced (token or inode) or the recovery guard is held", () => {
  const s = sim({ mounted: false }), lock = lockOf(s);
  put(lock, { pid: process.pid, token: "stale", bootId: OLD });
  const observed = inspectLocks(s.env, { boot })[0];
  // Another process reclaimed it and took the lock in this boot: new token, new inode.
  fs.unlinkSync(lock); put(lock, { pid: process.pid, token: "fresh", bootId: NOW });
  assert.deepEqual(reclaimOrphanedLock(s.env, observed, { boot, log: nolog }), { status: "refused", reason: "lock ownership changed" });
  assert.equal(readJsonOrNull(lock).token, "fresh");
  // Same token rewritten through a new inode (a replacement, not the observed file).
  fs.unlinkSync(lock); put(lock, { pid: process.pid, token: "stale", bootId: OLD });
  assert.equal(reclaimOrphanedLock(s.env, observed, { boot, log: nolog }).reason, "lock ownership changed");
  assert.ok(fs.existsSync(lock));
  // Same inode, rewritten in place with a new token.
  const again = inspectLocks(s.env, { boot })[0];
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "rewritten", bootId: OLD }));
  assert.equal(fs.lstatSync(lock).ino, again.inode);
  assert.equal(reclaimOrphanedLock(s.env, again, { boot, log: nolog }).reason, "lock ownership changed");
  // Proof re-checked under the guard: same file, but now it carries this boot's id.
  const third = inspectLocks(s.env, { boot })[0];
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "rewritten", bootId: NOW }));
  assert.equal(reclaimOrphanedLock(s.env, third, { boot, log: nolog }).reason, "reboot proof no longer holds");
  // A held recovery guard (any owner) refuses; the lock stays.
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "rewritten", bootId: OLD }));
  const fourth = inspectLocks(s.env, { boot })[0];
  put(guardFile(s.env, boot), { pid: process.pid, token: "guard", bootId: NOW });
  const r = withLifecycleLock(s.env, () => assert.fail("must not run"), { boot, log: nolog });
  assert.equal(r.locked, true); assert.equal(r.reclaim.reason, "another recovery owns the guard");
  assert.equal(reclaimOrphanedLock(s.env, fourth, { boot, log: nolog }).reason, "another recovery owns the guard");
  assert.ok(fs.existsSync(lock)); assert.equal(readJsonOrNull(guardFile(s.env, boot)).token, "guard");
  // A symlinked lock is never reclaimable.
  fs.unlinkSync(lock); fs.unlinkSync(guardFile(s.env, boot));
  const target = path.join(s.root, "elsewhere.json"); fs.writeFileSync(target, JSON.stringify({ pid: process.pid, token: "x", bootId: OLD }));
  fs.symlinkSync(target, lock);
  assert.equal(inspectLocks(s.env, { boot })[0].reclaimable, false);
  assert.equal(withLifecycleLock(s.env, () => assert.fail("must not run"), { boot, log: nolog }).locked, true);
  assert.ok(fs.existsSync(target));
});

test("doctor names the reboot reason and reclaims nothing; SessionStart then registers through the reclaim", () => {
  const s = sim({ mounted: false }), lock = lockOf(s);
  s.env.CLEAN_DEV_TEST_BOOT = JSON.stringify(boot);
  put(lock, { pid: deadPid(), token: "old-boot", bootId: OLD, ...preBoot });
  const row = doctor(s.env, { gui: false }).results.find((x) => x.name === "cleanup locks");
  assert.equal(row.ok, true); assert.equal(row.warn, true);
  assert.match(row.detail, /lifecycle: orphaned by reboot \(boot id changed\); auto-reclaimed on next lifecycle run/);
  assert.equal(readJsonOrNull(lock).token, "old-boot");
  const r = hook(s, "session-start", "claude", { session_id: "aaaaaaaa-bbbb-4ccc-8ddd-0123456789ab", cwd: s.home, source: "startup" });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /registration\/cleanup failed/);
  assert.equal(fs.existsSync(lock), false);
  assert.ok(fs.existsSync(path.join(s.sessions, "c-0123456789ab.mode"))); assert.ok(fs.existsSync(path.join(s.sessions, "c-0123456789ab.json")));
  assert.match(logOf(s), /lifecycle\.lock reclaimed: orphaned by reboot \(boot id changed\)/);
  const after = doctor(s.env, { gui: false }).results.find((x) => x.name === "cleanup locks");
  assert.equal(after.detail, "none held");
});

test("a reboot during a recovery hold strands nothing: earlier-boot guards are ignored or reclaimed", () => {
  const s = sim({ mounted: false }), lock = lockOf(s), oldBoot = { id: OLD, time: BOOT_TIME - 86400000 };
  s.env.CLEAN_DEV_TEST_BOOT = JSON.stringify(boot);
  // The earlier boot died holding its outer guard, the shared guard and the lifecycle lock (pids reused since).
  const oldOuter = guardFile(s.env, oldBoot), sharedGuard = lockOf(s, "lock-recovery");
  put(oldOuter, { pid: process.pid, token: "old-outer", bootId: OLD });
  put(sharedGuard, { pid: process.pid, token: "old-shared", bootId: OLD });
  put(lock, { pid: process.pid, token: "old-lifecycle", bootId: OLD });
  assert.notEqual(oldOuter, guardFile(s.env, boot));
  const row = doctor(s.env, { gui: false }).results.find((x) => x.name === "cleanup locks");
  assert.equal(row.ok, true, row.detail); assert.equal(row.warn, true);
  assert.match(row.detail, /lifecycle: orphaned by reboot \(boot id changed\); auto-reclaimed on next lifecycle run/);
  assert.match(row.detail, /lock-recovery: orphaned by reboot \(boot id changed\); reclaimed by the next recovery/);
  assert.match(row.detail, new RegExp(`lock-recovery\\.${OLD}: outer guard of earlier boot ${OLD}; never used again, harmless`));
  const r = hook(s, "session-start", "claude", { session_id: "aaaaaaaa-bbbb-4ccc-8ddd-0123456789ab", cwd: s.home, source: "startup" });
  assert.equal(r.status, 0, r.stderr); assert.doesNotMatch(r.stdout, /registration\/cleanup failed/);
  assert.equal(fs.existsSync(lock), false); assert.equal(fs.existsSync(sharedGuard), false);
  assert.match(logOf(s), /lock-recovery\.lock reclaimed: orphaned by reboot \(boot id changed\); owner pid \d+ token old-shared/);
  assert.equal(readJsonOrNull(oldOuter).token, "old-outer", "the earlier boot's outer guard is reported, not deleted");
  // A same-boot dead lock still needs explicit recovery, which takes this boot's guards and so is not blocked.
  put(lock, { pid: deadPid(), token: "same", bootId: NOW });
  assert.equal(recoverLock(s.env, "lifecycle", { apply: true }).status, "recovered");
});

test("every recovery protocol shares lock-recovery.lock: 0.6.3 and unreadable-boot recoveries exclude reclaim", () => {
  const s = sim({ mounted: false }), lock = lockOf(s), sharedGuard = lockOf(s, "lock-recovery");
  put(lock, { pid: process.pid, token: "old", bootId: OLD });
  // A 0.6.3 (or unreadable-boot) recovery is running: it holds only the shared guard.
  put(sharedGuard, { pid: process.pid, token: "v063", acquiredAt: new Date().toISOString() });
  const observed = inspectLocks(s.env, { boot })[0];
  assert.deepEqual(reclaimOrphanedLock(s.env, observed, { boot, log: nolog }), { status: "refused", reason: "another recovery owns the guard" });
  assert.equal(withLifecycleLock(s.env, () => assert.fail("must not run"), { boot, log: nolog }).locked, true);
  assert.throws(() => recoverLock(s.env, "lifecycle", { apply: true, boot, log: nolog }), /another recovery owns the guard/);
  assert.equal(readJsonOrNull(lock).token, "old"); assert.equal(fs.existsSync(guardFile(s.env, boot)), false, "outer guard released");
  fs.unlinkSync(sharedGuard);
  // Conversely, while a reclaimer checks and unlinks, both guards are held: a 0.6.3 recovery (shared guard only)
  // and an unreadable-boot recovery are locked out at that moment.
  const seen = [];
  const r = withLifecycleLock(s.env, () => "ran", { boot, log: () => {
    seen.push(fs.existsSync(guardFile(s.env, boot)), fs.existsSync(sharedGuard));
    seen.push(withLock(sharedGuard, () => assert.fail("0.6.3 recovery must be excluded"), { boot: { id: null, time: null } }).locked);
    assert.throws(() => recoverLock(s.env, "lifecycle", { apply: true, boot: { id: null, time: null }, log: nolog }), /another recovery owns the guard/);
  } });
  assert.deepEqual(seen, [true, true, true]); assert.equal(r.result, "ran");
  assert.equal(fs.existsSync(sharedGuard), false); assert.equal(fs.existsSync(guardFile(s.env, boot)), false);
  // An unreadable boot id falls back to the shared guard alone and never reclaims automatically.
  put(lock, { pid: process.pid, token: "old2", bootId: OLD });
  assert.equal(withLifecycleLock(s.env, () => assert.fail("must not run"), { boot: { id: null, time: BOOT_TIME }, log: nolog }).locked, true);
  assert.equal(readJsonOrNull(lock).token, "old2");
});

test("a shared guard stranded without a boot id blocks reclaim until explicit recovery; doctor names the route", () => {
  const s = sim({ mounted: false }), lock = lockOf(s), sharedGuard = lockOf(s, "lock-recovery");
  s.env.CLEAN_DEV_TEST_BOOT = JSON.stringify(boot);
  put(lock, { pid: process.pid, token: "old", bootId: OLD });
  put(sharedGuard, { pid: deadPid(), token: "v063-dead", ...preBoot });
  const row = doctor(s.env, { gui: false }).results.find((x) => x.name === "cleanup locks");
  assert.equal(row.ok, false);
  assert.match(row.detail, /lifecycle: orphaned by reboot \(boot id changed\); auto-reclaim blocked by lock-recovery/);
  assert.match(row.detail, /lock-recovery: dead owner acquired before this boot by the wall clock .*explicit recovery: clean-development locks --recover lock-recovery --apply/);
  assert.equal(withLifecycleLock(s.env, () => assert.fail("must not run"), { boot, log: nolog }).locked, true);
  assert.throws(() => recoverLock(s.env, "lock-recovery", { apply: true, boot: { id: null, time: null } }), /boot identity unreadable/);
  assert.equal(recoverLock(s.env, "lock-recovery", { boot }).status, "preview");
  assert.equal(recoverLock(s.env, "lock-recovery", { apply: true, boot, log: nolog }).status, "recovered");
  assert.equal(withLifecycleLock(s.env, () => "ok", { boot, log: nolog }).result, "ok");
  // A live shared guard is never removed explicitly.
  put(sharedGuard, { pid: process.pid, token: "live", bootId: NOW });
  assert.throws(() => recoverLock(s.env, "lock-recovery", { apply: true, boot }), /alive/);
  assert.throws(() => recoverLock(s.env, "install", { apply: true, boot }), /installer locks/);
});

test("this boot's outer guard is inspected even when the state directory listing is truncated", () => {
  const s = sim({ mounted: false }), dir = stateDir(s.env);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 5001; i++) fs.writeFileSync(path.join(dir, `filler-${i}`), "");
  put(lockOf(s), { pid: process.pid, token: "old", bootId: OLD });
  put(guardFile(s.env, boot), { pid: deadPid(), token: "dead-outer", bootId: NOW });
  const locks = inspectLocks(s.env, { boot });
  assert.ok(locks.some((l) => l.inspectionIncomplete));
  assert.ok(locks.some((l) => l.name === `lock-recovery.${NOW}` && l.alive === false && !l.staleGuard));
  s.env.CLEAN_DEV_TEST_BOOT = JSON.stringify(boot);
  const row = doctor(s.env, { gui: false }).results.find((x) => x.name === "cleanup locks");
  assert.equal(row.ok, false);
  assert.match(row.detail, new RegExp(`auto-reclaim blocked by lock-recovery\\.${NOW}`));
  assert.match(row.detail, /dead\/unverifiable owner of this boot's outer recovery guard/);
  assert.match(row.detail, /state directory over 5000 entries/);
  assert.equal(withLifecycleLock(s.env, () => assert.fail("must not run"), { boot, log: nolog }).reclaim.reason, "another recovery owns the guard");
});

test("doctor still fails a same-boot dead owner and legacy pre-boot records; SessionStart reports the failure", () => {
  const s = sim({ mounted: false }), lock = lockOf(s);
  s.env.CLEAN_DEV_TEST_BOOT = JSON.stringify(boot);
  put(lock, { pid: deadPid(), token: "same", bootId: NOW, ...sameBoot });
  const row = doctor(s.env, { gui: false }).results.find((x) => x.name === "cleanup locks");
  assert.equal(row.ok, false); assert.match(row.detail, /lifecycle: dead\/unverifiable owner; explicit recovery required/);
  const r = hook(s, "session-start", "claude", { session_id: "aaaaaaaa-bbbb-4ccc-8ddd-0123456789ab", cwd: s.home, source: "startup" });
  assert.equal(r.status, 0); assert.match(r.stdout, /registration\/cleanup failed/);
  assert.equal(readJsonOrNull(lock).token, "same");
  fs.unlinkSync(lock); put(lock, { pid: deadPid(), token: "legacy", ...preBoot });
  const legacy = doctor(s.env, { gui: false }).results.find((x) => x.name === "cleanup locks");
  assert.equal(legacy.ok, false); assert.match(legacy.detail, /dead owner acquired before this boot by the wall clock \(no boot id recorded, so not proof\); explicit recovery required/);
  fs.unlinkSync(lock); put(lock, { pid: process.pid, token: "reused", ...preBoot });
  const live = doctor(s.env, { gui: false }).results.find((x) => x.name === "cleanup locks");
  assert.equal(live.ok, false); assert.match(live.detail, /acquired before this boot by the wall clock \(no boot id recorded\) but pid \d+ is live now/);
  const listed = JSON.parse(cli(s, ["locks", "--json"]).stdout);
  assert.equal(listed[0].legacyBeforeBoot, true); assert.equal(listed[0].reclaimable, false);
});

test("doctor never calls a guard harmless or reclaimable when it cannot know (Opus review lows 1-3)", () => {
  // Boot id unreadable: this boot's outer guard (dead or live) is unknown and fails, not "earlier boot; harmless".
  for (const pid of [deadPid(), process.pid]) {
    const s = sim({ mounted: false });
    put(guardFile(s.env, boot), { pid, token: "outer", bootId: NOW });
    s.env.CLEAN_DEV_TEST_BOOT = "unknown";
    const row = doctor(s.env, { gui: false }).results.find((x) => x.name === "cleanup locks");
    assert.equal(row.ok, false, row.detail); assert.match(row.detail, /boot identity unreadable here/); assert.doesNotMatch(row.detail, /harmless|remove by hand/);
  }
  // A pre-boot 0.6.3 shared guard whose pid is live again blocks the reclaim; doctor must say so.
  const s = sim({ mounted: false }), lock = lockOf(s), sharedGuard = lockOf(s, "lock-recovery");
  s.env.CLEAN_DEV_TEST_BOOT = JSON.stringify(boot);
  put(lock, { pid: process.pid, token: "old", bootId: OLD });
  put(sharedGuard, { pid: process.pid, token: "v063", ...preBoot });
  let row = doctor(s.env, { gui: false }).results.find((x) => x.name === "cleanup locks");
  assert.equal(row.ok, false); assert.match(row.detail, /lifecycle: orphaned by reboot \(boot id changed\); auto-reclaim blocked by lock-recovery/);
  assert.equal(withLifecycleLock(s.env, () => assert.fail("must not run"), { boot, log: nolog }).reclaim.reason, "another recovery owns the guard");
  // An empty shared guard is unverifiable: no recovery command is offered, because recoverLock refuses it.
  fs.unlinkSync(sharedGuard); fs.writeFileSync(sharedGuard, "");
  row = doctor(s.env, { gui: false }).results.find((x) => x.name === "cleanup locks");
  assert.match(row.detail, /lock-recovery: unverifiable owner \(empty or unreadable record\)/); assert.doesNotMatch(row.detail, /--recover lock-recovery/);
  assert.throws(() => recoverLock(s.env, "lock-recovery", { apply: true, boot }), /alive or unverifiable/);
});
