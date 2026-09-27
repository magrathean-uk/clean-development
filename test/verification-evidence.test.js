import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseSmokeOptions, parseToolVersion, verificationSource, smokeOutcome, runVerificationCommand } from "../scripts/verification-utils.mjs";
import { isolatedEnvironment } from "../scripts/harness-utils.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const smoke = path.join(root, "scripts", "smoke-real-tools.mjs");
function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clean-development-evidence-")));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function inventory(directory) {
  for (const name of ["bin", "src", "scripts"]) {
    fs.mkdirSync(path.join(directory, name), { recursive: true });
    fs.writeFileSync(path.join(directory, name, "one.js"), `// ${name}\n`);
  }
  fs.writeFileSync(path.join(directory, "package.json"), '{"version":"1.0.0"}\n');
}

test("smoke options are strict, explicit and canonical", () => {
  assert.deepEqual(parseSmokeOptions([]), { required: [], json: false, help: false });
  assert.deepEqual(parseSmokeOptions(["--require", "uv,npm,cargo", "--json"]), { required: ["cargo", "npm", "uv"], json: true, help: false });
  assert.deepEqual(parseSmokeOptions(["--require=go", "--help"]), { required: ["go"], json: false, help: true });
  for (const args of [["--json=false"], ["--require"], ["--require="], ["--require", "npm,npm"], ["--require", "npm,"], ["--require", "pip"], ["--require", "npm;exit"], ["--json", "--json"], ["--require=go", "--require=npm"], ["--anything"], ["npm"]]) {
    assert.throws(() => parseSmokeOptions(args), /Usage:/);
  }
});

test("version parsing retains numeric identity without copying arbitrary tool output", () => {
  for (const [tool, output, expected] of [
    ["cargo", "cargo 1.98.1 (abcdef 2026-08-05)", "1.98.1"],
    ["go", "go version go1.23.2 linux/amd64", "1.23.2"],
    ["npm", "10.9.2\n", "10.9.2"], ["uv", "uv 0.10.0 (build)", "0.10.0"],
    ["python3", "Python 3.13.5", "3.13.5"], ["cargo", "cargo 1.99.0-nightly (build)", "1.99.0-nightly"]
  ]) assert.equal(parseToolVersion(tool, output), expected);
  for (const [tool, output] of [["unknown", "1.0.0"], ["npm", "/private/home/1.0.0"], ["npm", "1.2.3-secret\u001b[2J"], ["go", "not go"], ["uv", "x".repeat(17000)]]) {
    assert.equal(parseToolVersion(tool, output), null);
  }
});

test("fingerprints are path-independent, scoped and sensitive to source changes", (t) => {
  const a = fixture(t), b = fixture(t);
  inventory(a); inventory(b);
  fs.writeFileSync(path.join(a, ".env"), "SECRET=never include me");
  const first = verificationSource(a), second = verificationSource(b);
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.fileCount, 4);
  assert.equal(first.gitCommit, null); assert.equal(first.gitDirty, null);
  assert.doesNotMatch(JSON.stringify(first), /SECRET|never include|private|clean-development-evidence-/);
  fs.writeFileSync(path.join(b, "src", "one.js"), "changed\n");
  assert.notEqual(first.fingerprint, verificationSource(b).fingerprint);
});

test("source inventories reject symlinks instead of reading their targets", (t) => {
  const directory = fixture(t); inventory(directory);
  const outside = path.join(directory, "secret"); fs.writeFileSync(outside, "do not fingerprint");
  try { fs.symlinkSync(outside, path.join(directory, "src", "linked")); }
  catch (error) { if (error.code === "EPERM" && process.platform === "win32") return t.skip("symlink privilege required"); throw error; }
  assert.throws(() => verificationSource(directory), /symlink/);
});

test("an archive under a parent Git checkout does not inherit its commit identity", (t) => {
  const parent = fixture(t), directory = path.join(parent, "archive");
  fs.mkdirSync(directory); inventory(directory);
  const initialised = spawnSync("git", ["init", parent], { encoding: "utf8", timeout: 3000 });
  if (initialised.status !== 0) return t.skip("Git unavailable");
  assert.equal(verificationSource(directory).gitCommit, null);
  assert.equal(verificationSource(directory).gitDirty, null);
});

test("required coverage cannot be satisfied by another tool or an empty run", () => {
  const passed = { tool: "npm", status: "passed" };
  assert.equal(smokeOutcome([passed], []).ok, true);
  const result = smokeOutcome([passed, { tool: "cargo", status: "skipped" }], ["cargo"]);
  assert.equal(result.ok, false); assert.deepEqual(result.missingRequired, ["cargo"]);
  assert.equal(smokeOutcome([], []).ok, false);
  assert.equal(smokeOutcome([passed, { tool: "uv", status: "failed" }], ["npm"]).ok, false);
});

test("command limits are validated and child errors do not expose captured output", (t) => {
  const directory = fixture(t);
  for (const value of [0, -1, NaN, Infinity, 1.5]) {
    assert.throws(() => runVerificationCommand(process.execPath, [], { timeoutMs: value }), /positive safe/);
    assert.throws(() => runVerificationCommand(process.execPath, [], { maxOutputBytes: value }), /positive safe/);
  }
  assert.throws(() => runVerificationCommand(process.execPath, ["-e", "console.error('SENSITIVE_CANARY'); process.exit(7)"], { cwd: directory }),
    (error) => error.code === "CHILD_FAILED" && !error.message.includes("SENSITIVE_CANARY"));
  assert.throws(() => runVerificationCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(200000))"], { cwd: directory, maxOutputBytes: 1024 }),
    (error) => error.code === "ENOBUFS");
});

test("command timeout terminates a fixture rather than hanging the report", (t) => {
  const directory = fixture(t);
  assert.throws(() => runVerificationCommand(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], { cwd: directory, timeoutMs: 100 }),
    (error) => error.code === "ETIMEDOUT");
});

test("JSON smoke evidence reports missing required coverage without private paths or secrets", (t) => {
  const directory = fixture(t);
  const before = fs.readdirSync(directory);
  const result = spawnSync(process.execPath, [smoke, "--require", "cargo,npm", "--json"], {
    cwd: directory, env: { ...isolatedEnvironment(directory), PATH: directory, SENSITIVE_CANARY: "never copy this", TMPDIR: directory }, encoding: "utf8", timeout: 10000
  });
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schemaVersion, 1); assert.equal(report.ok, false);
  assert.deepEqual(report.missingRequired, ["cargo", "npm"]);
  assert.equal(report.results.length, 4);
  assert.ok(report.results.every((item) => item.status === "skipped"));
  assert.equal(report.environment.node, process.version);
  assert.equal(report.sourceUnchanged, true);
  assert.match(report.source.fingerprint, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(result.stdout, /SENSITIVE_CANARY|never copy this|clean-development-evidence-/);
  assert.deepEqual(fs.readdirSync(directory), before);
});

test("invalid smoke arguments fail before temporary files or commands are created", (t) => {
  const directory = fixture(t);
  const result = spawnSync(process.execPath, [smoke, "--require", "npm,typo"], {
    env: { ...isolatedEnvironment(directory), TMPDIR: directory }, encoding: "utf8", timeout: 10000
  });
  assert.equal(result.status, 2); assert.match(result.stderr, /Usage:/);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test("a failed real-tool fixture is explicit JSON failure, not a skip", { skip: process.platform === "win32" }, (t) => {
  const directory = fixture(t);
  const executable = path.join(directory, "cargo");
  fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const result = spawnSync(process.execPath, [smoke, "--json", "--require=cargo"], {
    env: { ...isolatedEnvironment(directory), PATH: directory }, encoding: "utf8", timeout: 10000
  });
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  const cargo = report.results.find((item) => item.tool === "cargo");
  assert.equal(cargo.status, "failed"); assert.equal(cargo.reason, "fixture-failed");
  assert.deepEqual(report.missingRequired, ["cargo"]); assert.equal(report.ok, false);
  assert.equal(result.stderr, "");
});

test("POSIX fixture timeouts stop an ordinary descendant as well as its wrapper", { skip: process.platform === "win32" }, async (t) => {
  const directory = fixture(t);
  const heartbeat = path.join(directory, "heartbeat");
  const childScript = `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(heartbeat)}, 'start'); setInterval(() => fs.appendFileSync(${JSON.stringify(heartbeat)}, '.'), 20);`;
  const wrapper = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], {stdio: 'ignore'}); setInterval(() => {}, 1000);`;
  assert.throws(() => runVerificationCommand(process.execPath, ["-e", wrapper], { cwd: directory, timeoutMs: 1500 }),
    (error) => error.code === "ETIMEDOUT");
  assert.ok(fs.existsSync(heartbeat), "descendant actually started before timeout");
  // Allow an in-flight write to finish; the child must not keep writing afterward.
  await new Promise((resolve) => setTimeout(resolve, 80));
  const stopped = fs.readFileSync(heartbeat, "utf8");
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(fs.readFileSync(heartbeat, "utf8"), stopped);
});
