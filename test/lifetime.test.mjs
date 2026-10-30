import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sim, hook, cli, mk, repo, plugin, gone } from "./helpers.mjs";
import { loadConf, stateDir } from "../runtime/lib/conf.mjs";
import { createLease, protections, readLeases, updateLease } from "../runtime/lib/leases.mjs";
import { publishFile } from "../runtime/lib/publish.mjs";
import { inspectLocks, recoverLock } from "../runtime/lib/locks.mjs";
import { withLock, writeFileAtomic } from "../runtime/lib/fsutil.mjs";
import { treeDigest } from "../installer.mjs";
import { VERSION } from "../runtime/lib/conf.mjs";

test("an explicit job lease preserves required scratch and builds after its conversation ends", async () => {
  const s = sim({ mounted: false });
  const input = { session_id: "leased-777777777777" };
  hook(s, "session-start", "claude", input);
  const scratch = mk(path.join(s.int, "scratch", "c-777777777777", "tmp", "job-data"));
  const build = mk(path.join(s.int, "builds", "c-777777777777", "job-output"));
  const created = cli(s, ["leases", "create", "--path", path.dirname(scratch), "--path", path.dirname(build), "--minutes", "60", "--owner", "fixture job", "--apply"]);
  assert.equal(created.status, 0, created.stderr);
  const lease = JSON.parse(created.stdout);
  hook(s, "session-end", "claude", input);
  cli(s, ["housekeeping", "--apply"]);
  assert.ok(fs.existsSync(scratch)); assert.ok(fs.existsSync(build));
  const release = cli(s, ["leases", "release", lease.id, "--apply"]);
  assert.equal(release.status, 0, release.stderr);
  cli(s, ["reap", "--apply"]);
  assert.ok(await gone(path.dirname(scratch)));
  assert.ok(await gone(path.dirname(build)));
});

test("leases protect cache consumers and canonical aliases, including a parent deletion", () => {
  const s = sim();
  const npm = path.join(s.ext, "deps", "npm");
  const file = mk(path.join(npm, "deep", "blob"), "bytes".repeat(1024));
  const alias = path.join(s.root, "consumer-alias"); fs.symlinkSync(npm, alias);
  const lease = createLease(loadConf(s.env), s.env, [alias]);
  assert.equal(protections(s.env).protect(file), true);
  assert.equal(protections(s.env).protect(path.join(s.ext, "deps")), true);
  assert.equal(protections(s.env).protect(path.join(s.ext, "deps", "other")), false);
  const t = new Date(Date.now() - 86400000);
  fs.utimesSync(npm, t, t); fs.utimesSync(path.dirname(file), t, t); fs.utimesSync(file, t, t);
  fs.appendFileSync(s.config, "DEPS_CAP_GB=0.000001\n");
  cli(s, ["housekeeping", "--apply"]);
  assert.ok(fs.existsSync(file));
  assert.equal(updateLease(s.env, lease.id, { minutes: 120 }).status, "active");
});

test("expired or released leases cannot silently be renewed, and malformed protection fails closed", () => {
  const s = sim({ mounted: false });
  const output = mk(path.join(s.int, "builds", "unique", "keep"));
  const l = createLease(loadConf(s.env), s.env, [output], { minutes: 1, now: Date.now() - 120000 });
  assert.equal(readLeases(s.env).leases.length, 0);
  assert.throws(() => updateLease(s.env, l.id), /expired/);
  updateLease(s.env, l.id, { release: true });
  assert.throws(() => updateLease(s.env, l.id), /released/);
  mk(path.join(stateDir(s.env), "leases", "broken.json"), "not-json");
  const r = cli(s, ["housekeeping", "--apply", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).result.skipped, "uncertain lease registry");
  assert.ok(fs.existsSync(output));
});

test("released lease history is durable but does not fill the active registry", () => {
  const s = sim({ mounted: false });
  const lease = createLease(loadConf(s.env), s.env, [path.join(s.int, "scratch", "job")]);
  updateLease(s.env, lease.id, { release: true });
  assert.equal(fs.existsSync(path.join(stateDir(s.env), "leases", `${lease.id}.json`)), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir(s.env), "lease-history", `${lease.id}.json`))).status, "released");
  assert.equal(readLeases(s.env).leases.length, 0);
  assert.equal(updateLease(s.env, lease.id, { release: true }).status, "released", "release is retryable");
  assert.throws(() => updateLease(s.env, lease.id), /released/);
});

test("publication verifies bytes/mode, writes a durable receipt and never removes the source", () => {
  const s = sim({ mounted: false });
  const source = mk(path.join(s.int, "scratch", "job", "result.txt"), "valuable evidence\n"); fs.chmodSync(source, 0o751);
  const destination = path.join(s.home, "dev", "source", "project", "evidence", "result.txt");
  // Fabricated HOME itself is under the test's temporary root; production CLI has no such override.
  const r = publishFile(loadConf(s.env), s.env, source, destination, { apply: true, temporaryRoots: [] });
  assert.equal(r.status, "completed"); assert.equal(r.sourceDigest, r.destinationDigest);
  assert.equal(fs.readFileSync(source, "utf8"), fs.readFileSync(destination, "utf8"));
  assert.equal(fs.statSync(destination).mode & 0o777, 0o751);
  assert.equal(JSON.parse(fs.readFileSync(r.receipt)).status, "completed");
  const again = publishFile(loadConf(s.env), s.env, source, destination, { apply: true, temporaryRoots: [] });
  assert.equal(again.status, "completed", "identical existing bytes/mode permit an idempotent receipt");
});

test("publication cannot clobber a late writer or certify a changing source", () => {
  const s = sim({ mounted: false });
  const source = mk(path.join(s.int, "scratch", "result"), "initial");
  const dest = path.join(s.home, "dev", "source", "evidence", "result");
  assert.throws(() => publishFile(loadConf(s.env), s.env, source, dest, { apply: true, temporaryRoots: [], onPhase: () => mk(dest, "late writer") }), /publication failed/);
  assert.equal(fs.readFileSync(dest, "utf8"), "late writer");
  const other = path.join(path.dirname(dest), "other");
  assert.throws(() => publishFile(loadConf(s.env), s.env, source, other, { apply: true, temporaryRoots: [], onPhase: () => mk(source, "changed") }), /source changed/);
  assert.equal(fs.existsSync(other), false);
  assert.equal(fs.readFileSync(source, "utf8"), "changed");
});

test("publication rejects cache destinations, alias destinations and source links", () => {
  const s = sim();
  const source = mk(path.join(s.int, "scratch", "result"));
  fs.symlinkSync(s.int, path.join(s.root, "cache-alias"));
  for (const dest of [path.join(s.int, "output"), path.join(s.root, "cache-alias", "output")]) {
    assert.throws(() => publishFile(loadConf(s.env), s.env, source, dest, { temporaryRoots: [] }), /durable/);
  }
  const link = path.join(s.root, "source-link"); fs.symlinkSync(source, link);
  assert.throws(() => publishFile(loadConf(s.env), s.env, link, path.join(s.home, "evidence"), { temporaryRoots: [] }), /regular file/);
});

test("publication leases its source against cleanup and refuses declared disposable destinations", () => {
  const s = sim({ mounted: false }), project = repo(s);
  const input = { session_id: "publishing-565656565656" };
  hook(s, "session-start", "claude", input);
  const source = mk(path.join(s.int, "scratch", "c-565656565656", "tmp", "only-copy"));
  assert.throws(() => publishFile(loadConf(s.env), s.env, source, path.join(project, ".build", "not-durable"), { temporaryRoots: [] }), /disposable project/);
  const destination = path.join(project, "evidence", "result");
  const r = publishFile(loadConf(s.env), s.env, source, destination, { apply: true, temporaryRoots: [], onPhase: (phase) => {
    if (phase === "copied") { hook(s, "session-end", "claude", input); assert.ok(fs.existsSync(source)); }
  } });
  assert.equal(r.status, "completed"); assert.ok(fs.existsSync(destination));
  assert.equal(readLeases(s.env).leases.length, 0, "temporary publication protection is released");
});

test("failure after atomic publication preserves both copies and can be retried", () => {
  const s = sim({ mounted: false });
  const source = mk(path.join(s.int, "scratch", "result"), "keep both");
  const dest = path.join(s.home, "evidence", "result");
  assert.throws(() => publishFile(loadConf(s.env), s.env, source, dest, { apply: true, temporaryRoots: [], onPhase: (phase) => {
    if (phase === "published") throw new Error("receipt-phase failure fixture");
  } }), /publication failed/);
  assert.equal(fs.readFileSync(source, "utf8"), "keep both"); assert.equal(fs.readFileSync(dest, "utf8"), "keep both");
  assert.equal(publishFile(loadConf(s.env), s.env, source, dest, { apply: true, temporaryRoots: [] }).status, "completed");
});

test("failed publication holds its sole source beyond parent end and expiry until recovery is confirmed", async () => {
  const s = sim({ mounted: false }), input = { session_id: "failed-copy-676767676767" };
  hook(s, "session-start", "claude", input);
  const source = mk(path.join(s.int, "scratch", "c-676767676767", "tmp", "only-copy"), "unique unfinished work");
  const dest = path.join(s.home, "evidence", "result");
  assert.throws(() => publishFile(loadConf(s.env), s.env, source, dest, { apply: true, temporaryRoots: [], onPhase: (phase) => {
    if (phase === "copied") { hook(s, "session-end", "claude", input); throw new Error("injected copy verification failure"); }
  } }), /source held by lease/);
  const hold = readLeases(s.env).leases[0];
  assert.equal(hold.status, "held"); assert.equal(hold.expiresAt, null);
  assert.equal(protections(s.env, Date.now() + 365 * 86400000).protect(source), true);
  cli(s, ["housekeeping", "--apply"]); assert.ok(fs.existsSync(source));
  assert.equal(cli(s, ["leases", "release", hold.id, "--apply"]).status, 1, "ordinary job release cannot discard recovery protection");
  const recovered = mk(path.join(s.home, "evidence", "recovered"), fs.readFileSync(source));
  assert.equal(cli(s, ["leases", "release", hold.id, "--recovery-confirmed", "--apply"]).status, 0);
  cli(s, ["reap", "--apply"]); assert.ok(await gone(source));
  assert.equal(fs.readFileSync(recovered, "utf8"), "unique unfinished work");
});

test("the run shim reports a child's signal exit status", () => {
  const s = sim();
  const r = cli(s, ["run", "--", "/bin/sh", "-c", "kill -TERM $$"]);
  assert.equal(r.status, 143);
});

test("inspection, housekeeping preview, lease preview and doctor do not write state", () => {
  const s = sim();
  const before = treeDigest(s.home);
  for (const args of [["status", "--json"], ["housekeeping", "--json"], ["reap", "--json"], ["leases", "create", "--path", s.int], ["locks"], ["doctor", "--no-gui", "--json"]]) cli(s, args);
  assert.equal(treeDigest(s.home), before);
});

test("lock age cannot evict a living owner; an old owner cannot unlock a replacement", () => {
  const s = sim({ mounted: false }), lock = path.join(stateDir(s.env), "lifecycle.lock");
  writeFileAtomic(lock, JSON.stringify({ pid: process.pid, token: "current" }));
  const old = new Date(Date.now() - 86400000); fs.utimesSync(lock, old, old);
  assert.equal(withLock(lock, () => assert.fail("must not steal")).locked, true);
  assert.throws(() => recoverLock(s.env, "lifecycle", { apply: true }), /alive/);
  fs.unlinkSync(lock);
  withLock(lock, () => { fs.unlinkSync(lock); writeFileAtomic(lock, JSON.stringify({ pid: process.pid, token: "replacement" })); });
  assert.equal(JSON.parse(fs.readFileSync(lock)).token, "replacement");
});

test("explicit dead-owner recovery is preview-only unless applied", () => {
  const s = sim({ mounted: false }), lock = path.join(stateDir(s.env), "lifecycle.lock");
  const child = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  assert.equal(child.status, 0);
  writeFileAtomic(lock, JSON.stringify({ pid: child.pid, token: "dead-owner" }));
  assert.equal(inspectLocks(s.env)[0].alive, false);
  assert.equal(recoverLock(s.env, "lifecycle").status, "preview"); assert.ok(fs.existsSync(lock));
  assert.equal(recoverLock(s.env, "lifecycle", { apply: true }).status, "recovered");
  assert.equal(fs.existsSync(lock), false);
});

test("SessionEnd bounds a stalled Git probe and leaves deferred ownership for retry", () => {
  const s = sim({ mounted: false }), project = repo(s);
  const input = { session_id: "deadline-999999999999", cwd: project };
  hook(s, "session-start", "codex", input);
  mk(path.join(project, ".build", "keep-until-verified"));
  fs.unlinkSync(path.join(project, ".git", "config"));
  const fifo = spawnSync("/usr/bin/mkfifo", [path.join(project, ".git", "config")]); assert.equal(fifo.status, 0);
  const start = Date.now(), ended = hook(s, "session-end", "codex", input);
  assert.equal(ended.status, 0, ended.stderr); assert.ok(Date.now() - start < 2000);
  assert.ok(fs.existsSync(path.join(s.sessions, "x-999999999999.mode")), "unverified Git cleanup remains deferred");
});

test("a timed-out repo check is reported and does not suppress cleanup for a week", async () => {
  const s = sim({ mounted: false }), project = repo(s);
  const output = mk(path.join(project, ".build", "retry-after-verification"));
  const config = path.join(project, ".git", "config"), original = fs.readFileSync(config);
  fs.unlinkSync(config);
  assert.equal(spawnSync("/usr/bin/mkfifo", [config]).status, 0);
  const old = new Date(Date.now() - 30 * 86400000);
  for (const p of [output, path.dirname(output), path.join(project, ".gitignore"), path.join(project, ".clean-development.json"), path.join(project, ".git", "HEAD"), path.dirname(config), project]) fs.utimesSync(p, old, old);
  const first = cli(s, ["housekeeping", "--apply", "--json"]);
  assert.equal(first.status, 0, first.stderr);
  const result = JSON.parse(first.stdout).result;
  assert.ok(result.repoBlocked?.some((r) => r.reason === "ETIMEDOUT"), first.stdout);
  assert.equal(result.deferred, true);
  const stamp = path.join(stateDir(s.env), "stamps", "repos");
  assert.equal(fs.existsSync(stamp), false, "an incomplete pass must remain due");
  assert.ok(fs.existsSync(output));
  const blocked = hook(s, "stop", "claude", { session_id: "retry-898989898989" });
  assert.equal(blocked.status, 0, blocked.stderr);
  const event = JSON.parse(fs.readFileSync(path.join(stateDir(s.env), "events.jsonl"), "utf8").trim().split("\n").at(-1));
  assert.equal(event.status, "deferred");
  assert.ok(event.repoBlocked.some((r) => r.reason === "ETIMEDOUT"));
  assert.equal(fs.existsSync(stamp), false);
  fs.unlinkSync(config); fs.writeFileSync(config, original); fs.utimesSync(path.dirname(config), old, old);
  const second = hook(s, "stop", "claude", { session_id: "retry-898989898989" });
  assert.equal(second.status, 0, second.stderr);
  assert.ok(await gone(output), "the next ordinary Stop must retry after Git recovers");
  assert.ok(fs.existsSync(stamp));
});

test("doctor rejects duplicate/stale hooks, wrong options and distinguishes disabled trust", () => {
  const s = sim();
  const doc = JSON.parse(fs.readFileSync(path.join(plugin, "fragments", "codex-hooks.json"), "utf8").replaceAll("/Users/bolyki", s.home));
  const configPath = path.join(s.home, ".codex", "hooks.json"); mk(configPath, JSON.stringify(doc));
  let d = JSON.parse(cli(s, ["doctor", "--no-gui", "--json"]).stdout);
  assert.equal(d.results.find((r) => r.name === "Codex hooks").ok, true);
  doc.hooks.Stop.push({ hooks: [{ type: "command", command: `'/h/dev/machine/runtime/clean-development/0.5.0/bin/cd-hook' stop codex` }] });
  mk(configPath, JSON.stringify(doc));
  d = JSON.parse(cli(s, ["doctor", "--no-gui", "--json"]).stdout);
  assert.equal(d.results.find((r) => r.name === "Codex hooks").ok, false);
  doc.hooks.Stop.pop(); doc.hooks.Stop[0].hooks[0].timeout = 1; mk(configPath, JSON.stringify(doc));
  d = JSON.parse(cli(s, ["doctor", "--no-gui", "--json"]).stdout);
  assert.match(d.results.find((r) => r.name === "Codex hooks").detail, /timeout/);
  doc.hooks.Stop[0].hooks[0].timeout = 300; mk(configPath, JSON.stringify(doc));
  mk(path.join(s.home, ".codex", "config.toml"), `[hooks.state.${JSON.stringify(`${configPath}:stop:0:0`)}]\nenabled = false\n`);
  d = JSON.parse(cli(s, ["doctor", "--no-gui", "--json"]).stdout);
  assert.match(d.results.find((r) => r.name === "Codex hook trust").detail, /disabled/);
  assert.match(d.results.find((r) => r.name === "Codex hooks").detail, new RegExp(VERSION.replaceAll(".", "\\.")));
});
