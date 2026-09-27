import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { planProbe, probeTool, formatProbe } from "../src/probe.js";
import { isolatedEnvironment } from "../scripts/harness-utils.mjs";

const cli = fileURLToPath(new URL("../bin/clean-development.js", import.meta.url));
function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "clean-development-probe-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "project"), bin = path.join(root, "bin");
  fs.mkdirSync(cwd); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(cwd, "package.json"), '{"scripts":{"test":"must-not-run"}}\n');
  return { root, cwd, bin, env: isolatedEnvironment(root) };
}
function fake(item, tool = "npm", body = null) {
  const script = path.join(item.bin, `${tool}-fixture.cjs`);
  const versions = { npm: "10.0.0", go: "go version go1.23.2 test", uv: "uv 0.10.0" };
  const code = body || `if (process.env.SENSITIVE_CANARY || process.env.NODE_OPTIONS || process.env.npm_config_registry) process.exit(88);
if (process.argv.includes('--version') || process.argv[2] === 'version') console.log(${JSON.stringify(versions[tool])});
else if (${JSON.stringify(tool)} === 'go') console.log(JSON.stringify({GOCACHE:process.env.GOCACHE,GOMODCACHE:process.env.GOMODCACHE}));
else console.log(process.env[${JSON.stringify(tool === "npm" ? "npm_config_cache" : "UV_CACHE_DIR")}]);`;
  fs.writeFileSync(script, code);
  const command = path.join(item.bin, tool + (process.platform === "win32" ? ".cmd" : ""));
  fs.writeFileSync(command, process.platform === "win32"
    ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\nexit /b %errorlevel%\r\n`
    : `#!${process.execPath}\n${code}\n`, { mode: 0o755 });
  item.env.PATH = `${item.bin}${path.delimiter}${item.env.PATH || ""}`;
  return command;
}
function snapshot(root) {
  const result = {};
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    result[entry.name] = entry.isDirectory() ? snapshot(file) : fs.readFileSync(file).toString("base64");
  }
  return result;
}

test("probe defaults to a read-only plan and never runs a sentinel executable", async (t) => {
  const item = fixture(t); fake(item, "npm", "throw new Error('must not execute')");
  const before = snapshot(item.root);
  t.mock.method(fs, "mkdtempSync", () => assert.fail("planning must not allocate a fixture"));
  const report = await probeTool("npm", item);
  assert.equal(report.status, "not-tested"); assert.equal(report.executed, false);
  assert.deepEqual(report.query, ["config", "get", "cache"]);
  assert.match(report.scope, /disposable storage/); assert.match(formatProbe(report), /read-only/);
  assert.deepEqual(snapshot(item.root), before);
});

test("fixed queries observe every supported adapter in disposable storage, without ambient secrets", async (t) => {
  const item = fixture(t), beforeEnv = { ...item.env };
  for (const tool of ["npm", "go", "uv"]) fake(item, tool);
  item.env.SENSITIVE_CANARY = "private"; item.env.NODE_OPTIONS = "--require malicious"; item.env.npm_config_registry = "https://private.invalid";
  const before = snapshot(item.root);
  for (const tool of ["npm", "go", "uv"]) {
    const report = await probeTool(tool, { ...item, execute: true });
    assert.equal(report.status, "observed-working", JSON.stringify(report));
    assert.equal(report.executed, true); assert.equal(report.cleanup, "removed");
    assert.ok(report.observations.length > 0);
    assert.ok(report.observations.every((row) => row.matches && row.scope === "disposable-fixture"));
    assert.ok(report.observations.every((row) => !fs.existsSync(row.expected)));
    assert.doesNotMatch(JSON.stringify(report), /SENSITIVE_CANARY|malicious|private\.invalid/);
    assert.ok(report.configuredRouting.every((row) => row.value.startsWith(beforeEnv.CLEAN_DEVELOPMENT_ROOT)));
  }
  assert.deepEqual(snapshot(item.root), before);
  assert.equal(item.env.SENSITIVE_CANARY, "private");
});

test("user overrides are reported without probing user-owned paths; force probes only a fixture", async (t) => {
  const item = fixture(t); fake(item);
  const outside = path.join(item.root, "custom-cache");
  const env = { ...item.env, NPM_CONFIG_CACHE: outside };
  const preserved = await probeTool("npm", { ...item, env, execute: true });
  assert.equal(preserved.status, "preserved-override"); assert.equal(preserved.executed, false);
  const forced = await probeTool("npm", { ...item, env: { ...env, CLEAN_DEVELOPMENT_FORCE: "1" }, execute: true });
  assert.equal(forced.status, "observed-working"); assert.equal(fs.existsSync(outside), false);
});

test("skip, disabled and blocked routes do not allocate or execute probes", async (t) => {
  const item = fixture(t); fake(item);
  t.mock.method(fs, "mkdtempSync", () => assert.fail("inactive routing must not allocate"));
  const file = path.join(item.cwd, ".clean-development.json");
  fs.writeFileSync(file, "malformed");
  const skipped = await probeTool("npm", { ...item, execute: true, env: { ...item.env, CLEAN_DEVELOPMENT_SESSION_MODE: "skip" } });
  assert.equal(skipped.status, "skipped"); assert.equal(skipped.executed, false);
  fs.writeFileSync(file, '{"schemaVersion":1,"enabled":false}');
  assert.equal((await probeTool("npm", { ...item, execute: true })).status, "disabled");
  fs.writeFileSync(file, '{"schemaVersion":1}');
  const env = { ...item.env, CLEAN_DEVELOPMENT_ROOT: path.join(item.cwd, "managed") };
  assert.equal((await probeTool("npm", { ...item, env, execute: true })).status, "blocked");
});

test("missing tools and invalid API options do not masquerade as observed success", async (t) => {
  const item = fixture(t);
  assert.equal(planProbe("npm", { ...item, env: { ...item.env, PATH: item.bin } }).status, "unavailable");
  for (const tool of [undefined, "cargo", "sh", "npm;exit", "/bin/sh"]) assert.throws(() => planProbe(tool, item), /requires --tool/);
  for (const timeoutMs of [0, 99, 30001, NaN, "1000", 1.5]) assert.throws(() => planProbe("npm", { ...item, timeoutMs }), /timeout/);
  await assert.rejects(probeTool("npm", { ...item, execute: "true" }), /boolean/);
});

test("path mismatches are not successful probes", async (t) => {
  const item = fixture(t);
  fake(item, "npm", `console.log(process.argv.includes('--version')?'10.0.0':${JSON.stringify(path.join(item.root, "wrong"))})`);
  const report = await probeTool("npm", { ...item, execute: true });
  assert.equal(report.status, "mismatch"); assert.equal(report.observations[0].matches, false);
  assert.equal(report.cleanup, "removed");
});

test("failed or malformed tool output is redacted and fixtures are removed", async (t) => {
  const item = fixture(t);
  for (const body of ["console.error('SECRET_CHILD_OUTPUT');process.exit(7)", "console.log('SECRET_CHILD_OUTPUT')", "process.stdout.write('X'.repeat(200000));setInterval(()=>{},1000)"]) {
    fake(item, "npm", body);
    const report = await probeTool("npm", { ...item, execute: true });
    assert.equal(report.status, "failed"); assert.equal(report.cleanup, "removed", JSON.stringify(report));
    assert.doesNotMatch(JSON.stringify(report), /SECRET_CHILD_OUTPUT|XXXX/);
  }
});

test("probe timeouts are visible failures and cleanup is explicit", async (t) => {
  const item = fixture(t); fake(item, "npm", "setInterval(()=>{},1000)");
  const report = await probeTool("npm", { ...item, execute: true, timeoutMs: 200 });
  assert.equal(report.status, "failed"); assert.equal(report.reason, "timeout");
  assert.equal(report.cleanup, "removed", JSON.stringify(report));
});

test("cleanup refuses a replaced fixture root and retains its location", async (t) => {
  const item = fixture(t); fake(item);
  const mkdtemp = fs.mkdtempSync, lstat = fs.lstatSync; let allocated;
  t.mock.method(fs, "mkdtempSync", (...args) => { allocated = mkdtemp(...args); return allocated; });
  let rootReads = 0;
  t.mock.method(fs, "lstatSync", (file, ...args) => {
    const stat = lstat(file, ...args);
    if (String(file) === allocated && args[0]?.bigint && ++rootReads > 1) stat.ino += 1n;
    return stat;
  });
  const report = await probeTool("npm", { ...item, execute: true });
  assert.equal(report.status, "failed"); assert.equal(report.cleanup, "failed");
  assert.equal(report.retainedFixture, allocated); assert.ok(fs.existsSync(allocated));
  fs.rmSync(allocated, { recursive: true, force: true });
});

test("readable probe output escapes stored path and status controls", (t) => {
  const item = fixture(t); fake(item);
  const report = planProbe("npm", item); report.executable.path = "bad\n\u001b[2J\u202e";
  assert.doesNotMatch(formatProbe(report), /\u001b|\u202e/);
  assert.match(formatProbe(report), /bad\\n\\u001b/);
});

test("CLI plans are pure JSON, execution is explicit and arbitrary commands are rejected", (t) => {
  const item = fixture(t); fake(item); const before = snapshot(item.root);
  const run = (args) => spawnSync(process.execPath, [cli, "probe", ...args], { cwd: item.cwd, env: item.env, encoding: "utf8", timeout: 15000 });
  const planned = run(["--tool", "npm", "--json"]);
  assert.equal(planned.status, 0, planned.stderr); assert.equal(JSON.parse(planned.stdout).executed, false);
  const executed = run(["--tool", "npm", "--execute", "--json"]);
  assert.equal(executed.status, 0, executed.stderr); assert.equal(JSON.parse(executed.stdout).status, "observed-working");
  for (const args of [[], ["--tool", "sh"], ["--tool", "npm", "--", "install"], ["--tool", "npm", "--apply"], ["--tool", "npm", "--timeout-ms", "1.2"], ["--tool", "npm", "--execute=false"]]) assert.notEqual(run(args).status, 0);
  assert.deepEqual(snapshot(item.root), before);
});

for (const tool of ["npm", "go", "uv"]) {
  test(`installed ${tool} honours the adapter's isolated cache query`, async (t) => {
    const item = fixture(t);
    if (planProbe(tool, item).status === "unavailable") return t.skip(`${tool} unavailable`);
    const before = snapshot(item.root);
    const report = await probeTool(tool, { ...item, execute: true });
    assert.equal(report.status, "observed-working", JSON.stringify(report));
    assert.equal(report.cleanup, "removed"); assert.deepEqual(snapshot(item.root), before);
    t.diagnostic(`${tool} ${report.toolVersion}`);
  });
}
