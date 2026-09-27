import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { captureProbeCommand } from "../src/probe-process.js";

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "clean-development-probe-process-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("probe capture collects stdout/stderr and does not invoke a shell", async (t) => {
  const cwd = fixture(t), args = ["one two", "a&b", "literal$(echo no)"];
  const result = await captureProbeCommand(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1))); process.stderr.write('err');", ...args], { cwd, env: process.env });
  assert.equal(result.ok, true); assert.equal(result.cleanupComplete, true);
  assert.deepEqual(JSON.parse(result.stdout), args); assert.equal(result.stderr, "err");
});

test("capture validation refuses unbounded limits and non-string arguments", () => {
  for (const value of [0, -1, Infinity, NaN, "100", 30001]) assert.throws(() => captureProbeCommand(process.execPath, [], { timeoutMs: value }), /limits/);
  assert.throws(() => captureProbeCommand("node", []), /command/);
  assert.throws(() => captureProbeCommand(process.execPath, ["a\0b"]), /command/);
});

test("capture reports non-zero exit and missing executable without throwing raw errors", async (t) => {
  const cwd = fixture(t);
  const failed = await captureProbeCommand(process.execPath, ["-e", "process.exit(7)"], { cwd, env: process.env });
  assert.equal(failed.ok, false); assert.equal(failed.failure, "command-failed"); assert.equal(failed.exitCode, 7);
  const missing = await captureProbeCommand(path.join(cwd, "missing"), [], { cwd, env: process.env });
  assert.equal(missing.failure, "spawn-failed");
});

test("capture enforces a combined output budget and unregisters interrupt handlers", async (t) => {
  const cwd = fixture(t);
  const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  const result = await captureProbeCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(200000));setInterval(()=>{},1000)"], { cwd, env: process.env, maxOutputBytes: 1024 });
  assert.equal(result.failure, "output-limit"); assert.equal(result.cleanupComplete, true);
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 1024);
  assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], before);
});

test("capture timeout stops an ordinary process and leaves no registered signal handlers", async (t) => {
  const cwd = fixture(t);
  const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  const result = await captureProbeCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd, env: process.env, timeoutMs: 200 });
  assert.equal(result.failure, "timeout"); assert.equal(result.cleanupComplete, true);
  assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], before);
});

test("POSIX timeout cleans an ordinary descendant holding inherited output pipes", { skip: process.platform === "win32" }, async (t) => {
  const cwd = fixture(t), heartbeat = path.join(cwd, "heartbeat");
  const script = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(heartbeat)},'start');setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'.'),20)`;
  const wrapper = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(script)}],{stdio:'inherit'});setInterval(()=>{},1000)`;
  const result = await captureProbeCommand(process.execPath, ["-e", wrapper], { cwd, env: process.env, timeoutMs: 1000 });
  assert.equal(result.failure, "timeout"); assert.equal(result.cleanupComplete, true);
  assert.ok(fs.existsSync(heartbeat));
  await new Promise((resolve) => setTimeout(resolve, 80)); const value = fs.readFileSync(heartbeat, "utf8");
  await new Promise((resolve) => setTimeout(resolve, 120)); assert.equal(fs.readFileSync(heartbeat, "utf8"), value);
});

test("capture closes held pipes even if the immediate POSIX child has already exited", { skip: process.platform === "win32" }, async (t) => {
  const cwd = fixture(t);
  const wrapper = "const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});child.unref();";
  const result = await captureProbeCommand(process.execPath, ["-e", wrapper], { cwd, env: process.env, timeoutMs: 500 });
  assert.equal(result.failure, "timeout"); assert.equal(result.cleanupComplete, true);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`capture handles ${signal} and removes its temporary listeners`, async (t) => {
    const cwd = fixture(t), before = process.listenerCount(signal);
    const pending = captureProbeCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd, env: process.env });
    const timer = setTimeout(() => process.emit(signal), 100);
    t.after(() => clearTimeout(timer));
    const result = await pending;
    assert.equal(result.failure, "interrupted"); assert.equal(result.interruptedSignal, signal);
    assert.equal(result.cleanupComplete, true); assert.equal(process.listenerCount(signal), before);
  });
}
