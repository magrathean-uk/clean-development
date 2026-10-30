import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import { sim, hook, cli, mk, repo, runtime, gone, waitFor } from "./helpers.mjs";
import { loadConf } from "../runtime/lib/conf.mjs";
import { classify, readPin, reapSession } from "../runtime/lib/sessions.mjs";
import { flushDeletes, removeManaged } from "../runtime/lib/fsutil.mjs";
import { sweepTrash } from "../runtime/lib/prune.mjs";

for (const harness of ["claude", "codex"]) {
  const prefix = harness === "claude" ? "c" : "x";
  test(`${harness}: live external-to-internal fallback builds survive every selector`, () => {
    const s = sim();
    const input = { session_id: "fallback-123456789012" };
    hook(s, "session-start", harness, input);
    s.env.DEV_STORAGE_VOLUME_TEST = "absent";
    hook(s, "session-start", harness, { ...input, source: "resume" });
    const output = mk(path.join(s.int, "builds", `${prefix}-123456789012`, "active"));
    // Hook-only fallback deliberately has no shell-created .lost marker.
    assert.equal(fs.existsSync(path.join(s.sessions, `${prefix}-123456789012.lost`)), false);
    hook(s, "stop", harness, input);
    assert.ok(fs.existsSync(output), "own Stop must retain live fallback output");
    hook(s, "session-start", harness, { session_id: "peer-222222222222" });
    hook(s, "stop", harness, { session_id: "peer-222222222222" });
    cli(s, ["housekeeping", "--apply", "--json"]);
    assert.ok(fs.existsSync(output), "peer and forced housekeeping must respect all live keys");
  });
  for (const reconnect of [true, false]) {
    test(`${harness}: deferred end followed by resume is live (reconnect=${reconnect})`, () => {
      const s = sim();
      const input = { session_id: "resumable-555555555555" };
      hook(s, "session-start", harness, input);
      s.env.DEV_STORAGE_VOLUME_TEST = "absent";
      hook(s, "session-end", harness, input);
      assert.equal(readPin(s.env, `${prefix}-555555555555`).ended, true);
      s.env.DEV_STORAGE_VOLUME_TEST = reconnect ? "mounted" : "absent";
      hook(s, "session-start", harness, { ...input, source: "resume" });
      const output = mk(path.join(reconnect ? s.ext : s.int, "scratch", `${prefix}-555555555555`, "tmp", "fresh"));
      assert.equal(readPin(s.env, `${prefix}-555555555555`).ended, false);
      hook(s, "session-start", harness, { session_id: "peer-222222222222" });
      cli(s, ["reap", "--apply"]);
      assert.ok(fs.existsSync(output));
    });
  }
}

test("a stale reaper snapshot cannot delete a reopened generation", () => {
  const s = sim();
  const input = { session_id: "generation-111111111111" };
  hook(s, "session-start", "claude", input);
  s.env.DEV_STORAGE_VOLUME_TEST = "absent";
  hook(s, "session-end", "claude", input);
  const snapshot = { key: "c-111111111111", ...readPin(s.env, "c-111111111111") };
  hook(s, "session-start", "claude", { ...input, source: "resume" });
  const output = mk(path.join(s.int, "scratch", snapshot.key, "tmp", "fresh"));
  const result = reapSession(loadConf(s.env), s.env, snapshot);
  assert.equal(result.skipped, "ownership changed");
  assert.ok(fs.existsSync(output));
});

test("a second original ID cannot replace or end a colliding suffix owner", () => {
  const s = sim({ mounted: false });
  hook(s, "session-start", "claude", { session_id: "first-same12345678" });
  const output = mk(path.join(s.int, "scratch", "c-same12345678", "tmp", "first-owner"));
  hook(s, "session-start", "claude", { session_id: "other-same12345678" });
  hook(s, "session-end", "claude", { session_id: "other-same12345678" });
  assert.equal(readPin(s.env, "c-same12345678").meta.sessionId, "first-same12345678");
  assert.ok(fs.existsSync(output));
});

test("canonical project aliases share the live-owner veto", () => {
  const s = sim({ mounted: false });
  const project = repo(s);
  const alias = path.join(s.root, "project-alias"); fs.symlinkSync(project, alias);
  hook(s, "session-start", "claude", { session_id: "a-111111111111", cwd: project });
  hook(s, "session-start", "codex", { session_id: "b-222222222222", cwd: alias });
  const output = mk(path.join(project, ".build", "live"));
  hook(s, "session-end", "claude", { session_id: "a-111111111111", cwd: project });
  assert.ok(fs.existsSync(output));
});

for (const sub of ["deps", "builds", "scratch", "trash"]) {
  test(`redirected ${sub} layout cannot grant deletion authority`, () => {
    const s = sim({ mounted: false });
    const outside = path.join(s.root, "outside"); fs.mkdirSync(outside);
    fs.mkdirSync(s.int, { recursive: true }); fs.symlinkSync(outside, path.join(s.int, sub));
    const output = mk(path.join(outside, "victim", "precious"));
    const r = removeManaged(path.dirname(output), { anchor: s.int, allowedRoots: [path.join(s.int, sub)], trashDir: path.join(s.int, "trash") });
    assert.equal(r.removed, false);
    assert.ok(fs.existsSync(output));
    if (sub === "trash") {
      sweepTrash(s.int, { now: Date.now() + 7200000 });
      assert.ok(fs.existsSync(output));
    }
  });
}

test("rename errors retain the source instead of falling through to direct deletion", (t) => {
  const s = sim();
  const output = mk(path.join(s.ext, "deps", "npm", "blob"));
  const rename = t.mock.method(fs, "renameSync", () => { const e = new Error("simulated cross-device rename"); e.code = "EXDEV"; throw e; });
  const r = removeManaged(path.dirname(output), { anchor: s.ext, allowedRoots: [path.join(s.ext, "deps")], trashDir: path.join(s.ext, "trash") });
  rename.mock.restore();
  assert.equal(r.removed, false); assert.equal(r.reason, "rename failed: EXDEV");
  assert.ok(fs.existsSync(output));
});

test("invalid machine roots use safe routing but grant no cleanup authority", () => {
  const s = sim({ mounted: false });
  const output = mk(path.join(s.int, "builds", "precious", "keep"));
  fs.appendFileSync(s.config, "INTERNAL_ROOT=relative-root\n");
  const conf = loadConf(s.env);
  assert.equal(conf.valid, false);
  assert.equal(conf.internalRoot, s.int);
  const result = cli(s, ["housekeeping", "--apply", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(output));
  hook(s, "session-start", "claude", { session_id: "invalid-333333333333" });
  assert.equal(fs.existsSync(path.join(s.root, "relative-root")), false);
});

test("traversing external roots and overlapping disposable anchors are invalid", () => {
  const s = sim();
  fs.appendFileSync(s.config, "EXTERNAL_CACHE=${EXTERNAL_ROOT}/../../escape\n");
  assert.equal(loadConf(s.env).valid, false);
  const t = sim();
  fs.appendFileSync(t.config, `INTERNAL_ROOT=${t.home}/dev/machine\n`);
  assert.equal(loadConf(t.env).valid, false);
});

test("invalid v1 cannot infer destructive project directories; invalid v2 cannot be migrated", () => {
  const s = sim({ mounted: false });
  const project = repo(s);
  const config = path.join(project, ".clean-development.json");
  mk(path.join(project, "Package.swift"));
  mk(config, JSON.stringify({ schemaVersion: 1, enabled: "not-a-boolean", unknown: true }));
  hook(s, "session-start", "claude", { session_id: "invalid-444444444444", cwd: project });
  const output = mk(path.join(project, ".build", "keep"));
  hook(s, "session-end", "claude", { session_id: "invalid-444444444444", cwd: project });
  assert.ok(fs.existsSync(output));
  const invalid = JSON.stringify({ schemaVersion: 2, enabled: true, buildDirs: ["../outside"], notes: "preserve me" });
  mk(config, invalid);
  assert.equal(cli(s, ["migrate", "--write", project]).status, 1);
  assert.equal(fs.readFileSync(config, "utf8"), invalid);
});

test("leaf links remain removable without following their target", async () => {
  const s = sim();
  const output = mk(path.join(s.root, "outside", "precious"));
  const link = path.join(s.ext, "deps", "link"); fs.mkdirSync(path.dirname(link), { recursive: true }); fs.symlinkSync(path.dirname(output), link);
  const r = removeManaged(link, { anchor: s.ext, allowedRoots: [path.dirname(link)], trashDir: path.join(s.ext, "trash") });
  assert.equal(r.removed, true);
  assert.ok(await gone(link)); assert.ok(fs.existsSync(output));
});

test("valid JSON on an open input pipe does not consume the host's end deadline", async () => {
  const s = sim();
  const start = Date.now();
  const child = spawn(process.execPath, [path.join(runtime, "bin", "cd-hook.mjs"), "session-end", "codex"], { env: s.env, cwd: s.root, stdio: ["pipe", "pipe", "pipe"] });
  const timeout = setTimeout(() => child.kill(), 5000);
  child.stdin.on("error", () => {});
  child.stdin.write('{"session_id":"open-pipe-666666666666"}');
  const code = await new Promise((resolve) => child.on("close", resolve));
  clearTimeout(timeout);
  assert.equal(code, 0);
  assert.ok(Date.now() - start < 1500, "input framing must leave time for cleanup");
});

test("generation-tagged late end cannot terminate a resumed owner; repeated live starts are idempotent", () => {
  const s = sim(), input = { session_id: "old-end-121212121212" }, key = "c-121212121212";
  hook(s, "session-start", "claude", input);
  const oldGeneration = readPin(s.env, key).meta.generation;
  hook(s, "session-start", "claude", { ...input, source: "compact" });
  assert.equal(readPin(s.env, key).meta.generation, oldGeneration);
  s.env.DEV_STORAGE_VOLUME_TEST = "absent";
  hook(s, "session-end", "claude", input);
  hook(s, "session-start", "claude", { ...input, source: "resume" });
  const output = mk(path.join(s.int, "scratch", key, "tmp", "fresh"));
  assert.notEqual(readPin(s.env, key).meta.generation, oldGeneration);
  hook(s, "session-end", "claude", { ...input, generation: oldGeneration });
  assert.equal(readPin(s.env, key).ended, false); assert.ok(fs.existsSync(output));
});

test("a reopened generation does not inherit the previous generation's loss marker", () => {
  const s = sim(), input = { session_id: "lost-909090909090" }, key = "c-909090909090";
  hook(s, "session-start", "claude", input);
  s.env.DEV_STORAGE_VOLUME_TEST = "absent";
  mk(path.join(s.sessions, `${key}.lost`), "");
  hook(s, "session-end", "claude", input);
  assert.equal(readPin(s.env, key).lost, true);
  s.env.DEV_STORAGE_VOLUME_TEST = "mounted";
  hook(s, "session-start", "claude", { ...input, source: "resume" });
  assert.equal(readPin(s.env, key).lost, false);
  assert.equal(readPin(s.env, key).ended, false);
});

test("invalid ownership metadata cannot be classified as dead or authorise deletion", () => {
  const s = sim({ mounted: false }), key = "c-343434343434";
  hook(s, "session-start", "claude", { session_id: "corrupt-343434343434" });
  mk(path.join(s.sessions, `${key}.json`), "invalid-json");
  mk(path.join(s.sessions, `${key}.ended`), "legacy-end\n");
  const output = mk(path.join(s.int, "scratch", key, "tmp", "must-stay"));
  const state = classify(loadConf(s.env), s.env).find((s) => s.key === key);
  assert.equal(state.done, false); assert.ok(state.errors.length);
  cli(s, ["reap", "--apply"]); cli(s, ["housekeeping", "--apply"]);
  assert.ok(fs.existsSync(output));
});

test("a declared ignored directory with tracked content remains protected", () => {
  const s = sim({ mounted: false }), project = repo(s);
  const tracked = mk(path.join(project, ".build", "tracked-important"));
  const add = spawnSync("/usr/bin/git", ["-C", project, "add", "-f", ".build/tracked-important"], { env: s.env });
  assert.equal(add.status, 0);
  const input = { session_id: "tracked-787878787878", cwd: project };
  hook(s, "session-start", "claude", input); hook(s, "session-end", "claude", input);
  assert.ok(fs.existsSync(tracked));
});

test("deletions batch per anchor and have distinct queued/completed receipts", async () => {
  const s = sim();
  const events = path.join(s.home, "dev", "machine", "state", "clean-development", "deletions.jsonl");
  const jobs = [];
  for (let i = 0; i < 64; i++) {
    const output = mk(path.join(s.ext, "deps", `unit-${i}`, "blob"));
    jobs.push(removeManaged(path.dirname(output), { anchor: s.ext, allowedRoots: [path.join(s.ext, "deps")], trashDir: path.join(s.ext, "trash"), eventsFile: events }));
  }
  flushDeletes();
  for (const job of jobs) assert.ok(await gone(job.target));
  let rows;
  assert.ok(await waitFor(() => {
    rows = fs.readFileSync(events, "utf8").trim().split("\n").map(JSON.parse);
    return rows.filter((r) => r.event === "delete" && r.status === "completed").length === jobs.length;
  }));
  const workers = rows.filter((r) => r.event === "delete-worker" && r.status === "started");
  assert.equal(workers.length, 1); assert.equal(workers[0].jobs, 64);
  for (const job of jobs) {
    assert.equal(rows.filter((r) => r.id === job.id && r.status === "queued").length, 1);
    assert.equal(rows.filter((r) => r.id === job.id && r.status === "completed").length, 1);
  }
});
