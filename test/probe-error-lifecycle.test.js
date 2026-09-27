import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { PassThrough } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { captureProbeCommand } from "../src/probe-process.js";
import { probeTool } from "../src/probe.js";

// Simulate Node's documented error/exit/close sequences without signalling any
// real PID. Each test runs with restored builtin exports and listener counts.
function fixture(t, { spawned = true, denyTermination = false, errorDuringTermination = false,
  windows = false, closeDuringTaskkill = false } = {}) {
  const child = Object.assign(new EventEmitter(), { pid: spawned ? 2147483000 : undefined,
    exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough() });
  const before = Object.fromEntries(["SIGINT", "SIGTERM"].map((s) => [s, process.listenerCount(s)]));
  let kills = 0, taskkills = 0, captured, commandCwd;
  const finishChild = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.signalCode = "SIGKILL";
    child.emit("exit", null, "SIGKILL"); child.emit("close", null, "SIGKILL");
  };
  const killing = () => {
    kills += 1;
    if (errorDuringTermination) child.emit("error", Object.assign(new Error("kill denied"), { code: "EPERM" }));
    if (denyTermination) throw Object.assign(new Error("denied"), { code: "EPERM" });
    queueMicrotask(finishChild);
  };
  child.kill = () => { killing(); return true; };
  t.mock.method(process, "kill", (pid, signal) => {
    assert.equal(pid, -child.pid); assert.equal(signal, "SIGKILL"); killing(); return true;
  });
  const spawnProcess = (command, _args, options) => {
    if (command.endsWith("taskkill.exe")) {
      taskkills += 1;
      const killer = Object.assign(new EventEmitter(), { kill() {} });
      if (closeDuringTaskkill) finishChild();
      queueMicrotask(() => {
        killer.emit("close", denyTermination ? 1 : 0);
      });
      return killer;
    }
    commandCwd = options.cwd;
    return child;
  };
  t.mock.method(childProcess, "spawn", spawnProcess);
  syncBuiltinESMExports();
  // Use a host-valid absolute path because this unit test simulates Windows
  // control flow on the current platform.
  const env = { SystemRoot: "/Windows" };
  const capture = (options = {}) => captured = captureProbeCommand(process.execPath, [], {
    cwd: path.dirname(process.execPath), env, timeoutMs: 5000, platform: windows ? "win32" : process.platform,
    spawnProcess, ...options
  });
  t.after(async () => {
    finishChild();
    if (captured) await captured;
    t.mock.restoreAll(); syncBuiltinESMExports();
    for (const [s, count] of Object.entries(before)) assert.equal(process.listenerCount(s), count, s);
  });
  return { child, capture, finishChild, before, killCount: () => kills, taskkillCount: () => taskkills, commandCwd: () => commandCwd,
    track: (promise) => captured = promise };
}

test("a failed spawn with no PID is classified separately and needs no termination", async (t) => {
  const item = fixture(t, { spawned: false });
  const result = item.capture();
  item.child.emit("error", Object.assign(new Error("not found"), { code: "ENOENT" }));
  const value = await result;
  assert.equal(value.failure, "spawn-failed"); assert.equal(value.cleanupComplete, true);
  assert.equal(item.killCount(), 0);
});

test("post-launch errors do not report cleanup complete while termination is uncertain", async (t) => {
  const item = fixture(t, { denyTermination: true });
  const result = item.capture(); let settled = false; result.then(() => { settled = true; });
  item.child.emit("error", Object.assign(new Error("process error"), { code: "EPERM" }));
  await nextTurn();
  assert.equal(settled, false, "must wait for termination evidence");
  assert.equal(process.listenerCount("SIGTERM"), item.before.SIGTERM + 1);
  item.finishChild();
  const value = await result;
  assert.equal(value.failure, "process-failed"); assert.equal(value.cleanupComplete, false);
  assert.equal(item.killCount(), 1);
});

test("a post-launch error terminates the child before returning a process failure", async (t) => {
  const item = fixture(t), result = item.capture();
  item.child.emit("error", new Error("post-launch"));
  const value = await result;
  assert.equal(value.failure, "process-failed"); assert.equal(value.cleanupComplete, true);
  assert.equal(item.child.signalCode, "SIGKILL"); assert.equal(item.killCount(), 1);
});

test("a confirmed close before deferred error cleanup does not signal a reusable PID", async (t) => {
  const item = fixture(t), result = item.capture();
  item.child.emit("error", new Error("post-launch"));
  item.finishChild();
  const value = await result;
  assert.equal(value.failure, "process-failed");
  assert.equal(value.cleanupComplete, false, "exited child does not prove its process group is empty");
  assert.equal(item.killCount(), 0);
});

test("Windows close during taskkill does not issue a late child signal", async (t) => {
  const item = fixture(t, { windows: true, closeDuringTaskkill: true });
  const result = item.capture();
  item.child.emit("error", new Error("post-launch"));
  const value = await result;
  assert.equal(value.failure, "process-failed");
  assert.equal(value.cleanupComplete, false);
  assert.equal(item.taskkillCount(), 1);
  assert.equal(item.killCount(), 0);
});

test("an error emitted during timeout termination cannot overwrite its reason or settle early", async (t) => {
  const item = fixture(t, { denyTermination: true, errorDuringTermination: true });
  const result = item.capture({ timeoutMs: 5 }); let settled = false; result.then(() => { settled = true; });
  const deadline = Date.now() + 500;
  while (!item.killCount() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(item.killCount(), 1);
  assert.equal(settled, false);
  item.finishChild();
  const value = await result;
  assert.equal(value.failure, "timeout"); assert.equal(value.cleanupComplete, false);
});

test("output-limit cleanup retains the initiating failure when kill emits an error", async (t) => {
  const item = fixture(t, { denyTermination: true, errorDuringTermination: true });
  const result = item.capture({ maxOutputBytes: 8 }); let settled = false; result.then(() => { settled = true; });
  item.child.stdout.write(Buffer.alloc(9)); await nextTurn();
  assert.equal(settled, false);
  item.finishChild();
  const value = await result;
  assert.equal(value.failure, "output-limit"); assert.equal(value.cleanupComplete, false);
});

test("repeated process errors share a single termination attempt", async (t) => {
  const item = fixture(t, { denyTermination: true }), result = item.capture();
  item.child.emit("error", new Error("first"));
  item.child.emit("error", new Error("second"));
  await nextTurn();
  assert.equal(item.killCount(), 1);
  item.finishChild();
  const value = await result;
  assert.equal(value.failure, "process-failed"); assert.equal(value.cleanupComplete, false);
});

test("successful captures keep their original status and close output pipes", async (t) => {
  const item = fixture(t), result = item.capture();
  item.child.stdout.write("result"); item.child.stderr.write("diagnostic");
  item.child.exitCode = 0; item.child.emit("exit", 0, null); item.child.emit("close", 0, null);
  const value = await result;
  assert.equal(value.ok, true); assert.equal(value.failure, null);
  assert.equal(value.stdout, "result"); assert.equal(value.stderr, "diagnostic");
  assert.equal(item.child.stdout.destroyed, true); assert.equal(item.child.stderr.destroyed, true);
  assert.equal(item.killCount(), 0);
});

test("public probe retains disposable storage when a post-launch error leaves cleanup uncertain", async (t) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cd-probe-error-test-")));
  const cwd = path.join(root, "source"), bin = path.join(root, "bin");
  fs.mkdirSync(cwd); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(cwd, "package.json"), "{}");
  fs.writeFileSync(path.join(bin, process.platform === "win32" ? "npm.cmd" : "npm"),
    process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const item = fixture(t, { denyTermination: true });
  // This tool is never executed: all spawns and signals are the mocked objects.
  const env = { PATH: bin, SystemRoot: process.platform === "win32" ? "C:\\Windows" : "/Windows",
    CLEAN_DEVELOPMENT_HOME: path.join(root, "home"), CLEAN_DEVELOPMENT_DATA_HOME: path.join(root, "data"),
    CLEAN_DEVELOPMENT_CONFIG_HOME: path.join(root, "config"), CLEAN_DEVELOPMENT_ROOT: path.join(root, "managed") };
  t.after(() => {
    const allocated = item.commandCwd() && path.dirname(item.commandCwd());
    if (allocated && path.basename(allocated).startsWith("clean-development-probe-")) fs.rmSync(allocated, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const result = item.track(probeTool("npm", { cwd, env, execute: true }));
  item.child.emit("error", new Error("post-launch"));
  await nextTurn(); item.finishChild();
  const value = await result;
  assert.equal(value.status, "failed"); assert.equal(value.reason, "process-failed");
  assert.equal(value.cleanup, "retained-process-uncertain");
  assert.equal(fs.existsSync(value.retainedFixture), true);
  assert.equal(fs.existsSync(path.join(root, "managed")), false);
  assert.equal(fs.existsSync(path.join(root, "data")), false);
});
