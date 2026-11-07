import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sim, mk } from "./helpers.mjs";
import { loadConf, stateDir } from "../runtime/lib/conf.mjs";
import { canonicalPath, withLock } from "../runtime/lib/fsutil.mjs";
import { createLease } from "../runtime/lib/leases.mjs";
import { lifecycleLock, writePin } from "../runtime/lib/sessions.mjs";
import { OWNER_FILE, OWNER_CONFLICT_FILE, ownerRecord, readOwner, writeOwner, markOwnerConflict, pruneProject } from "../runtime/lib/owners.mjs";

const keyA = "x-aaaaaaaaaaaa", keyB = "c-bbbbbbbbbbbb";
const info = (repo, key = keyA) => ({ repo, cwd: repo, harness: "codex", key, created: "2026-11-05T12:00:00.000Z" });
function fixture() {
  const s = sim(), conf = loadConf(s.env);
  const a = path.join(s.home, "dev/source/A"), b = path.join(s.home, "dev/source/B");
  for (const p of [a, b]) fs.mkdirSync(p, { recursive: true });
  const build = (name, repo = a, root = s.ext, key = keyA) => {
    const p = path.join(root, "builds", name);
    assert.equal(writeOwner(p, info(repo, key)).written, true);
    mk(path.join(p, "output"), name);
    return p;
  };
  return { s, conf, a, b, build };
}
function snapshot(p) {
  const st = fs.lstatSync(p);
  return { mode: st.mode, mtime: st.mtimeMs, ctime: st.ctimeMs,
    data: st.isDirectory() ? Object.fromEntries(fs.readdirSync(p).sort().map((name) => [name, snapshot(path.join(p, name))]))
      : st.isSymbolicLink() ? fs.readlinkSync(p) : fs.readFileSync(p).toString("base64") };
}

test("owner records validate their paths, key, harness and ISO creation time", () => {
  const record = ownerRecord(info("/repo"));
  assert.deepEqual(record, { schemaVersion: 1, ...info("/repo") });
  assert.equal(Object.getPrototypeOf(record), Object.prototype);
  assert.deepEqual(ownerRecord({ harness: "shell" }).key, null);
  for (const bad of [{ repo: "relative" }, { cwd: "relative" }, { key: "x-short" }, { key: 12 }, { harness: "other" }, { created: "yesterday" }])
    assert.throws(() => ownerRecord({ ...info("/repo"), ...bad }));
});

test("owner writes are private, atomic, idempotent and never replace another key", () => {
  const { s, a } = fixture(), p = path.join(s.ext, "builds/owned");
  assert.deepEqual(writeOwner(p, info(a)), { written: true });
  assert.equal(fs.statSync(p).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(p, OWNER_FILE)).mode & 0o777, 0o600);
  const before = snapshot(p);
  assert.deepEqual(writeOwner(p, { ...info(a), cwd: "/elsewhere" }), { written: false });
  assert.deepEqual(writeOwner(p, info(a, keyB)), { written: false, conflict: true });
  assert.deepEqual(snapshot(p), before);
  assert.deepEqual(readOwner(p), ownerRecord(info(a)));
  assert.deepEqual(fs.readdirSync(p), [OWNER_FILE]);
});

test("owner I/O failures and directory or record symlinks preserve their targets", () => {
  const { s, a } = fixture(), target = path.join(s.root, "target"), link = path.join(s.root, "link");
  fs.mkdirSync(target); fs.symlinkSync(target, link);
  assert.ok(writeOwner(link, info(a)).error);
  assert.ok(writeOwner(link + "/", info(a)).error);
  assert.equal(readOwner(link), null);
  assert.equal(readOwner(link + "/"), null);
  assert.deepEqual(fs.readdirSync(target), []);
  const file = mk(path.join(s.root, "file"));
  assert.ok(writeOwner(file, info(a)).error);
  fs.symlinkSync(file, path.join(target, OWNER_FILE));
  const before = snapshot(target);
  assert.ok(writeOwner(target, info(a)).error);
  assert.equal(readOwner(target), null);
  assert.deepEqual(snapshot(target), before);
});

test("a competing owner published during an atomic write is retained", (t) => {
  const { s, a } = fixture(), p = path.join(s.ext, "builds/race"), link = fs.linkSync;
  const other = JSON.stringify(ownerRecord(info(a, keyB))) + "\n";
  t.mock.method(fs, "linkSync", (source, target) => {
    if (target === path.join(p, OWNER_FILE)) fs.writeFileSync(target, other, { flag: "wx" });
    return link(source, target);
  });
  assert.deepEqual(writeOwner(p, info(a)), { written: false, conflict: true });
  assert.equal(fs.readFileSync(path.join(p, OWNER_FILE), "utf8"), other);
  assert.deepEqual(fs.readdirSync(p), [OWNER_FILE]);
});

test("a session key reused by another project is marked ambiguous and cannot authorize either prune", () => {
  const { s, conf, a, b, build } = fixture(), index = path.join(stateDir(s.env), "owners", keyA);
  assert.equal(writeOwner(index, info(a)).written, true);
  assert.deepEqual(writeOwner(index, info(b)), { written: false, conflict: true, projectChanged: true });
  assert.deepEqual(markOwnerConflict(index), { written: true });
  assert.equal(fs.existsSync(path.join(index, OWNER_CONFLICT_FILE)), true);
  assert.equal(readOwner(index), null);
  const reused = build(keyA, a);
  for (const repo of [a, b]) {
    const result = pruneProject(conf, s.env, repo);
    assert.deepEqual(result.candidates, []);
    assert.ok(result.skipped.some((entry) => entry.path === reused && entry.reason === "ambiguous project ownership"));
  }
  assert.equal(fs.readFileSync(path.join(reused, "output"), "utf8"), keyA);
});

test("project preview selects only matching owners across both roots and writes nothing", () => {
  const { s, conf, a, b, build } = fixture();
  const ea = build("external-a"), ia = build("internal-a", a, s.int), eb = build("external-b", b);
  const derived = build("DerivedData"), alias = path.join(s.root, "repo-alias");
  fs.symlinkSync(a, alias);
  const before = snapshot(s.root), result = pruneProject(conf, s.env, alias);
  assert.equal(result.repo, canonicalPath(a));
  assert.deepEqual(result.candidates.map((c) => c.path).sort(), [ea, ia].sort());
  assert.ok(result.candidates.every((c) => c.key === keyA && c.root && c.reason));
  assert.deepEqual(result.removed, []);
  assert.deepEqual(snapshot(s.root), before);
  for (const p of [eb, derived]) assert.equal(fs.readFileSync(path.join(p, "output"), "utf8"), path.basename(p));
  assert.equal(fs.existsSync(lifecycleLock(s.env)), false);
});

test("leases and live sessions are skipped, while apply queues only A's unprotected builds", () => {
  const { s, conf, a, b, build } = fixture();
  const free = build("free"), leased = build("leased"), live = build(keyB, a, s.int, keyB), other = build("other", b);
  const derived = build("DerivedData");
  createLease(conf, s.env, [leased]);
  writePin(s.env, keyB, "internal", { harness: "claude", sessionId: "bbbbbbbbbbbb", projectRoot: a });
  const before = snapshot(s.root), preview = pruneProject(conf, s.env, a);
  assert.deepEqual(preview.candidates.map((c) => c.path), [free]);
  assert.match(preview.skipped.find((c) => c.path === leased).reason, /lease/);
  assert.match(preview.skipped.find((c) => c.path === live).reason, /live/);
  assert.deepEqual(snapshot(s.root), before);
  const result = pruneProject(conf, s.env, a, { apply: true });
  assert.equal(result.removed.length, 1);
  assert.equal(result.removed[0].path, free);
  assert.equal(result.removed[0].via, "trash");
  assert.equal(path.dirname(result.removed[0].target), path.join(s.ext, "trash"));
  assert.equal(fs.existsSync(free), false);
  for (const p of [leased, live, other, derived]) assert.equal(fs.readFileSync(path.join(p, "output"), "utf8"), path.basename(p));
});

test("invalid owner records and symlinks are skipped without inspecting redirected builds", () => {
  const { s, conf, a, build } = fixture();
  const invalid = build("invalid"), missing = path.join(s.ext, "builds/missing"), linked = path.join(s.ext, "builds/linked");
  fs.writeFileSync(path.join(invalid, OWNER_FILE), "{}"); fs.mkdirSync(missing);
  const target = path.join(s.root, "target"); assert.equal(writeOwner(target, info(a)).written, true);
  fs.symlinkSync(target, linked);
  const before = snapshot(s.root), result = pruneProject(conf, s.env, a);
  assert.deepEqual(result.candidates, []);
  for (const p of [invalid, missing]) assert.match(result.skipped.find((c) => c.path === p).reason, /owner/);
  assert.match(result.skipped.find((c) => c.path === linked).reason, /symlink/);
  assert.deepEqual(snapshot(s.root), before);
  const redirected = fixture();
  fs.symlinkSync(s.ext, redirected.s.int);
  const r = pruneProject(redirected.conf, redirected.s.env, redirected.a);
  assert.match(r.skipped.find((c) => c.path === path.join(redirected.s.int, "builds")).reason, /unsafe/);
});

test("apply re-checks a lease acquired after the initial candidate inspection", (t) => {
  const { s, conf, a, build } = fixture(), p = build("newly-leased"), read = fs.readFileSync;
  let acquired = false;
  t.mock.method(fs, "readFileSync", (file, ...args) => {
    const bytes = read(file, ...args);
    if (file === path.join(p, OWNER_FILE) && !acquired) { acquired = true; createLease(conf, s.env, [p]); }
    return bytes;
  });
  const result = pruneProject(conf, s.env, a, { apply: true });
  assert.equal(acquired, true);
  assert.deepEqual(result.removed, []); assert.deepEqual(result.candidates, []);
  assert.match(result.skipped.find((c) => c.path === p).reason, /lease/);
  assert.equal(fs.readFileSync(path.join(p, "output"), "utf8"), "newly-leased");
});

test("lease registry errors block all matching builds and preview never creates state", () => {
  const { s, conf, a, build } = fixture(), p = build("blocked");
  mk(path.join(stateDir(s.env), "leases/broken.json"), "{");
  const before = snapshot(s.root), result = pruneProject(conf, s.env, a, { apply: true });
  assert.deepEqual(result.candidates, []); assert.deepEqual(result.removed, []);
  assert.match(result.skipped.find((c) => c.path === p).reason, /lease registry/);
  // Apply creates the lifecycle lock's parent, but releases its lock and preserves all bytes here.
  assert.deepEqual(snapshot(s.ext), before.data.Volumes.data.External.data.dev.data.cache);
  assert.equal(fs.existsSync(lifecycleLock(s.env)), false);
});

test("a busy lifecycle lock prevents apply; preview ignores the lock without changing it", () => {
  const { s, conf, a, build } = fixture(), p = build("owned");
  withLock(lifecycleLock(s.env), () => {
    const before = snapshot(s.root);
    const result = pruneProject(conf, s.env, a, { apply: true });
    assert.deepEqual(result.candidates, []); assert.deepEqual(result.removed, []);
    assert.equal(result.skipped[0].reason, "lifecycle locked");
    assert.equal(pruneProject(conf, s.env, a).candidates[0].path, p);
    assert.deepEqual(snapshot(s.root), before);
  });
});

test("invalid projects, invalid configuration and expired deadlines cannot authorise pruning", () => {
  const { s, conf, a, build } = fixture(), p = build("owned");
  for (const repo of ["relative", path.join(s.root, "missing"), mk(path.join(s.root, "file"))])
    assert.throws(() => pruneProject(conf, s.env, repo), /absolute directory/);
  const invalid = pruneProject({ ...conf, valid: false }, s.env, a, { apply: true });
  assert.match(invalid.skipped[0].reason, /configuration/);
  const late = pruneProject(conf, s.env, a, { deadline: 0 });
  assert.deepEqual(late.candidates, []);
  assert.equal(late.skipped.find((c) => c.path === p).reason, "deadline");
  assert.equal(fs.existsSync(p), true);
  assert.equal(fs.existsSync(lifecycleLock(s.env)), false);
});
