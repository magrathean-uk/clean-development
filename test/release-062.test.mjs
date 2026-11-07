// 0.6.2 acceptance tests (report-2026-11-05 section 8, R1-R5, R10, R13). Fixtures only, under CLEAN_DEV_TEST_DIR.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { cli, hook, mk, plugin, repo, sim, waitFor } from "./helpers.mjs";
import { VERSION, hookShimPath, hookShimText, loadConf } from "../runtime/lib/conf.mjs";
import { installPackage } from "../installer.mjs";
import { managedTrustEntries } from "../runtime/lib/codex-trust.mjs";
import { flushDeletes, LOG_KEEP, LOG_ROTATE_BYTES, rotate } from "../runtime/lib/fsutil.mjs";
import { HOUR, sweepTrash } from "../runtime/lib/prune.mjs";
import { layout } from "../runtime/lib/storage.mjs";
import { classify } from "../runtime/lib/sessions.mjs";
import { pidFileJobs, resetProcessTable } from "../runtime/lib/activity.mjs";
import { createLease } from "../runtime/lib/leases.mjs";

const agePath = (p, hours) => { const t = new Date(Date.now() - hours * 3600e3); fs.utimesSync(p, t, t); };
function ageTree(p, hours, skip = () => false) {
  if (!fs.existsSync(p)) return;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const c = path.join(p, e.name);
    if (e.isDirectory()) ageTree(c, hours, skip); else if (!skip(c)) agePath(c, hours);
  }
  agePath(p, hours);
}
const ageSession = (s, key, hours, skip) => {
  for (const f of fs.readdirSync(s.sessions)) if (f.startsWith(`${key}.`)) agePath(path.join(s.sessions, f), hours);
  for (const root of [s.int, s.ext]) for (const k of ["scratch", "builds"]) ageTree(path.join(root, k, key), hours, skip);
};
const live = (s, key) => classify(loadConf(s.env), s.env).find((x) => x.key === key);
const rows = (file) => fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const stateFile = (s, name) => path.join(s.home, "dev", "machine", "state", "clean-development", name);
const sleeper = () => { const p = spawn("/bin/sleep", ["120"], { stdio: "ignore" }); return p; };
const env = (s, extra) => ({ ...s, env: { ...s.env, ...extra } });

test("R1: 0.6.2 everywhere; hooks use the version-less shim, which survives an upgrade with the same trust hash", () => {
  const s = sim();
  assert.equal(cli(s, ["version"]).stdout.trim(), VERSION);
  for (const h of ["claude", "codex"]) for (const groups of Object.values(JSON.parse(fs.readFileSync(path.join(plugin, "fragments", `${h}-hooks.json`), "utf8")).hooks))
    for (const g of groups) for (const x of g.hooks) { assert.match(x.command, /\/runtime\/clean-development\/active\/bin\/cd-hook/); assert.ok(!x.command.includes(VERSION)); }
  installPackage(plugin, s.env, { config: true });
  const shim = hookShimPath(s.env);
  assert.equal(fs.readFileSync(shim, "utf8"), hookShimText(s.env, VERSION));
  const doc = { hooks: { SessionStart: [{ matcher: "startup|resume|clear|compact|fork", hooks: [{ type: "command", command: `'${shim}' session-start codex`, timeout: 30 }] }] } };
  const before = managedTrustEntries("/h/hooks.json", doc);
  assert.equal(before.length, 1);
  const run = () => spawnSync("/bin/sh", [shim, "session-start", "claude"], { input: JSON.stringify({ session_id: "77777777-7777-4777-8777-0000000000a1", cwd: s.root }),
    env: { ...s.env, CLEAN_DEV_NODE: process.execPath }, encoding: "utf8", timeout: 20000 });
  const first = run();
  assert.equal(first.status, 0);
  assert.match(JSON.parse(first.stdout).hookSpecificOutput.additionalContext, new RegExp(`clean-development ${VERSION.replaceAll(".", "\\.")}`));
  // Upgrade to a (fabricated) next release: the shim names it, the hook command text and its trust hash do not change.
  const src = path.join(s.root, "next"), next = VERSION.replace(/\d+$/, (n) => String(Number(n) + 1));
  for (const d of ["runtime", "machine"]) fs.cpSync(path.join(plugin, d), path.join(src, d), { recursive: true });
  fs.writeFileSync(path.join(src, "runtime", "VERSION"), `${next}\n`);
  // The successor's launcher leaves a marker, so dispatch is proven (exit 0 alone is also the fail-open result).
  const marker = path.join(s.root, "successor-ran");
  fs.writeFileSync(path.join(src, "runtime", "bin", "cd-hook.mjs"), `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(" ") + String.fromCharCode(10));`);
  // A failed upgrade restores the predecessor shim byte for byte, mode included.
  const prior = fs.readFileSync(shim), priorMode = fs.statSync(shim).mode & 0o777;
  assert.throws(() => installPackage(src, s.env, { onPhase: (p) => { if (p === "layout-ready") throw new Error("injected"); } }), /rolled-back/);
  assert.deepEqual(fs.readFileSync(shim), prior); assert.equal(fs.statSync(shim).mode & 0o777, priorMode);
  installPackage(src, s.env);
  assert.equal(fs.readFileSync(shim, "utf8"), hookShimText(s.env, next));
  assert.deepEqual(managedTrustEntries("/h/hooks.json", doc), before);
  assert.equal(run().status, 0);
  assert.equal(fs.readFileSync(marker, "utf8").trim(), "session-start claude");
  // A shim naming a missing release fails open: exit 0, no output.
  const dangling = path.join(s.root, "dangling-shim");
  fs.writeFileSync(dangling, hookShimText(s.env, "9.9.9"), { mode: 0o755 });
  const r = spawnSync("/bin/sh", [dangling, "stop", "claude"], { input: "{}", encoding: "utf8" });
  assert.equal(r.status, 0); assert.equal(r.stdout, "");
});

test("R1/F1: a file written to a Codex thread's TMPDIR survives session-end and resume; the window then expires", async () => {
  const s = sim();
  const id = "019a2b3c-4d5e-7f60-8a9b-00000000c0de", key = "x-00000000c0de";
  assert.equal(hook(s, "session-start", "codex", { session_id: id, cwd: s.root, source: "startup" }).status, 0);
  const work = mk(path.join(s.ext, "scratch", key, "tmp", "work.txt"), "unique bytes");
  assert.equal(hook(s, "session-end", "codex", { session_id: id }).status, 0);
  assert.equal(fs.readFileSync(work, "utf8"), "unique bytes");
  const end = rows(stateFile(s, "events.jsonl")).filter((r) => r.event === "session-end").at(-1);
  assert.equal(end.outcome, "completed"); assert.match(end.reason, /retained: ended; Codex resume window/);
  const generation = JSON.parse(fs.readFileSync(path.join(s.sessions, `${key}.json`), "utf8")).generation;
  assert.equal(hook(s, "session-start", "codex", { session_id: id, source: "resume" }).status, 0);
  assert.equal(fs.readFileSync(work, "utf8"), "unique bytes");
  const meta = JSON.parse(fs.readFileSync(path.join(s.sessions, `${key}.json`), "utf8"));
  assert.equal(meta.phase, "live"); assert.notEqual(meta.generation, generation);
  hook(s, "session-end", "codex", { session_id: id });
  ageSession(s, key, 25);
  assert.equal(cli(s, ["reap", "--apply"]).status, 0);
  flushDeletes();
  assert.ok(await waitFor(() => !fs.existsSync(path.join(s.ext, "scratch", key)), 15000));
});

test("R2: a trash entry with a nested mode-000 dir and two normal entries are all removed in one sweep", async () => {
  const s = sim();
  const trash = layout(s.int).trash;
  const stuck = path.join(trash, "x-309722634566-1");
  mk(path.join(stuck, "claude-tasks", "fixture-job", "unreadable", "secret"));
  mk(path.join(trash, "plain-a", "f")); mk(path.join(trash, "plain-b", "g"));
  fs.chmodSync(path.join(stuck, "claude-tasks", "fixture-job", "unreadable"), 0o000);
  const swept = sweepTrash(s.int, { now: Date.now() + 2 * HOUR, eventsFile: stateFile(s, "deletions.jsonl") });
  assert.equal(swept.length, 3);
  flushDeletes();
  assert.ok(await waitFor(() => ["x-309722634566-1", "plain-a", "plain-b"].every((n) => !fs.existsSync(path.join(trash, n))), 15000));
  assert.ok(await waitFor(() => rows(stateFile(s, "deletions.jsonl")).filter((r) => r.event === "delete" && r.status === "completed").length === 3, 15000));
});

test("R2: a trash entry that still hosts a running *.pid job is retained, then swept once the job ends", async () => {
  const s = sim();
  const entry = path.join(layout(s.int).trash, "x-7dc983fd6f87-1");
  const job = sleeper();
  try {
    mk(path.join(entry, "tmp", "m204c-fix2", "check.pid"), `${job.pid}\n`);
    assert.equal(sweepTrash(s.int, { now: Date.now() + 2 * HOUR }).length, 0);
    assert.ok(fs.existsSync(entry));
    job.kill("SIGKILL");
    assert.ok(await waitFor(() => spawnSync("/bin/kill", ["-0", String(job.pid)]).status !== 0, 5000));
    assert.equal(sweepTrash(s.int, { now: Date.now() + 2 * HOUR, dryRun: true }).length, 1);
  } finally { job.kill("SIGKILL"); }
});

test("R2: a trash entry that cannot be fully inspected is retained for 30 days, then swept", () => {
  const s = sim();
  const entry = path.join(layout(s.int).trash, "x-0000000000aa-1");
  for (let i = 0; i < 65; i++) mk(path.join(entry, `j${i}.pid`), "999999\n");
  assert.equal(sweepTrash(s.int, { now: Date.now() + 8 * 24 * HOUR, dryRun: true }).length, 0);
  assert.equal(sweepTrash(s.int, { now: Date.now() + 31 * 24 * HOUR, dryRun: true }).length, 1);
});

test("R2: an unreadable trash directory never fails Stop; the other stages still run", () => {
  const s = sim();
  const id = "88888888-8888-4888-8888-0000000000b2";
  hook(s, "session-start", "claude", { session_id: id, cwd: s.root });
  const trash = layout(s.int).trash;
  fs.mkdirSync(trash, { recursive: true }); fs.chmodSync(trash, 0o000);
  try {
    const r = hook(s, "stop", "claude", { session_id: id });
    assert.equal(r.status, 0);
    const row = rows(stateFile(s, "events.jsonl")).filter((x) => x.event === "stop").at(-1);
    assert.ok(["completed", "deferred"].includes(row.outcome), JSON.stringify(row));
    assert.equal(typeof row.durationMs, "number");
    assert.ok(!/stop claude: /.test(fs.existsSync(stateFile(s, "hook.log")) ? fs.readFileSync(stateFile(s, "hook.log"), "utf8") : ""));
  } finally { fs.chmodSync(trash, 0o700); }
});

test("R3: a failed rename keeps the original byte-identical, records skipped-rename-failed and is retried next run", async () => {
  const s = sim();
  const id = "99999999-9999-4999-8999-0000000000c3", key = "c-0000000000c3";
  hook(s, "session-start", "claude", { session_id: id, cwd: s.root });
  const keep = mk(path.join(s.ext, "scratch", key, "tmp", "keep.txt"), "original bytes");
  const trash = layout(s.ext).trash;
  fs.mkdirSync(trash, { recursive: true }); fs.chmodSync(trash, 0o555);
  try {
    assert.equal(hook(s, "session-end", "claude", { session_id: id }).status, 0);
    assert.equal(fs.readFileSync(keep, "utf8"), "original bytes");
    const skipped = rows(stateFile(s, "deletions.jsonl")).filter((r) => r.status === "skipped-rename-failed");
    assert.equal(skipped.length, 1); assert.equal(skipped[0].source, path.join(s.ext, "scratch", key)); assert.ok(skipped[0].error);
    assert.ok(fs.existsSync(path.join(s.sessions, `${key}.json`)), "pin retained for the retry");
  } finally { fs.chmodSync(trash, 0o700); }
  assert.equal(cli(s, ["reap", "--apply"]).status, 0);
  flushDeletes();
  assert.ok(await waitFor(() => !fs.existsSync(path.join(s.ext, "scratch", key)), 15000));
});

test("R4: 400 .mode-only stubs aged 8 days with no process are reaped in preview; nothing is written", () => {
  const s = sim();
  fs.mkdirSync(s.sessions, { recursive: true });
  for (let i = 0; i < 400; i++) {
    const key = `x-${String(i).padStart(12, "0")}`;
    fs.writeFileSync(path.join(s.sessions, `${key}.mode`), "external\n# env.zsh test\n");
    if (i % 8 === 0) mk(path.join(s.ext, "scratch", key, "tmp", "f"));
    ageSession(s, key, 8 * 24);
  }
  const t0 = Date.now();
  const r = cli(s, ["reap", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.reaped.length, 400); assert.equal(out.live.length, 0);
  assert.ok(Date.now() - t0 < 60000);
  assert.equal(fs.readdirSync(s.sessions).length, 400);
});

test("R4: a leased job whose mtimes are 48 h old is kept", () => {
  const s = sim();
  const id = "aaaaaaaa-0000-4000-8000-0000000000d4", key = "c-0000000000d4";
  hook(s, "session-start", "claude", { session_id: id, cwd: s.root });
  const dir = path.join(s.ext, "scratch", key);
  mk(path.join(dir, "tmp", "job", "out.log"));
  ageSession(s, key, 48);
  assert.equal(live(s, key).done, true);
  createLease(loadConf(s.env), s.env, [path.join(dir, "tmp", "job")], { minutes: 60 });
  const x = live(s, key);
  assert.equal(x.done, false); assert.equal(x.liveReason, "explicit lease");
  assert.ok(JSON.parse(cli(s, ["reap", "--json"]).stdout).live.some((l) => l.key === key));
});

test("R4: a running job named by a *.pid file keeps its scratch, also after session-end; it is reaped once the job ends", async () => {
  const s = sim();
  const id = "bbbbbbbb-0000-4000-8000-0000000000e5", key = "c-0000000000e5";
  hook(s, "session-start", "claude", { session_id: id, cwd: s.root });
  const job = sleeper();
  try {
    const pidFile = mk(path.join(s.ext, "scratch", key, "tmp", "m204c-fix2", "check.pid"), `${job.pid}\n`);
    mk(path.join(s.ext, "scratch", key, "tmp", "m204c-fix2", "check.log"), "running");
    ageSession(s, key, 48, (p) => p === pidFile);
    assert.match(live(s, key).liveReason, /^job pid \d+ \(tmp\/m204c-fix2\/check\.pid\)$/);
    assert.equal(hook(s, "session-end", "claude", { session_id: id }).status, 0);
    assert.ok(fs.existsSync(path.join(s.ext, "scratch", key, "tmp", "m204c-fix2", "check.log")));
    assert.equal(live(s, key).done, false);
    job.kill("SIGKILL");
    assert.ok(await waitFor(() => spawnSync("/bin/kill", ["-0", String(job.pid)]).status !== 0, 5000));
    agePath(pidFile, 48);
    assert.equal(live(s, key).done, true);
    assert.equal(cli(s, ["reap", "--apply"]).status, 0);
    flushDeletes();
    assert.ok(await waitFor(() => !fs.existsSync(path.join(s.ext, "scratch", key)), 15000));
  } finally { job.kill("SIGKILL"); }
});

test("R4: the recorded harness process (pid plus start time) keeps an idle session live; deep writes count as activity", async () => {
  const s = sim();
  const harness = sleeper();
  try {
    const id = "cccccccc-0000-4000-8000-0000000000f6", key = "c-0000000000f6";
    assert.equal(hook(env(s, { CLEAN_DEV_TEST_HARNESS_PID: String(harness.pid) }), "session-start", "claude", { session_id: id, cwd: s.root }).status, 0);
    const owner = JSON.parse(fs.readFileSync(path.join(s.sessions, `${key}.json`), "utf8")).owner;
    assert.equal(owner.pid, harness.pid); assert.ok(Number.isFinite(owner.startedAt));
    ageSession(s, key, 48);
    assert.equal(live(s, key).liveReason, `harness process ${harness.pid}`);
    harness.kill("SIGKILL");
    assert.ok(await waitFor(() => spawnSync("/bin/kill", ["-0", String(harness.pid)]).status !== 0, 5000));
    assert.equal(live(s, key).done, true);
    const deep = mk(path.join(s.ext, "scratch", key, "tmp", "a", "b", "c", "append.log"), "fresh");
    ageSession(s, key, 48, (p) => p === deep);
    assert.equal(live(s, key).liveReason, "deep activity");
    agePath(deep, 48);
    assert.equal(live(s, key).done, true);
  } finally { harness.kill("SIGKILL"); }
});

test("R4: placeholder and short session ids are rejected with a warning; existing rejected pins stay until every signal is quiet for 7 days", () => {
  const s = sim();
  const r = hook(s, "session-start", "claude", { session_id: "aaaaaaaa-to-be-unset", cwd: s.root });
  assert.equal(r.status, 0);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /Session id rejected \(placeholder value\)/);
  assert.ok(!fs.existsSync(path.join(s.sessions, "c--to-be-unset.mode")));
  // A shared placeholder key: one user's .ended says nothing about the others, so it does not end the session.
  mk(path.join(s.sessions, "c--to-be-unset.mode"), "external\n"); mk(path.join(s.sessions, "c--to-be-unset.ended"), "");
  mk(path.join(s.sessions, "x-KEY1.mode"), "internal\n"); mk(path.join(s.ext, "scratch", "x-KEY1", "tmp", "f"), "x");
  for (const k of ["c--to-be-unset", "x-KEY1"]) ageSession(s, k, 6 * 24);
  for (const k of ["c--to-be-unset", "x-KEY1"]) { const x = live(s, k); assert.equal(x.done, false); assert.match(x.liveReason, /^rejected key \(.+\); 7-day window$/); }
  assert.match(cli(s, ["status"]).stdout, /rejected session keys \(no new routing; reaped after 7 quiet days\): c--to-be-unset x-KEY1/);
  // Any user's deep write within 7 days keeps it; 7 quiet days on every signal reaps it.
  const deep = mk(path.join(s.ext, "scratch", "x-KEY1", "tmp", "a", "b", "f2"), "x");
  ageSession(s, "x-KEY1", 8 * 24, (p) => p === deep);
  assert.equal(live(s, "x-KEY1").liveReason, "deep activity");
  for (const k of ["c--to-be-unset", "x-KEY1"]) ageSession(s, k, 8 * 24);
  for (const k of ["c--to-be-unset", "x-KEY1"]) assert.equal(live(s, k).done, true);
});

test("R5: an external root unwritable once but writable 5 s later probes external; the reason is stored in the pin", () => {
  const s = sim();
  fs.chmodSync(s.ext, 0o500);
  const fixer = spawn("/bin/sh", ["-c", `sleep 0.5; chmod 700 '${s.ext}'`], { stdio: "ignore" });
  try {
    const r = hook(env(s, { CLEAN_DEV_PROBE_RETRY_MS: "2500" }), "session-start", "claude", { session_id: "dddddddd-0000-4000-8000-0000000000a7", cwd: s.root });
    assert.equal(r.status, 0);
    const meta = JSON.parse(fs.readFileSync(path.join(s.sessions, "c-0000000000a7.json"), "utf8"));
    assert.equal(meta.mode, "external"); assert.equal(meta.probeAttempts, 2); assert.match(meta.modeReason, /mounted and writable/);
  } finally { fixer.kill(); fs.chmodSync(s.ext, 0o700); }
  fs.chmodSync(s.ext, 0o500);
  try {
    hook(env(s, { CLEAN_DEV_PROBE_RETRY_MS: "50" }), "session-start", "claude", { session_id: "dddddddd-0000-4000-8000-0000000000b8", cwd: s.root });
    const meta = JSON.parse(fs.readFileSync(path.join(s.sessions, "c-0000000000b8.json"), "utf8"));
    assert.equal(meta.mode, "internal"); assert.match(meta.modeReason, /not writable \(EACCES; 2 write probes/);
  } finally { fs.chmodSync(s.ext, 0o700); }
});

test("storage follows the drive: no stale state; Stop records the root in use and prints nothing; status names the work root", () => {
  const s = sim();
  const away = env(s, { DEV_STORAGE_VOLUME_TEST: "absent" });
  const id = "eeeeeeee-0000-4000-8000-0000000000c9", key = "c-0000000000c9";
  const meta = () => JSON.parse(fs.readFileSync(path.join(s.sessions, `${key}.json`), "utf8"));
  const start = JSON.parse(hook(away, "session-start", "claude", { session_id: id, cwd: s.root }).stdout).hookSpecificOutput.additionalContext;
  assert.match(start, /mode=internal/); assert.match(start, /All development runs on the internal disk: builds, test suites, gates/);
  assert.match(start, /Work root CLEAN_DEV_WORK=.*\/home\/dev\/machine\./); assert.match(start, /Storage follows the configured external volume per shell/);
  assert.doesNotMatch(start, /suggest waiting|source edits only|ask the user to restart|pinned/);
  assert.deepEqual(meta().ownedRoots, [s.int]);
  const r = hook(s, "stop", "claude", { session_id: id });
  assert.equal(r.status, 0); assert.equal(r.stdout, "", "no per-turn reminder any more");
  assert.deepEqual(meta().ownedRoots, [s.int, s.ext], "the Stop records the root new shells use now");
  let st = JSON.parse(cli(env(s, { CLAUDE_CODE_SESSION_ID: id }), ["status", "--json"]).stdout);
  assert.equal(st.mode, "external"); assert.equal(st.staleInternal, undefined); assert.equal(st.work, path.join(s.vol, "dev"));
  fs.mkdirSync(path.join(s.vol, "dev"), { recursive: true });
  st = JSON.parse(cli(env(s, { CLAUDE_CODE_SESSION_ID: id }), ["status", "--json"]).stdout);
  assert.equal(st.work, path.join(s.vol, "dev"));
  assert.match(cli(env(s, { CLAUDE_CODE_SESSION_ID: id }), ["status"]).stdout, new RegExp(`^work root CLEAN_DEV_WORK=${s.vol}/dev`, "m"));
  assert.doesNotMatch(cli(s, ["status"]).stdout, /stale/);
  assert.match(JSON.parse(hook(s, "session-start", "claude", { session_id: id, source: "resume" }).stdout).hookSpecificOutput.additionalContext, /mode=external/);
});

test("storage follows the drive: a session that used both roots is cleaned on both; while external storage is away its pin waits", async () => {
  const s = sim();
  const away = env(s, { DEV_STORAGE_VOLUME_TEST: "absent" });
  const id = "eeeeeeee-0000-4000-8000-0000000000d1", key = "c-0000000000d1";
  hook(s, "session-start", "claude", { session_id: id, cwd: s.root });
  const extFile = mk(path.join(s.ext, "scratch", key, "tmp", "on-external-volume"));
  hook(away, "stop", "claude", { session_id: id });
  const intFile = mk(path.join(s.int, "scratch", key, "tmp", "on-internal")), intBuild = mk(path.join(s.int, "builds", key, "obj"));
  assert.equal(hook(away, "session-end", "claude", { session_id: id }).status, 0);
  assert.ok(await waitFor(() => !fs.existsSync(intFile) && !fs.existsSync(intBuild), 15000), "internal scratch and builds removed");
  assert.ok(fs.existsSync(extFile), "external scratch waits for the volume");
  assert.ok(fs.existsSync(path.join(s.sessions, `${key}.mode`)) && fs.existsSync(path.join(s.sessions, `${key}.ended`)), "pin kept, ended");
  const other = "eeeeeeee-0000-4000-8000-0000000000d2";
  hook(s, "session-start", "claude", { session_id: other, cwd: s.root });
  assert.equal(hook(s, "stop", "claude", { session_id: other }).status, 0);
  assert.ok(await waitFor(() => !fs.existsSync(extFile), 15000), "cleaned once external storage returns");
  assert.ok(!fs.existsSync(path.join(s.sessions, `${key}.mode`)), "pin dropped");
});

test("storage follows the drive: a session that started internal and used the external volume later keeps its pin while storage is away (ownedRoots only)", async () => {
  const s = sim();
  const away = env(s, { DEV_STORAGE_VOLUME_TEST: "absent" });
  const id = "eeeeeeee-0000-4000-8000-0000000000d4", key = "c-0000000000d4";
  hook(away, "session-start", "claude", { session_id: id, cwd: s.root });
  hook(s, "stop", "claude", { session_id: id });
  const extFile = mk(path.join(s.ext, "scratch", key, "tmp", "on-external-volume"));
  assert.equal(fs.readFileSync(path.join(s.sessions, `${key}.mode`), "utf8"), "internal\n");
  assert.ok(!fs.existsSync(path.join(s.sessions, `${key}.lost`)));
  hook(away, "session-end", "claude", { session_id: id });
  assert.ok(fs.existsSync(path.join(s.sessions, `${key}.mode`)) && fs.existsSync(path.join(s.sessions, `${key}.ended`)), "kept by ownedRoots alone");
  const other = "eeeeeeee-0000-4000-8000-0000000000d5";
  hook(s, "session-start", "claude", { session_id: other, cwd: s.root });
  hook(s, "stop", "claude", { session_id: other });
  assert.ok(await waitFor(() => !fs.existsSync(extFile) && !fs.existsSync(path.join(s.sessions, `${key}.mode`)), 15000));
});

test("storage follows the drive: repo build output of a session that ran internal is cleaned even after it resumed external", async () => {
  const s = sim();
  const away = env(s, { DEV_STORAGE_VOLUME_TEST: "absent" });
  const project = repo(s), out = mk(path.join(project, ".build", "obj"));
  const id = "eeeeeeee-0000-4000-8000-0000000000d6";
  hook(away, "session-start", "claude", { session_id: id, cwd: project });
  hook(s, "session-start", "claude", { session_id: id, cwd: project, source: "resume" });
  const meta = JSON.parse(fs.readFileSync(path.join(s.sessions, "c-0000000000d6.json"), "utf8"));
  assert.equal(meta.mode, "external"); assert.deepEqual(meta.ownedRoots, [s.int, s.ext]);
  hook(s, "session-end", "claude", { session_id: id, cwd: project });
  assert.ok(await waitFor(() => !fs.existsSync(out), 15000), "declared, git-ignored build dir removed");
});

test("storage follows the drive: a session that never used the external volume drops its pin at session end while storage is away", async () => {
  const s = sim();
  const away = env(s, { DEV_STORAGE_VOLUME_TEST: "absent" });
  const id = "eeeeeeee-0000-4000-8000-0000000000d3", key = "c-0000000000d3";
  hook(away, "session-start", "claude", { session_id: id, cwd: s.root });
  const intFile = mk(path.join(s.int, "scratch", key, "tmp", "x"));
  hook(away, "session-end", "claude", { session_id: id });
  assert.ok(await waitFor(() => !fs.existsSync(intFile), 15000));
  assert.ok(!fs.existsSync(path.join(s.sessions, `${key}.mode`)));
});

test("R10: run --clean-env and env --child keep routing and drop harness variables and secrets", () => {
  const s = sim();
  const e = env(s, { CLAUDE_CODE_SESSION_ID: "ffffffff-0000-4000-8000-0000000000e1", CLAUDECODE: "1", ANTHROPIC_API_KEY: "sk-test-not-real", GH_TOKEN: "test-not-real",
    TMPDIR: "/fixture/scratch/c-0000000000e1/tmp", CLEAN_DEV_BUILDS: "/fixture/builds/c-0000000000e1", DEVCACHE: "/fixture", CLEAN_DEV_SESSION: "c-0000000000e1",
    CLEAN_DEV_STAMP: "external|/fixture|c-0000000000e1" });
  const r = cli(e, ["run", "--clean-env", "--", "/usr/bin/env"]);
  assert.equal(r.status, 0, r.stderr);
  for (const kept of ["TMPDIR=/fixture/scratch/c-0000000000e1/tmp", "CLEAN_DEV_BUILDS=/fixture/builds/c-0000000000e1", "DEVCACHE=/fixture", "CLEAN_DEV_SESSION=c-0000000000e1"]) assert.ok(r.stdout.includes(kept), kept);
  assert.ok(!/^(CLAUDE|ANTHROPIC|GH_TOKEN)/m.test(r.stdout)); assert.match(r.stderr, /not passed to the child: .*CLAUDE_CODE_SESSION_ID/);
  const j = JSON.parse(cli(e, ["env", "--child", "--format", "json"]).stdout);
  assert.equal(j.TMPDIR, "/fixture/scratch/c-0000000000e1/tmp"); assert.ok(!("CLAUDECODE" in j));
  assert.equal(cli(e, ["run", "--session", "x", "--", "/usr/bin/true"]).status, 0);
});

test("R13: logs rotate at 5 MB keeping 5 generations; receipts carry outcome and duration", () => {
  assert.equal(LOG_ROTATE_BYTES, 5 * 1024 * 1024); assert.equal(LOG_KEEP, 5);
  const s = sim();
  const f = path.join(s.root, "log.jsonl");
  for (let i = 0; i < 8; i++) { fs.appendFileSync(f, "x".repeat(20)); rotate(f, 10, 3); }
  assert.deepEqual(fs.readdirSync(s.root).filter((n) => n.startsWith("log.jsonl")).sort(), ["log.jsonl.1", "log.jsonl.2", "log.jsonl.3"]);
  hook(s, "session-start", "claude", { session_id: "ffffffff-0000-4000-8000-0000000000f2", cwd: s.root });
  const row = rows(stateFile(s, "events.jsonl")).at(-1);
  assert.equal(row.outcome, "completed"); assert.equal(typeof row.durationMs, "number"); assert.equal(row.version, VERSION);
});

test("R4 review: a .mode-only stub stays live for 7 days of idleness; an incomplete (too deep) scan is live for 30 days, then not", () => {
  const s = sim();
  fs.mkdirSync(s.sessions, { recursive: true });
  const stub = "x-00000000st06";
  fs.writeFileSync(path.join(s.sessions, `${stub}.mode`), "external\n");
  ageSession(s, stub, 6 * 24);
  assert.equal(live(s, stub).liveReason, "mode-only stub (7-day window)");
  ageSession(s, stub, 8 * 24);
  assert.equal(live(s, stub).done, true);
  const id = "abababab-0000-4000-8000-00000000dee9", key = "c-00000000dee9";
  hook(s, "session-start", "claude", { session_id: id, cwd: s.root });
  mk(path.join(s.ext, "scratch", key, "tmp", ...Array.from({ length: 10 }, (_, i) => `d${i}`), "f"));
  ageSession(s, key, 48);
  assert.match(live(s, key).liveReason, /^unobserved \(tree too deep\)/);
  ageSession(s, key, 8 * 24);
  assert.match(live(s, key).liveReason, /^unobserved \(tree too deep\)/);
  assert.match(cli(s, ["status"]).stdout, new RegExp(`unobserved for over 7 days \\(kept up to 30; inspect or lease\\): ${key}`));
  ageSession(s, key, 31 * 24);
  assert.equal(live(s, key).done, true);
});

test("R4 review: a running job's *.pid under CLEAN_DEV_BUILDS keeps the session through Claude session-end", async () => {
  const s = sim();
  const id = "acacacac-0000-4000-8000-00000000b11d", key = "c-00000000b11d";
  hook(s, "session-start", "claude", { session_id: id, cwd: s.root });
  const job = sleeper();
  try {
    const pidFile = mk(path.join(s.int, "builds", key, "gate", "gate.pid"), `${job.pid}\n`);
    mk(path.join(s.int, "builds", key, "gate", "out.log"), "fresh output");
    ageSession(s, key, 48, (p) => p === pidFile);
    assert.equal(hook(s, "session-end", "claude", { session_id: id }).status, 0);
    assert.ok(fs.existsSync(path.join(s.int, "builds", key, "gate", "out.log")));
    assert.match(live(s, key).liveReason, /^job pid \d+ \(gate\/gate\.pid\)$/);
  } finally { job.kill("SIGKILL"); }
});

test("R4 review: the real ancestor walk records the harness (no test override) and harness liveness is capped at 7 days", () => {
  const s = sim();
  const e = { ...s.env }; delete e.CLEAN_DEV_TEST_HARNESS_PID;
  const id = "adadadad-0000-4000-8000-00000000a11c", key = "c-00000000a11c";
  const r = spawnSync("/bin/sh", ["-c", `exec '${process.execPath}' '${path.join(plugin, "runtime", "bin", "cd-hook.mjs")}' session-start claude`],
    { input: JSON.stringify({ session_id: id, cwd: s.root }), env: e, encoding: "utf8", timeout: 20000 });
  assert.equal(r.status, 0);
  const owner = JSON.parse(fs.readFileSync(path.join(s.sessions, `${key}.json`), "utf8")).owner;
  assert.equal(owner.pid, process.pid, JSON.stringify(owner)); assert.equal(owner.command, path.basename(process.execPath));
  ageSession(s, key, 48);
  assert.equal(live(s, key).liveReason, `harness process ${process.pid}`);
  ageSession(s, key, 8 * 24);
  assert.equal(live(s, key).done, true);
});

test("R4 review: pid-file inspection honours the caller's deadline per entry and reports it", () => {
  const s = sim();
  const dir = path.join(s.root, "deadline-scratch");
  for (let i = 0; i < 20; i++) mk(path.join(dir, `j${i}`, "job.pid"), "99999\n");
  const r = pidFileJobs(dir, { deadline: Date.now() - 1 });
  assert.equal(r.complete, false); assert.equal(r.reason, "deadline"); assert.equal(r.jobs.length, 0);
  assert.equal(pidFileJobs(dir).complete, true);
});

test("R8: prune --project finds a reaped session's external builds through the ownership index, never stamping builds/<key>", async () => {
  const s = sim();
  const repoA = path.join(s.home, "dev", "source", "alpha"), repoB = path.join(s.home, "dev", "source", "beta");
  for (const r of [repoA, repoB]) { fs.mkdirSync(r, { recursive: true }); spawnSync("/usr/bin/git", ["init", "-q", r]); }
  const a = { id: "aeaeaeae-0000-4000-8000-0000000000aa", key: "c-0000000000aa" }, b = { id: "aeaeaeae-0000-4000-8000-0000000000bb", key: "c-0000000000bb" };
  hook(s, "session-start", "claude", { session_id: a.id, cwd: repoA }); hook(s, "session-start", "claude", { session_id: b.id, cwd: repoB });
  for (const x of [a, b]) mk(path.join(s.ext, "builds", x.key, "obj"), "output");
  assert.deepEqual(fs.readdirSync(path.join(s.ext, "builds", a.key)), ["obj"]);
  for (const x of [a, b]) hook(s, "session-end", "claude", { session_id: x.id });
  assert.ok(!fs.existsSync(path.join(s.sessions, `${a.key}.json`)), "pin dropped at session end");
  const preview = JSON.parse(cli(s, ["prune", "--project", repoA, "--json"]).stdout);
  assert.deepEqual(preview.candidates.map((c) => c.key), [a.key]);
  assert.ok(fs.existsSync(path.join(s.ext, "builds", a.key, "obj")));
  const applied = JSON.parse(cli(s, ["prune", "--project", repoA, "--apply", "--json"]).stdout);
  assert.equal(applied.removed.length, 1);
  assert.ok(await waitFor(() => !fs.existsSync(path.join(s.ext, "builds", a.key)), 15000));
  assert.ok(fs.existsSync(path.join(s.ext, "builds", b.key, "obj")));
});

test("R8: resuming one session in another project makes its build ownership ambiguous", () => {
  const s = sim(), repoA = path.join(s.home, "dev", "source", "alpha"), repoB = path.join(s.home, "dev", "source", "beta");
  for (const r of [repoA, repoB]) { fs.mkdirSync(r, { recursive: true }); spawnSync("/usr/bin/git", ["init", "-q", r]); }
  const id = "aeaeaeae-0000-4000-8000-0000000000ac", key = "c-0000000000ac";
  const first = hook(s, "session-start", "claude", { session_id: id, cwd: repoA });
  assert.equal(first.status, 0, first.stderr);
  const resumed = hook(s, "session-start", "claude", { session_id: id, cwd: repoB, source: "resume" });
  assert.equal(resumed.status, 0, resumed.stderr);
  const ownerIndex = path.join(stateFile(s, "owners"), key);
  assert.equal(fs.existsSync(path.join(ownerIndex, ".owner-conflict")), true);
  const build = path.join(s.ext, "builds", key);
  mk(path.join(build, "obj"), "output from both projects");
  const ended = hook(s, "session-end", "claude", { session_id: id });
  assert.equal(ended.status, 0, ended.stderr);
  for (const repo of [repoA, repoB]) {
    const plan = JSON.parse(cli(s, ["prune", "--project", repo, "--json"]).stdout);
    assert.deepEqual(plan.candidates, []);
    assert.ok(plan.skipped.some((entry) => entry.path === build && entry.reason === "ambiguous project ownership"));
  }
  assert.equal(fs.readFileSync(path.join(build, "obj"), "utf8"), "output from both projects");
});

test("review round 2: >2000 direct children is weak evidence, a deep builder write keeps a session, a linked pin is not inherited", () => {
  const s = sim();
  const id = "afafafaf-0000-4000-8000-0000000000c1", key = "c-0000000000c1";
  hook(s, "session-start", "claude", { session_id: id, cwd: s.root });
  const wide = path.join(s.ext, "builds", key);
  for (let i = 0; i < 2001; i++) mk(path.join(wide, `o${i}`), "x");
  ageSession(s, key, 48);
  assert.equal(live(s, key).liveReason, "unobserved (directory too large to list)");
  ageSession(s, key, 8 * 24);
  assert.equal(live(s, key).liveReason, "unobserved (directory too large to list)");
  ageSession(s, key, 31 * 24);
  assert.equal(live(s, key).done, true);
  fs.rmSync(wide, { recursive: true, force: true });
  const log = mk(path.join(s.ext, "builds", key, "target", "debug", "progress.log"), "still building");
  ageSession(s, key, 48, (p) => p === log);
  assert.equal(live(s, key).liveReason, "deep activity");
});

test("rulings review: an orphan too wide to list is kept 30 days on its own mtime, then reaped", () => {
  const s = sim();
  const orphan = path.join(s.ext, "scratch", "x-0000000000ff");
  for (let i = 0; i < 2001; i++) mk(path.join(orphan, `o${i}`), "x");
  const orphans = () => JSON.parse(cli(s, ["reap", "--json"]).stdout).orphans.map((o) => o.path);
  ageTree(orphan, 8 * 24);
  assert.deepEqual(orphans(), []);
  ageTree(orphan, 31 * 24);
  assert.deepEqual(orphans(), [orphan]);
});

test("rulings review: with ps unreadable an existing pid is unverifiable: kept 30 days in a session and in trash, not forever", () => {
  const s = sim();
  const saved = { t: process.env.DEV_STORAGE_VOLUME_TEST, f: process.env.CLEAN_DEV_TEST_PS_FAIL };
  const job = sleeper();
  try {
    process.env.DEV_STORAGE_VOLUME_TEST = "mounted"; process.env.CLEAN_DEV_TEST_PS_FAIL = "1"; resetProcessTable();
    const entry = path.join(layout(s.int).trash, "x-0000000000ee-1");
    mk(path.join(entry, "tmp", "job.pid"), `${job.pid}\n`);
    assert.equal(sweepTrash(s.int, { now: Date.now() + 8 * 24 * HOUR, dryRun: true }).length, 0);
    assert.equal(sweepTrash(s.int, { now: Date.now() + 31 * 24 * HOUR, dryRun: true }).length, 1);
    const id = "adadadad-0000-4000-8000-0000000000e1", key = "c-0000000000e1";
    hook(s, "session-start", "claude", { session_id: id, cwd: s.root });
    mk(path.join(s.ext, "scratch", key, "tmp", "job.pid"), `${job.pid}\n`);
    ageSession(s, key, 8 * 24);
    assert.match(live(s, key).liveReason, /^unobserved \(job pid \d+ \(tmp\/job\.pid\), unverifiable\)$/);
    ageSession(s, key, 31 * 24);
    assert.equal(live(s, key).done, true);
  } finally {
    job.kill("SIGKILL");
    for (const [k, v] of [["DEV_STORAGE_VOLUME_TEST", saved.t], ["CLEAN_DEV_TEST_PS_FAIL", saved.f]]) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    resetProcessTable();
  }
});

test("rulings review: a legacy JSON pin for a now-rejected id gets the rejected-key window, not permanent unresolved ownership", () => {
  const s = sim();
  mk(path.join(s.sessions, "x-KEY1.mode"), "internal\n");
  mk(path.join(s.sessions, "x-KEY1.json"), JSON.stringify({ key: "x-KEY1", harness: "codex", sessionId: "KEY1", mode: "internal" }));
  ageSession(s, "x-KEY1", 6 * 24);
  const x = live(s, "x-KEY1");
  assert.deepEqual(x.errors, []);
  assert.match(x.liveReason, /^rejected key \(.+\); 7-day window$/);
  ageSession(s, "x-KEY1", 8 * 24);
  assert.equal(live(s, "x-KEY1").done, true);
  // A placeholder word before 12 clean characters derives a clean-looking key; the full id still rejects it.
  const key = "x-abcdefghijkl";
  mk(path.join(s.sessions, `${key}.mode`), "external\n"); mk(path.join(s.sessions, `${key}.ended`), "");
  mk(path.join(s.sessions, `${key}.json`), JSON.stringify({ key, harness: "codex", sessionId: "unset-abcdefghijkl", mode: "external" }));
  ageSession(s, key, 3 * 24);
  assert.match(live(s, key).liveReason, /^rejected key \(placeholder value\); 7-day window$/);
  ageSession(s, key, 8 * 24);
  assert.equal(live(s, key).done, true);
});
