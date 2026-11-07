import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { plugin, sim } from "./helpers.mjs";
import { ROUTING_NAMES, childEnv, formatEnv } from "../runtime/lib/childenv.mjs";

test("ROUTING_NAMES covers every env.zsh route and exported storage name", () => {
  const source = fs.readFileSync(path.join(plugin, "machine/env.zsh"), "utf8").split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
  const routed = [...source.matchAll(/(?:^|;|\bthen|\belse)[ \t]*__cd_route[ \t]+([A-Za-z_][A-Za-z0-9_]*)\b/gm)].map((m) => m[1]);
  const exported = [...source.matchAll(/\bexport\s+([^;\n]+)/g)].flatMap((m) => m[1].split(/\s+/).map((t) => t.split("=")[0]))
    .filter((name) => /^(?:CLEAN_DEV_|CLEAN_DEVELOPMENT_|DEVCACHE$|TMPDIR$)/.test(name));
  assert.ok(routed.length > 50);
  for (const name of [...routed, ...exported]) assert.ok(ROUTING_NAMES.includes(name), `missing storage routing name: ${name}`);
  assert.equal(ROUTING_NAMES.length, new Set(ROUTING_NAMES).size);
});

test("child environments retain routing and session identity and refuse harness and secret names even in keep", () => {
  const s = sim(), key = "x-aaaaaaaaaaaa";
  const secrets = ["CLAUDE_CODE_SESSION_ID", "CLAUDECODE", "CLAUDE_CODE_PLUGIN_DIRS", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GH_TOKEN", "GITHUB_TOKEN", "CODEX_THREAD_ID", "MCP_SERVER", "SERVICE_TOKEN", "SERVICE_API_KEY", "SERVICE_SECRET_FILE", "PASSWORD", "SERVICE_PASSWORD_HASH", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"];
  const env = { ...s.env, CLEAN_DEV_BUILDS: path.join(s.ext, "builds", key), TMPDIR: path.join(s.ext, "scratch", key, "tmp"), DEVCACHE: s.ext,
    CLEAN_DEV_SESSION: key, CLEAN_DEV_STAMP: `external|${s.ext}|${key}`, DEV: path.join(s.home, "dev"), DEVMACHINE: path.join(s.home, "dev/machine"),
    USER: "fixture", LOGNAME: "fixture", SHELL: "/bin/zsh", LANG: "C.UTF-8", LC_ALL: "C", TERM: "xterm", TZ: "Europe/London", SSH_AUTH_SOCK: "/fixture/agent",
    EXTRA: "explicit", UNRELATED: "not requested", ...Object.fromEntries(secrets.map((name) => [name, "must not escape"])) };
  const before = { ...env }, clean = childEnv(env, { keep: [...secrets, "EXTRA"] });
  assert.deepEqual(env, before); assert.notEqual(clean, env);
  for (const name of ["CLEAN_DEV_BUILDS", "TMPDIR", "DEVCACHE", "CLEAN_DEV_SESSION", "CLEAN_DEV_STAMP", "DEV", "DEVMACHINE", "EXTRA", "HOME", "USER", "LOGNAME", "SHELL", "PATH", "LANG", "LC_ALL", "TERM", "TZ"]) assert.equal(clean[name], env[name]);
  // 0.6.2 review: agent access, op sessions and *_KEY/*_PAT never pass by default; SSH_AUTH_SOCK only via keep.
  assert.equal(Object.hasOwn(clean, "SSH_AUTH_SOCK"), false);
  assert.equal(childEnv(env, { keep: ["SSH_AUTH_SOCK"] }).SSH_AUTH_SOCK, env.SSH_AUTH_SOCK);
  const more = childEnv({ ...env, OP_SESSION_my: "x", DEPLOY_KEY: "x", GITHUB_PAT: "x", CLAUDE_CONFIG_DIR: "/seat" }, { keep: ["OP_SESSION_my", "DEPLOY_KEY", "GITHUB_PAT"] });
  for (const name of ["OP_SESSION_my", "DEPLOY_KEY", "GITHUB_PAT", "CLAUDE_CONFIG_DIR"]) assert.equal(Object.hasOwn(more, name), false, name);
  assert.equal(childEnv({ ...env, CLAUDE_CONFIG_DIR: "/seat" }, { keep: ["CLAUDE_CONFIG_DIR"] }).CLAUDE_CONFIG_DIR, "/seat");
  for (const name of secrets) { assert.equal(Object.hasOwn(clean, name), false, name); assert.ok(clean.refused.includes(name)); }
  assert.equal(Object.hasOwn(clean, "UNRELATED"), false);
  assert.equal(Object.keys(clean).includes("refused"), false);
  assert.equal(JSON.stringify(clean).includes("must not escape"), false);
  // This stamp is the pure-function contract for a child shell retaining its parent's placement.
  assert.ok(clean.CLEAN_DEV_STAMP.endsWith(`|${clean.CLEAN_DEV_SESSION}`));
});

test("all storage routes are retained except harness names; CODEX_HOME needs explicit keep", () => {
  const s = sim(), env = { ...s.env, ...Object.fromEntries(ROUTING_NAMES.map((name) => [name, `/fixture/${name}`])),
    CLAUDE_CODE_PLUGIN_DIRS: "/fixture/private-claude-plugin", CODEX_HOME: path.join(s.home, "codex-test") };
  const clean = childEnv(env);
  for (const name of ROUTING_NAMES) if (!name.startsWith("CLAUDE_")) assert.equal(clean[name], env[name]);
  assert.equal(Object.hasOwn(clean, "CLAUDE_CODE_PLUGIN_DIRS"), false);
  assert.ok(clean.refused.includes("CLAUDE_CODE_PLUGIN_DIRS"));
  assert.equal(Object.hasOwn(clean, "CODEX_HOME"), false);
  const kept = childEnv(env, { keep: ["CODEX_HOME"] });
  assert.equal(kept.CODEX_HOME, env.CODEX_HOME);
  assert.equal(kept.refused.includes("CODEX_HOME"), false);
});

test("optional child environment allowlist retains configured paths without bypassing filters", () => {
  const s = sim(), file = path.join(s.home, "dev", "machine", "state", "clean-development", "childenv-allow.list");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "LOCAL_TOOL_PATH\nSSH_AUTH_SOCK\nSERVICE_TOKEN\nBAD-NAME\n");
  const env = { ...s.env, LOCAL_TOOL_PATH: "/fixture/tool", SSH_AUTH_SOCK: "/fixture/agent", SERVICE_TOKEN: "secret", "BAD-NAME": "invalid" };
  const clean = childEnv(env);
  assert.equal(clean.LOCAL_TOOL_PATH, env.LOCAL_TOOL_PATH);
  for (const name of ["SSH_AUTH_SOCK", "SERVICE_TOKEN", "BAD-NAME"]) assert.equal(Object.hasOwn(clean, name), false, name);
  assert.ok(clean.refused.includes("SERVICE_TOKEN"));
  assert.ok(clean.refused.includes("BAD-NAME"));
  assert.equal(childEnv(env, { keep: ["SSH_AUTH_SOCK"] }).SSH_AUTH_SOCK, env.SSH_AUTH_SOCK);
});

test("sh output safely round-trips quotes, spaces, newlines and shell syntax", () => {
  const s = sim(), obj = { SIMPLE: "hello", SPACES: "two words", QUOTES: "a'b'\"c", LINES: "first\nsecond\n", SHELL_TEXT: "$(false) `false` $HOME; *", EMPTY: "" };
  const encoded = formatEnv(obj, "sh");
  const script = 'eval "$1"; shift; for name do eval \'printf "%s\\000" "${\'"$name"\'}"\'; done';
  const result = spawnSync("/bin/sh", ["-c", script, "childenv-test", encoded, ...Object.keys(obj)], { env: s.env, cwd: s.root, encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, Object.values(obj).map((value) => value + "\0").join(""));
  assert.match(encoded, /^export SIMPLE='hello'\n/);
});

test("json and null formats contain only environment entries; invalid names and NUL values are refused", () => {
  const s = sim(), clean = childEnv({ ...s.env, SAFE: "a=b\n'", GH_TOKEN: "hidden" }, { keep: ["SAFE", "GH_TOKEN", "BAD-NAME"] });
  assert.ok(clean.refused.includes("GH_TOKEN")); assert.ok(clean.refused.includes("BAD-NAME"));
  assert.deepEqual(JSON.parse(formatEnv(clean, "json")), { HOME: s.home, PATH: s.env.PATH, SAFE: "a=b\n'" });
  assert.equal(formatEnv({ SAFE: "a=b\n'", EMPTY: "" }, "null"), "SAFE=a=b\n'\0EMPTY=\0");
  const bad = childEnv({ BAD: "a\0b" }, { keep: ["BAD"] });
  assert.deepEqual(Object.keys(bad), []); assert.deepEqual(bad.refused, ["BAD"]);
  for (const obj of [{ "BAD-NAME": "x" }, { BAD: "a\0b" }]) assert.throws(() => formatEnv(obj, "sh"), /invalid environment/);
  assert.throws(() => formatEnv({}, "unknown"), /format/);
});
