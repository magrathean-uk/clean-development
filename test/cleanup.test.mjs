import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { cli, mk, sim } from "./helpers.mjs";
import { cleanup, cleanupText, applyCleanup, applyText } from "../runtime/lib/cleanup.mjs";

const DAY = 86400000;
const future = () => Date.now() + 40 * DAY;
function setup(mounted = true) {
  const s = sim({ mounted });
  s.work = path.join(s.home, "dev", "work");
  s.env.CLEAN_DEV_WORK = s.work;
  for (const root of [s.ext, s.int]) fs.mkdirSync(root, { recursive: true });
  return s;
}
function folder(p) { mk(path.join(p, "nested", "file"), "12345"); return p; }
function claim(s, name, config) {
  const project = path.join(s.home, "dev", "source", name);
  mk(path.join(project, ".clean-development.json"), typeof config === "string" ? config : JSON.stringify(config));
  return project;
}
const paths = (result, kind) => result.items.filter((r) => !kind || r.kind === kind).map((r) => r.path);
function snapshot(root) {
  const entries = [];
  function visit(p) {
    const s = fs.lstatSync(p);
    entries.push([path.relative(root, p), s.mode, s.size, s.mtimeMs, s.ctimeMs,
      s.isSymbolicLink() ? fs.readlinkSync(p) : s.isFile() ? fs.readFileSync(p).toString("base64") : null]);
    if (s.isDirectory()) for (const name of fs.readdirSync(p).sort()) visit(path.join(p, name));
  }
  visit(root);
  return entries;
}

test("cleanup lists completed jobs and project claims; excludes aggregates, own paths and recent items", () => {
  const s = setup(), now = future();
  const done = folder(path.join(s.work, "jobs", "project", "done"));
  mk(path.join(done, ".done"));
  folder(path.join(s.work, "jobs", "project", "running"));
  const build = folder(path.join(s.ext, "builds", "project"));
  const dep = folder(path.join(s.ext, "deps", "project"));
  const own = folder(path.join(s.ext, "builds", "own"));
  const scratch = folder(path.join(s.ext, "scratch", "own"));
  Object.assign(s.env, { CLEAN_DEV_BUILDS: own, CLEAN_DEV_SCRATCH: scratch });
  const project = claim(s, "project", { buildDirs: [build, own], depDirs: [dep, s.ext, path.join(s.ext, "builds"), path.join(s.ext, "deps")] });
  const before = snapshot(s.root);
  assert.deepEqual(paths(cleanup(s.env, { now })), [done]);
  const result = cleanup(s.env, { project, now });
  assert.deepEqual(new Set(paths(result)), new Set([done, build, dep]));
  assert.deepEqual(new Set(paths(result, "c")), new Set([build, dep]));
  assert.ok(result.items.every((r) => r.bytes > 0 && r.reason && r.count > 0 && r.newest > 0));
  assert.match(cleanupText(result), /list: [0-9a-f]{12}$/);
  assert.equal(cleanup(s.env, { project }).items.length, 0);
  const run = cli(s, ["cleanup", "--project", project, "--json"]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).items.length, 0);
  assert.deepEqual(snapshot(s.root), before);
});

test("unknown-owner and internal fallback candidates obey claim, age, category and mode exclusions", () => {
  for (const mounted of [true, false]) {
    const s = setup(mounted), now = future(), active = mounted ? s.ext : s.int;
    const stale = folder(path.join(active, "builds", "stale"));
    const scratch = folder(path.join(active, "scratch", "stale"));
    const recent = folder(path.join(active, "builds", "three-days"));
    const recentTime = new Date(now - 3 * DAY);
    fs.utimesSync(path.join(recent, "nested", "file"), recentTime, recentTime);
    folder(path.join(active, "deps", "old-tool"));
    folder(path.join(active, "other", "old"));
    const claimed = folder(path.join(active, "builds", "claimed"));
    const contains = folder(path.join(active, "builds", "contains"));
    const inner = folder(path.join(active, "builds", "inside", "child"));
    const internalClaim = folder(path.join(s.int, "builds", "project"));
    const internalStale = folder(path.join(s.int, "builds", "eight-days"));
    const internalScratch = folder(path.join(s.int, "scratch", "three-days"));
    fs.utimesSync(path.join(internalScratch, "nested", "file"), recentTime, recentTime);
    folder(path.join(s.int, "deps", "old-tool"));
    claim(s, "live", { buildDirs: [claimed, path.join(contains, "nested"), path.dirname(inner), internalClaim] });
    const before = snapshot(s.root), result = cleanup(s.env, { now });
    assert.ok(paths(result, "d").includes(stale));
    assert.ok(paths(result, "d").includes(scratch));
    for (const excluded of [recent, claimed, contains, internalClaim, internalScratch]) assert.ok(!paths(result).includes(excluded), excluded);
    assert.ok(!paths(result).includes(path.dirname(inner)));
    assert.ok(!paths(result).some((p) => p.includes("/deps/") || p.includes("/other/")));
    assert.ok(result.items.every((r) => ![active, path.join(active, "deps"), path.join(active, "builds"), path.join(active, "scratch")].includes(r.path)));
    if (mounted) assert.ok(paths(result, "e").includes(internalStale));
    else { assert.equal(paths(result, "e").length, 0); assert.ok(paths(result, "d").includes(internalStale)); }
    assert.deepEqual(snapshot(s.root), before);
  }
});

test("age uses the newest descendant's mtime or ctime, at 24-hour and 7-day boundaries", () => {
  const s = setup(), candidate = folder(path.join(s.ext, "builds", "old"));
  const initial = cleanup(s.env, { now: future() }).items[0].newest;
  assert.deepEqual(paths(cleanup(s.env, { now: initial + 7 * DAY })), [candidate]);
  assert.deepEqual(paths(cleanup(s.env, { now: initial + 7 * DAY - 1 })), []);
  const job = folder(path.join(s.work, "jobs", "p", "j"));
  mk(path.join(job, ".done"));
  const newest = cleanup(s.env, { now: future() }).items.find((r) => r.path === job).newest;
  assert.ok(paths(cleanup(s.env, { now: newest + DAY })).includes(job));
  assert.ok(!paths(cleanup(s.env, { now: newest + DAY - 1 })).includes(job));
  const old = new Date(0);
  fs.utimesSync(path.join(candidate, "nested", "file"), old, old);
  assert.equal(cleanup(s.env).items.length, 0, "old mtimes do not hide fresh ctimes");
});

test("malformed or unreadable claims suppress every d/e row and a repaired claim permits retry", () => {
  const badValues = ["{bad", "null", "[]", '{"buildDirs":"bad"}', '{"depDirs":[42]}', '{"buildDirs":[""]}', '{"buildDirs":["\\u0000"]}'];
  for (const value of badValues) {
    const s = setup(), now = future();
    folder(path.join(s.ext, "builds", "stale"));
    folder(path.join(s.int, "builds", "stale"));
    const project = claim(s, "broken", value), file = path.join(project, ".clean-development.json");
    const before = snapshot(s.root), result = cleanup(s.env, { now });
    assert.equal(result.items.length, 0);
    assert.deepEqual(result.skipped, [`unknown-owner: skipped (unreadable claim ${file})`]);
    console.log(`negative ownership: ${result.skipped[0]}`);
    const run = cli(s, ["cleanup"]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /unknown-owner: skipped \(unreadable claim /);
    assert.deepEqual(snapshot(s.root), before);
    fs.writeFileSync(file, '{"buildDirs":[]}');
    assert.equal(cleanup(s.env, { now }).items.length, 2);
  }
  const s = setup();
  folder(path.join(s.ext, "builds", "stale"));
  folder(path.join(s.int, "builds", "stale"));
  const p = claim(s, "unreadable", {}), file = path.join(p, ".clean-development.json");
  fs.rmSync(file);
  fs.mkdirSync(file); // EISDIR is reliably unreadable as a claim, including privileged test users.
  assert.match(cleanupText(cleanup(s.env, { now: future() })), /unknown-owner: skipped/);
  assert.equal(cleanup(s.env, { now: future() }).items.length, 0);
});

test("claims are found in worktrees and explicit projects and resolve directory symlinks", () => {
  const s = setup(), now = future();
  const owned = folder(path.join(s.ext, "builds", "owned"));
  const project = path.join(s.work, "worktrees", "repo", "task");
  mk(path.join(project, ".clean-development.json"), JSON.stringify({ buildDirs: ["out"] }));
  fs.symlinkSync(owned, path.join(project, "out"));
  assert.equal(cleanup(s.env, { now }).items.length, 0);
  assert.deepEqual(paths(cleanup(s.env, { project, now })), [owned]);
  const extra = folder(path.join(s.ext, "builds", "extra"));
  const externalProject = path.join(s.root, "explicit-project");
  mk(path.join(externalProject, ".clean-development.json"), JSON.stringify({ buildDirs: [extra] }));
  const result = cleanup(s.env, { project: externalProject, now });
  assert.deepEqual(paths(result, "c"), [extra]);
  assert.equal(paths(result, "d").length, 0);
});

test("symlinks are never followed, missing claim targets protect containers, fingerprints detect restored-mtime edits", async () => {
  const s = setup(), now = future();
  const item = folder(path.join(s.ext, "builds", "candidate"));
  const outside = folder(path.join(s.root, "outside"));
  fs.symlinkSync(outside, path.join(item, "link"));
  fs.symlinkSync(outside, path.join(s.ext, "builds", "symlink-item"));
  const contains = folder(path.join(s.ext, "builds", "contains-missing"));
  claim(s, "missing", { buildDirs: [path.join(contains, "missing")] });
  const before = snapshot(s.root), first = cleanup(s.env, { now }), second = cleanup(s.env, { now });
  assert.equal(first.id, second.id);
  assert.deepEqual(paths(first), [item]);
  assert.equal(first.items[0].bytes, 5 + Buffer.byteLength(outside));
  assert.equal(first.items[0].count, 4);
  assert.deepEqual(snapshot(s.root), before);
  const file = path.join(item, "nested", "file"), stat = fs.statSync(file);
  await new Promise((resolve) => setTimeout(resolve, 20));
  fs.writeFileSync(file, "abcde");
  fs.utimesSync(file, stat.atime, stat.mtime);
  const changed = cleanup(s.env, { now });
  assert.equal(first.items[0].bytes, changed.items[0].bytes);
  assert.notEqual(first.id, changed.id);
});

function git(s, dir, ...args) {
  const run = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: {
    ...s.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid"
  } });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
}

test("only merged clean worktrees are listed; dirty, untracked, unmerged and recently touched are excluded", () => {
  const s = setup(), now = future(), repo = path.join(s.root, "repository");
  fs.mkdirSync(repo);
  git(s, repo, "init", "-q", "-b", "main");
  mk(path.join(repo, "tracked"), "original");
  git(s, repo, "add", "tracked");
  git(s, repo, "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  function worktree(name) {
    const p = path.join(s.work, "worktrees", "repo", name);
    git(s, repo, "worktree", "add", "-q", "-b", name, p);
    return p;
  }
  const clean = worktree("merged"), dirty = worktree("dirty"), untracked = worktree("untracked"), unmerged = worktree("unmerged"), recent = worktree("recent");
  mk(path.join(dirty, "tracked"), "dirty");
  mk(path.join(untracked, "untracked"));
  mk(path.join(unmerged, "tracked"), "new commit");
  git(s, unmerged, "add", "tracked");
  git(s, unmerged, "-c", "commit.gpgsign=false", "commit", "-qm", "unmerged");
  fs.utimesSync(path.join(recent, "tracked"), new Date(now - 1000), new Date(now - 1000));
  const before = snapshot(s.root);
  assert.deepEqual(paths(cleanup(s.env, { now }), "a"), [clean]);
  assert.deepEqual(snapshot(s.root), before, "git status must not refresh worktree indices");
  assert.equal(cli(s, ["cleanup"]).status, 0);
  assert.deepEqual(snapshot(s.root), before);
});

test("cleanup rejects invalid options without writing", () => {
  const s = setup(), before = snapshot(s.root);
  for (const args of [["--skip", "1"], ["--check"], ["--project"], ["--project", "--json"]]) {
    const run = cli(s, ["cleanup", ...args]);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /unknown argument:|--project needs a value|--skip requires --apply/);
    console.log(`negative cleanup options: exit ${run.status}; ${run.stderr.trim()}`);
  }
  assert.deepEqual(snapshot(s.root), before);
});

// Age fixtures without changing the real filesystem clock or weakening production age checks.
function futureCli(s) {
  const loader = mk(path.join(s.root, "clock.mjs"), `Date.now = () => ${future()};\n`);
  s.env.NODE_OPTIONS = `--import=${pathToFileURL(loader).href}`;
  return s;
}

function assertApplyContained(s, result) {
  for (const item of result.moved || []) for (const key of ["destination", "manifest"]) {
    for (const target of [path.resolve(item[key]), fs.realpathSync(item[key])]) {
      const relative = path.relative(s.root, target);
      assert.ok(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), `${key} escapes fixture: ${target}`);
    }
  }
  return result;
}

function apply(s, options) {
  return assertApplyContained(s, applyCleanup(s.env, options));
}

test("apply containment assertions reject destinations and manifests outside the fixture", () => {
  const s = setup();
  for (const key of ["destination", "manifest"]) {
    const moved = { destination: s.home, manifest: s.home, [key]: path.dirname(s.root) };
    assert.throws(() => assertApplyContained(s, { moved: [moved] }), new RegExp(`${key} escapes fixture`));
    console.log(`negative containment: ${key} escapes fixture`);
  }
});

test("apply CLI moves two volumes separately, skips rows, records manifests and reports actual free space", () => {
  const s = futureCli(setup());
  const external = folder(path.join(s.ext, "builds", "same-name"));
  const internal = folder(path.join(s.int, "builds", "same-name"));
  const skipped = folder(path.join(s.ext, "scratch", "skip"));
  const project = claim(s, "project", { buildDirs: [external, internal, skipped] });
  const preview = cli(s, ["cleanup", "--project", project, "--json"]);
  assert.equal(preview.status, 0, preview.stderr);
  const list = JSON.parse(preview.stdout), row = list.items.findIndex((item) => item.path === skipped) + 1;
  const run = cli(s, ["cleanup", "--project", project, "--apply", list.id, "--skip", String(row), "--json"]);
  assert.equal(run.status, 0, run.stderr);
  const result = assertApplyContained(s, JSON.parse(run.stdout));
  assert.equal(result.moved.length, 2);
  assert.equal(result.bytes, 10);
  assert.equal(result.volumes.length, 2);
  assert.ok(fs.existsSync(skipped));
  for (const item of result.moved) {
    const volume = item.path === external ? s.vol : s.home;
    const trash = item.path === external ? path.join(s.vol, ".Trashes", String(process.getuid())) : path.join(s.home, ".Trash");
    assert.ok(item.destination.startsWith(trash + path.sep));
    assert.match(path.basename(path.dirname(item.destination)), /^clean-development-\d{8}T\d{6}\.\d{3}Z-/);
    assert.equal(fs.existsSync(item.path), false);
    assert.equal(fs.readFileSync(path.join(item.destination, "nested", "file"), "utf8"), "12345");
    assert.deepEqual(fs.readFileSync(item.manifest, "utf8").trimEnd().split("\n"), [`${JSON.stringify(item.path)}\t${item.bytes}\t${item.reason}`]);
    const actual = fs.statfsSync(volume), reported = result.volumes.find((v) => v.path === volume);
    assert.equal(reported.bytes, 5);
    assert.ok(Number.isFinite(reported.free));
    assert.ok(Math.abs(reported.free - Number(actual.bavail) * Number(actual.bsize)) < 64 * 1024 * 1024);
  }
  const text = applyText(result);
  assert.match(text, /^moved: 2 items, 10 bytes\n/);
  assert.equal(text.split("\n").filter((line) => line.startsWith("free:")).length, 2);
  assert.match(text, /Space returns when the Trash is emptied/);
  const empty = JSON.parse(cli(s, ["cleanup", "--project", project, "--json"]).stdout);
  const before = snapshot(s.root);
  const textRun = cli(s, ["cleanup", "--project", project, "--apply", empty.id, "--skip", "1"]);
  assert.equal(textRun.status, 0, textRun.stderr);
  assert.match(textRun.stdout, /^moved: 0 items, 0 bytes\n/);
  assert.deepEqual(snapshot(s.root), before);
});

test("missing and mismatched ids refuse with exit 3 and no writes", () => {
  const s = futureCli(setup());
  folder(path.join(s.ext, "builds", "item"));
  const before = snapshot(s.root);
  for (const args of [["--apply"], ["--apply", "wrong"], ["--apply", "0123456789ab"]]) {
    const run = cli(s, ["cleanup", ...args]);
    assert.equal(run.status, 3, run.stderr);
    assert.match(run.stderr, /cleanup refused:/);
    console.log(`negative approval: exit ${run.status}; ${run.stderr.trim()}`);
    assert.deepEqual(snapshot(s.root), before);
  }
});

test("an added file or same-size nested rewrite with restored mtime refuses the entire apply; relisting permits retry", async () => {
  for (const edit of ["added", "rewritten"]) {
    const s = futureCli(setup()), item = folder(path.join(s.ext, "builds", "item"));
    folder(path.join(s.int, "builds", "other"));
    const first = JSON.parse(cli(s, ["cleanup", "--json"]).stdout);
    const file = path.join(item, "nested", "file"), stat = fs.statSync(file);
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (edit === "added") mk(path.join(item, "added"), "new");
    else { fs.writeFileSync(file, "abcde"); fs.utimesSync(file, stat.atime, stat.mtime); }
    const before = snapshot(s.root), refused = cli(s, ["cleanup", "--apply", first.id]);
    assert.equal(refused.status, 3, refused.stderr);
    console.log(`negative ${edit}: exit ${refused.status}; ${refused.stderr.trim()}`);
    assert.deepEqual(snapshot(s.root), before);
    const next = JSON.parse(cli(s, ["cleanup", "--json"]).stdout);
    assert.notEqual(first.id, next.id);
    const retry = cli(s, ["cleanup", "--apply", next.id, "--json"]);
    assert.equal(retry.status, 0, retry.stderr);
    const applied = assertApplyContained(s, JSON.parse(retry.stdout));
    assert.match(applyText(applied), /^moved: 2 items, /);
  }
});

test("skip validates comma delimiters, positive in-range distinct integers before any writes", () => {
  const s = setup(), now = future();
  folder(path.join(s.ext, "builds", "one"));
  folder(path.join(s.ext, "builds", "two"));
  const list = cleanup(s.env, { now }), before = snapshot(s.root);
  for (const skip of ["", "0", "-1", "1,", ",1", "1,,2", "1 2", "1.5", "01", "3", "1,1", "9007199254740992"]) {
    assert.throws(() => apply(s, { id: list.id, now, skip }), /--skip/);
    assert.deepEqual(snapshot(s.root), before);
  }
  const result = apply(s, { id: list.id, now, skip: "2,1" });
  assert.equal(result.status, 0);
  assert.equal(result.moved.length, 0);
  assert.deepEqual(snapshot(s.root), before);
  console.log("negative skip: --skip needs comma-separated row numbers; invalid --skip row: 3");
});

test("cross-device and permission rename failures retain originals, copy nothing and permit retry", (t) => {
  for (const code of ["EXDEV", "EACCES"]) {
    const s = setup(), now = future();
    const item = folder(path.join(s.ext, "builds", "item"));
    const other = folder(path.join(s.ext, "builds", "other"));
    const list = cleanup(s.env, { now });
    const originalRename = fs.renameSync;
    const mock = t.mock.method(fs, "renameSync", (from, to) => {
      if (from === item) throw Object.assign(new Error(code), { code });
      return originalRename(from, to);
    });
    const result = apply(s, { id: list.id, now });
    mock.mock.restore();
    assert.equal(result.status, 1);
    assert.deepEqual(result.failed, [{ path: item, error: code }]);
    assert.ok(fs.existsSync(item));
    assert.equal(fs.existsSync(other), false);
    assert.deepEqual(result.moved.map((r) => r.path), [other]);
    const group = path.dirname(result.moved[0].destination);
    assert.deepEqual(fs.readdirSync(group).sort(), [path.basename(result.moved[0].destination), "MANIFEST.txt"].sort());
    const manifest = fs.readFileSync(path.join(group, "MANIFEST.txt"), "utf8");
    assert.equal(manifest.split("\n").filter(Boolean).length, 1);
    assert.ok(!manifest.includes(JSON.stringify(item)));
    console.log(`negative rename: ${applyText(result).split("\n").at(-1)}`);
    const retry = apply(s, { id: cleanup(s.env, { now }).id, now });
    assert.equal(retry.status, 0);
    assert.equal(retry.moved[0].path, item);
    assert.notEqual(path.dirname(retry.moved[0].destination), group);
  }
});

test("redirected Trash and manifest write failures prevent moves and can be retried", (t) => {
  const s = setup(), now = future(), item = folder(path.join(s.ext, "builds", "item"));
  const elsewhere = path.join(s.root, "elsewhere");
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, path.join(s.vol, ".Trashes"));
  const id = cleanup(s.env, { now }).id;
  const unsafe = apply(s, { id, now });
  assert.equal(unsafe.status, 1);
  assert.match(unsafe.failed[0].error, /unsafe Trash directory/);
  assert.ok(fs.existsSync(item));
  assert.deepEqual(fs.readdirSync(elsewhere), []);
  fs.renameSync(path.join(s.vol, ".Trashes"), path.join(s.vol, "redirected-trash"));
  const mock = t.mock.method(fs, "writeSync", () => { throw Object.assign(new Error("full"), { code: "ENOSPC" }); });
  const full = apply(s, { id, now });
  mock.mock.restore();
  assert.equal(full.status, 1);
  assert.equal(full.failed[0].error, "ENOSPC");
  assert.ok(fs.existsSync(item));
  console.log(`negative manifest: ${applyText(full).split("\n").at(-1)}`);
  assert.equal(apply(s, { id, now }).status, 0);
});

test("worktree moves prune registration immediately only while the external volume is mounted", () => {
  for (const mounted of [true, false]) {
    const s = setup(mounted), now = future(), repo = path.join(s.root, "repo");
    fs.mkdirSync(repo);
    git(s, repo, "init", "-q", "-b", "main");
    mk(path.join(repo, "tracked"));
    git(s, repo, "add", "tracked");
    git(s, repo, "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
    const item = path.join(s.work, "worktrees", "repo", "merged");
    git(s, repo, "worktree", "add", "-q", "-b", "merged", item);
    const id = cleanup(s.env, { now }).id, result = apply(s, { id, now });
    assert.equal(result.status, 0, JSON.stringify(result.failed));
    assert.equal(result.moved.length, 1);
    assert.ok(fs.existsSync(path.join(result.moved[0].destination, "tracked")));
    assert.equal(git(s, repo, "worktree", "list", "--porcelain").includes(item), !mounted);
  }
});
