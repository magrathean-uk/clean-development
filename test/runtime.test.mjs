// clean-development 0.6.0 runtime tests. Hermetic: every test builds its own HOME and simulated 4TB under
// CLEAN_DEV_TEST_DIR (required) and passes them through the environment. Run: CLEAN_DEV_TEST_DIR=/abs/dir node --test test/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const plugin = path.dirname(here);
const rt = path.join(plugin, "runtime");
const base = process.env.CLEAN_DEV_TEST_DIR;
if (!base || !path.isAbsolute(base)) throw new Error("set CLEAN_DEV_TEST_DIR to an absolute scratch directory");
fs.mkdirSync(base, { recursive: true });

let n = 0;
function sim({ mounted = true } = {}) {
  const root = fs.mkdtempSync(path.join(base, `t${++n}-`));
  const home = path.join(root, "home");
  const vol = path.join(root, "Volumes", "4TB");
  fs.mkdirSync(path.join(home, "dev", "machine"), { recursive: true });
  if (mounted) fs.mkdirSync(path.join(vol, "machine", "cache"), { recursive: true });
  const conf = fs.readFileSync(path.join(plugin, "machine", "storage.conf"), "utf8")
    .replace(/^EXTERNAL_ROOT=.*$/m, `EXTERNAL_ROOT=${vol}/machine`)
    .replace(/^LAB_ROOT=.*$/m, `LAB_ROOT=${vol}/dev/lab`)
    .replace(/^MODELS_ROOT=.*$/m, `MODELS_ROOT=${vol}/models`);
  fs.writeFileSync(path.join(home, "dev", "machine", "storage.conf"), conf);
  const env = { HOME: home, PATH: "/usr/bin:/bin", DEV_STORAGE_VOLUME_TEST: mounted ? "mounted" : "absent" };
  return { root, home, vol, env, ext: path.join(vol, "machine", "cache"), int: path.join(home, "dev", "machine", "cache"),
    sessions: path.join(home, "dev", "machine", "state", "clean-development", "sessions") };
}
function hook(s, event, harness, input, extraEnv = {}) {
  return spawnSync(process.execPath, [path.join(rt, "bin", "cd-hook.mjs"), event, harness], {
    input: JSON.stringify(input), env: { ...s.env, ...extraEnv }, encoding: "utf8", timeout: 60000 });
}
function cli(s, args, extraEnv = {}) {
  return spawnSync(process.execPath, [path.join(rt, "bin", "clean-development.mjs"), ...args], { env: { ...s.env, ...extraEnv }, encoding: "utf8", timeout: 120000 });
}
const ctx = (r) => JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
const old = (p, days) => { const t = new Date(Date.now() - days * 86400000); fs.utimesSync(p, t, t); };
async function gone(p, ms = 5000) { const t = Date.now(); while (fs.existsSync(p) && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 50)); return !fs.existsSync(p); }
const mk = (p, bytes = 0) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.alloc(bytes)); };

const { sessionKey } = await import(path.join(rt, "lib", "sessions.mjs"));
const { trustEntries, hookHash, normaliseHandler } = await import(path.join(rt, "lib", "codex-trust.mjs"));
const { parseConf } = await import(path.join(rt, "lib", "conf.mjs"));
const { VERSION } = await import(path.join(rt, "lib", "conf.mjs"));
const { removeManaged } = await import(path.join(rt, "lib", "fsutil.mjs"));

test("session key matches env.zsh derivation", () => {
  assert.equal(sessionKey("claude", "aaaaaaaa-bbbb-4ccc-8ddd-0123456789ab"), "c-0123456789ab");
  assert.equal(sessionKey("codex", "019a2b3c-4d5e-7f60-8a9b-c0d1e2f3a4b5"), "x-c0d1e2f3a4b5");
  assert.equal(sessionKey("codex", "thr_123"), "x-thr_123");
  assert.equal(sessionKey("claude", "bad id with spaces!!"), null);
  assert.equal(sessionKey("other", "abc"), null);
});

test("storage.conf parser: expansion, quoting, rejection", () => {
  const { values, errors } = parseConf("A=/x\nB=${A}/y\nC=\"$HOME/z\"\nD='$A'\nE=$(id)\n", { HOME: "/h" });
  assert.equal(values.B, "/x/y"); assert.equal(values.C, "/h/z"); assert.equal(values.D, "$A");
  assert.ok(errors.some((e) => e.includes("command substitution")));
});

test("session-start external: pin, scratch, context", () => {
  const s = sim();
  const r = hook(s, "session-start", "claude", { session_id: "aaaaaaaa-bbbb-4ccc-8ddd-0123456789ab", cwd: s.home, source: "startup" });
  assert.equal(r.status, 0);
  const text = ctx(r);
  assert.match(text, /mode=external/);
  assert.equal(fs.readFileSync(path.join(s.sessions, "c-0123456789ab.mode"), "utf8"), "external\n");
  assert.ok(fs.statSync(path.join(s.ext, "scratch", "c-0123456789ab", "tmp")).isDirectory());
});

test("session-start internal: 5 GB rule, dead 4TB links tolerated, dot-folders reported", () => {
  const s = sim({ mounted: false });
  fs.mkdirSync(path.join(s.home, "dev", "source"), { recursive: true });
  fs.symlinkSync(path.join(s.vol, "dev", "SpecieX"), path.join(s.home, "dev", "source", "SpecieX"));
  for (const d of [".claude", ".aws", ".insightface", ".opencode", ".gemini", ".cursor"]) fs.mkdirSync(path.join(s.home, d));
  fs.writeFileSync(path.join(s.home, ".zshrc"), "");
  fs.mkdirSync(path.join(s.home, "dev", ".hidden"));
  const r = hook(s, "session-start", "codex", { session_id: "019a2b3c-4d5e-7f60-8a9b-c0d1e2f3a4b5", cwd: s.home });
  assert.equal(r.status, 0);
  const text = ctx(r);
  assert.match(text, /mode=internal/);
  assert.match(text, /over 5 GB: stop, tell G/);
  assert.match(text, /~\/dev\/source\/SpecieX/);
  assert.match(text, /~\/\.gemini/); assert.match(text, /~\/\.cursor/); assert.match(text, /~\/dev\/\.hidden/);
  for (const ok of [".claude", ".aws", ".insightface", ".opencode"]) assert.doesNotMatch(text, new RegExp(`~/\\${ok}[ ,.]`), `${ok} is allowlisted`);
  assert.equal(fs.readFileSync(path.join(s.sessions, "x-c0d1e2f3a4b5.mode"), "utf8"), "internal\n");
});

test("decided once: an internal pin survives reconnection; a lost external pin reports internal", () => {
  const s = sim({ mounted: false });
  hook(s, "session-start", "claude", { session_id: "11111111-1111-4111-8111-111111111111" });
  const again = hook(s, "session-start", "claude", { session_id: "11111111-1111-4111-8111-111111111111", source: "resume" }, { DEV_STORAGE_VOLUME_TEST: "mounted" });
  assert.match(ctx(again), /mode=internal/);
  const t = sim();
  hook(t, "session-start", "claude", { session_id: "22222222-2222-4222-8222-222222222222" });
  const lost = hook(t, "session-start", "claude", { session_id: "22222222-2222-4222-8222-222222222222", source: "resume" }, { DEV_STORAGE_VOLUME_TEST: "absent" });
  assert.match(ctx(lost), /disappeared after this session pinned it/);
});

test("session-end removes this session's scratch and internal builds, keeps others", async () => {
  const s = sim({ mounted: false });
  const a = { session_id: "33333333-3333-4333-8333-aaaaaaaaaaaa" };
  const b = { session_id: "33333333-3333-4333-8333-bbbbbbbbbbbb" };
  hook(s, "session-start", "claude", a); hook(s, "session-start", "claude", b);
  mk(path.join(s.int, "builds", "c-aaaaaaaaaaaa", "out.o"), 10);
  mk(path.join(s.int, "scratch", "c-aaaaaaaaaaaa", "tmp", "x"), 10);
  const r = hook(s, "session-end", "claude", a);
  assert.equal(r.status, 0); assert.equal(r.stdout, "");
  assert.ok(await gone(path.join(s.int, "scratch", "c-aaaaaaaaaaaa")));
  assert.ok(await gone(path.join(s.int, "builds", "c-aaaaaaaaaaaa")));
  assert.ok(fs.existsSync(path.join(s.int, "scratch", "c-bbbbbbbbbbbb", "tmp")));
  assert.ok(!fs.existsSync(path.join(s.sessions, "c-aaaaaaaaaaaa.mode")));
});

test("external session-end deletes scratch but keeps builds", async () => {
  const s = sim();
  const a = { session_id: "44444444-4444-4444-8444-aaaaaaaaaaaa" };
  hook(s, "session-start", "claude", a);
  mk(path.join(s.ext, "builds", "c-aaaaaaaaaaaa", "app"), 10);
  hook(s, "session-end", "claude", a);
  assert.ok(await gone(path.join(s.ext, "scratch", "c-aaaaaaaaaaaa")));
  assert.ok(fs.existsSync(path.join(s.ext, "builds", "c-aaaaaaaaaaaa", "app")));
});

test("stop reaps stale sessions and orphan scratch, wipes internal builds when nobody is live", async () => {
  const s = sim({ mounted: false });
  hook(s, "session-start", "claude", { session_id: "55555555-5555-4555-8555-aaaaaaaaaaaa" });
  for (const f of fs.readdirSync(s.sessions)) old(path.join(s.sessions, f), 2);
  const sc = path.join(s.int, "scratch", "c-aaaaaaaaaaaa"); old(path.join(sc, "tmp"), 2); old(sc, 2);
  mk(path.join(s.int, "scratch", "c-orphan000000", "f")); old(path.join(s.int, "scratch", "c-orphan000000", "f"), 3); old(path.join(s.int, "scratch", "c-orphan000000"), 3);
  mk(path.join(s.int, "builds", "loose", "obj"));
  const r = cli(s, ["housekeeping", "--apply", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(await gone(sc)); assert.ok(await gone(path.join(s.int, "scratch", "c-orphan000000")));
  assert.ok(await gone(path.join(s.int, "builds", "loose")));
});

test("dependency cap evicts least recently used units, never recently used ones", async () => {
  const s = sim();
  const deps = path.join(s.ext, "deps");
  mk(path.join(deps, "npm", "blob"), 900 * 1024); old(path.join(deps, "npm", "blob"), 10); old(path.join(deps, "npm"), 10);
  mk(path.join(deps, "uv", "blob"), 900 * 1024); old(path.join(deps, "uv", "blob"), 1); old(path.join(deps, "uv"), 1);
  mk(path.join(deps, "pip", "blob"), 900 * 1024);
  const conf = path.join(s.home, "dev", "machine", "storage.conf");
  fs.appendFileSync(conf, "DEPS_CAP_GB=0.0018\n");
  const r = cli(s, ["housekeeping", "--apply", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(await gone(path.join(deps, "npm")));
  assert.ok(fs.existsSync(path.join(deps, "pip", "blob")), "recently used unit must stay");
});

test("external builds older than 14 days are pruned, younger kept", async () => {
  const s = sim();
  const b = path.join(s.ext, "builds");
  mk(path.join(b, "x-old000000000", "a")); old(path.join(b, "x-old000000000", "a"), 20); old(path.join(b, "x-old000000000"), 20);
  mk(path.join(b, "x-new000000000", "a")); old(path.join(b, "x-new000000000", "a"), 5); old(path.join(b, "x-new000000000"), 5);
  mk(path.join(b, "DerivedData", "App-abc", "x")); old(path.join(b, "DerivedData", "App-abc", "x"), 30); old(path.join(b, "DerivedData", "App-abc"), 30);
  cli(s, ["housekeeping", "--apply"]);
  assert.ok(await gone(path.join(b, "x-old000000000")));
  assert.ok(await gone(path.join(b, "DerivedData", "App-abc")));
  assert.ok(fs.existsSync(path.join(b, "x-new000000000", "a")));
});

test("repo-local declared build dirs: ignored idle output is removed or explicitly deferred by a bounded check", async (t) => {
  const s = sim();
  const repo = path.join(s.home, "dev", "source", "app");
  fs.mkdirSync(repo, { recursive: true });
  spawnSync("/usr/bin/git", ["init", "-q", repo], { env: { ...s.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  fs.writeFileSync(path.join(repo, ".gitignore"), ".build/\n");
  fs.writeFileSync(path.join(repo, ".clean-development.json"), JSON.stringify({ schemaVersion: 2, enabled: true, buildDirs: [".build", "keep"] }));
  mk(path.join(repo, ".build", "o")); mk(path.join(repo, "keep", "o"));
  for (const p of [".build/o", ".build", "keep/o", "keep", ".gitignore", ".clean-development.json", ".git", ".git/HEAD"]) old(path.join(repo, p), 30);
  if (fs.existsSync(path.join(repo, ".git", "index"))) old(path.join(repo, ".git", "index"), 30);
  old(repo, 30);
  const r = cli(s, ["housekeeping", "--apply", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const result = JSON.parse(r.stdout).result;
  if (result.repoBlocked?.some((row) => row.project === repo && row.path === path.join(repo, ".build") && row.reason === "ETIMEDOUT")) {
    assert.equal(result.deferred, true, r.stdout);
    assert.ok(fs.existsSync(path.join(repo, ".build")), "a timed-out verification must retain output");
    assert.equal(fs.existsSync(path.join(s.home, "dev", "machine", "state", "clean-development", "stamps", "repos")), false);
    t.diagnostic("bounded Git verification deferred cleanup; no retry or relaxed timeout");
  } else assert.ok(await gone(path.join(repo, ".build")), r.stdout);
  assert.ok(fs.existsSync(path.join(repo, "keep", "o")), "not git-ignored, must stay");
});

test("removeManaged refuses paths outside managed roots", () => {
  const s = sim();
  const outside = path.join(s.home, "precious"); mk(path.join(outside, "f"));
  const r = removeManaged(outside, { allowedRoots: [path.join(s.ext, "deps")], trashDir: path.join(s.ext, "trash") });
  assert.equal(r.removed, false); assert.ok(fs.existsSync(path.join(outside, "f")));
});

test("Codex trust hashes reproduce the values Codex 0.163 stored on 19 Oct 2026", () => {
  const notify = "/Users/bolyki/dev/bin/claude-notify";
  const backup = "(/bin/bash /Users/bolyki/dev/bin/backup-claude-chats >/dev/null 2>&1 &)";
  const cd = "'/Users/bolyki/dev/toolchains/node/v26.10.0/bin/node' '/Users/bolyki/Library/Application Support/clean-development/runtime/0.4.0/bin/clean-development.js' hook session-start --owner '745b222f-faee-486d-8138-2437da975a96'";
  const m = "startup|resume|clear|compact|fork";
  const doc = { hooks: {
    PermissionRequest: [{ hooks: [{ type: "command", command: notify }] }],
    SessionStart: [{ matcher: m, hooks: [{ type: "command", command: backup }] }, { matcher: m, hooks: [{ type: "command", command: cd }] }],
    Stop: [{ hooks: [{ type: "command", command: backup }] }, { hooks: [{ type: "command", command: notify }] }]
  } };
  const got = Object.fromEntries(trustEntries("/Users/bolyki/.codex/hooks.json", doc).map((e) => [e.key.split(":").slice(1).join(":"), e.hash]));
  assert.equal(got["permission_request:0:0"], "sha256:8b5e943c385228caea6ee4af322a8ed2e4bb3c4157083253c419dafbf39b7537");
  assert.equal(got["session_start:0:0"], "sha256:7e79c130abbdf82cd5af606929966d3a554abdf1be6d43e8f182997246738f37");
  assert.equal(got["session_start:1:0"], "sha256:70e81496660e44ba86fb2b0bcdc09595a5328ab21a39b9b314fc01c60d7bef67");
  assert.equal(got["stop:0:0"], "sha256:9ac5b1e37cd1ef62b1bd5e17fe9c15a74526b6f50c07977b2701fc9ff0665d93");
  assert.equal(got["stop:1:0"], "sha256:259bc6b7e4f4d0adc6c9f6e85024979936fc7b59a565754a087affa9ed6fbf33");
  assert.equal(normaliseHandler("SessionEnd", { type: "command", command: "x", timeout: 20 }).timeout, 3);
  assert.match(hookHash("Stop", undefined, normaliseHandler("Stop", { type: "command", command: "x", async: true })), /^sha256:[0-9a-f]{64}$/);
});

test("migrate converts schema v1 to v2 with detected build dirs", () => {
  const s = sim();
  const repo = path.join(s.home, "dev", "source", "swiftpkg");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "Package.swift"), "// swift-tools-version:6.0\n");
  fs.writeFileSync(path.join(repo, ".clean-development.json"), JSON.stringify({ schemaVersion: 1, enabled: true, tools: { swift: true } }));
  const r = cli(s, ["migrate", "--write", repo]);
  assert.equal(r.status, 0, r.stderr);
  const v2 = JSON.parse(fs.readFileSync(path.join(repo, ".clean-development.json"), "utf8"));
  assert.equal(v2.schemaVersion, 2); assert.deepEqual(v2.buildDirs, [".build"]);
});

test("invalid storage.conf falls back to internal and says so", () => {
  const s = sim();
  fs.appendFileSync(path.join(s.home, "dev", "machine", "storage.conf"), "EXTERNAL_ROOT=relative\n");
  const r = hook(s, "session-start", "claude", { session_id: "66666666-6666-4666-8666-666666666666" });
  const text = ctx(r);
  assert.match(text, /mode=internal/); assert.match(text, /storage\.conf problems/);
});

test("hook never fails the session on bad input", () => {
  const s = sim();
  const r = spawnSync(process.execPath, [path.join(rt, "bin", "cd-hook.mjs"), "session-start", "claude"], { input: "not json", env: s.env, encoding: "utf8" });
  assert.equal(r.status, 0); assert.ok(ctx(r).includes(`clean-development ${VERSION}`));
  const bad = spawnSync(process.execPath, [path.join(rt, "bin", "cd-hook.mjs"), "bogus", "claude"], { input: "{}", env: s.env, encoding: "utf8" });
  assert.equal(bad.status, 0);
});

test("codex-trust --apply rewrites only this hooks.json's trust tables and keeps valid TOML", async () => {
  const { applyTrust } = await import(path.join(rt, "lib", "codex-trust.mjs"));
  const before = '[hooks.state]\n\n[hooks.state."/h/.codex/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:old"\n\n[hooks.state."plug@m:hooks/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:keep"\n\n[analytics]\nenabled = false\n';
  const after = applyTrust(before, "/h/.codex/hooks.json", [{ key: "/h/.codex/hooks.json:stop:0:0", hash: "sha256:new" }]);
  assert.ok(!after.includes("sha256:old")); assert.ok(after.includes("sha256:keep")); assert.ok(after.includes("sha256:new"));
  assert.ok(after.includes("[analytics]\nenabled = false"));
  const py = spawnSync("python3", ["-I", "-c", "import tomllib,sys;tomllib.loads(sys.stdin.read())"], { input: after, encoding: "utf8" });
  assert.equal(py.status, 0, py.stderr);
});

test("plugin ships no hooks/ directory (both harnesses would auto-load hooks/hooks.json)", () => {
  assert.equal(fs.existsSync(path.join(plugin, "hooks")), false);
  const claude = JSON.parse(fs.readFileSync(path.join(plugin, ".claude-plugin", "plugin.json"), "utf8"));
  const portable = JSON.parse(fs.readFileSync(path.join(plugin, "plugin.json"), "utf8"));
  assert.equal(claude.hooks, undefined); assert.equal(portable.extensions["com.openai"].hooks, undefined);
  assert.equal(claude.version, VERSION); assert.equal(portable.version, VERSION);
  assert.equal(fs.readFileSync(path.join(rt, "VERSION"), "utf8").trim(), VERSION);
});

test("hooks append one JSON line per event to events.jsonl (ts, harness, event, session_id, mode)", () => {
  const s = sim();
  const id = "019a2b3c-4d5e-7f60-8a9b-c0d1e2f3a4b5";
  hook(s, "session-start", "codex", { session_id: id, cwd: s.home });
  hook(s, "stop", "codex", { session_id: id });
  hook(s, "session-end", "codex", { session_id: id });
  const file = path.join(s.home, "dev", "machine", "state", "clean-development", "events.jsonl");
  const rows = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => r.event), ["session-start", "stop", "session-end"]);
  for (const r of rows) { assert.equal(r.harness, "codex"); assert.equal(r.session_id, id); assert.equal(r.mode, "external"); assert.match(r.ts, /^\d{4}-\d\d-\d\dT/); }
});

test("internal DerivedData survives the last-out wipe and the 24 h idle prune; it ages out after 14 days", async () => {
  const s = sim({ mounted: false });
  const dd = path.join(s.int, "builds", "DerivedData");
  mk(path.join(dd, "App-new", "x")); old(path.join(dd, "App-new", "x"), 3); old(path.join(dd, "App-new"), 3);
  mk(path.join(dd, "App-old", "x")); old(path.join(dd, "App-old", "x"), 20); old(path.join(dd, "App-old"), 20);
  mk(path.join(s.int, "builds", "loose", "obj")); old(path.join(s.int, "builds", "loose", "obj"), 3); old(path.join(s.int, "builds", "loose"), 3);
  const r = cli(s, ["housekeeping", "--apply"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(await gone(path.join(s.int, "builds", "loose")), "session-style build dir is wiped");
  assert.ok(await gone(path.join(dd, "App-old")), "older than 14 days is pruned");
  assert.ok(fs.existsSync(path.join(dd, "App-new", "x")), "recent DerivedData stays");
});

test("doctor and status report unmanaged top-level entries of a cache root", () => {
  const s = sim();
  mk(path.join(s.ext, "porn-gpr-dng", "a.dng"), 2048);
  mk(path.join(s.ext, "npm", "blob"), 10);
  fs.mkdirSync(path.join(s.ext, "deps"), { recursive: true });
  const d = cli(s, ["doctor", "--no-gui", "--json"]);
  const row = JSON.parse(d.stdout).results.find((x) => x.name === "cache root extras");
  assert.match(row.detail, /external:porn-gpr-dng/); assert.match(row.detail, /external:npm/); assert.doesNotMatch(row.detail, /deps/);
  const st = JSON.parse(cli(s, ["status", "--json"]).stdout);
  assert.deepEqual(st.rootExtras.map((x) => x.name).sort(), ["npm", "porn-gpr-dng"]);
});

test("run shim ignores --session and executes the command after --", () => {
  const s = sim();
  const r = cli(s, ["run", "--session", "session-only", "--", "/bin/sh", "-c", "printf '%s' \"$1\"; exit 3", "x", "hello"]);
  assert.equal(r.stdout, "hello"); assert.equal(r.status, 3);
  assert.equal(cli(s, ["run", "--session", "x"]).status, 2);
});
