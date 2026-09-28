import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { captureProbeCommand } from "../src/probe-process.js";
import { probeTool } from "../src/probe.js";

function childFixture(pid = 2147483000) {
  const child = Object.assign(new EventEmitter(), { pid, exitCode: null, signalCode: null,
    stdout: new PassThrough(), stderr: new PassThrough() });
  child.kill = () => assert.fail("must not signal a reaped child");
  const close = (code = 0) => {
    child.exitCode = code;
    child.emit("exit", code, null); child.emit("close", code, null);
  };
  return { child, close };
}
function handlers() {
  return Object.fromEntries(["SIGINT", "SIGTERM"].map((signal) => [signal, process.rawListeners(signal)]));
}
function groupCheck(t, outcome, pid = 2147483000) {
  let checks = 0;
  t.mock.method(process, "kill", (target, signal) => {
    assert.equal(target, -pid); assert.equal(signal, 0, "existence check only, never a destructive signal");
    checks += 1;
    if (outcome !== "present") throw Object.assign(new Error("fixture group lookup"), { code: outcome });
    return true;
  });
  return () => checks;
}

for (const code of [0, 37]) {
  test(`POSIX close ${code} retains cleanup uncertainty for a surviving process group`, async (t) => {
    const item = childFixture(), before = handlers(), checks = groupCheck(t, "present");
    const cwd = path.dirname(process.execPath), env = { PATH: cwd }, args = ["one two", "a;b,c=d+e", ""];
    let invocation;
    const pending = captureProbeCommand(process.execPath, args, { cwd, env, platform: "linux",
      spawnProcess: (...values) => { invocation = values; return item.child; } });
    item.child.stdout.write("result\n"); item.child.stderr.write("diagnostic\n"); item.close(code);
    const value = await pending;
    assert.equal(value.cleanupComplete, false, "close only proves the leader and its pipes stopped");
    assert.equal(value.ok, code === 0); assert.equal(value.failure, code === 0 ? null : "command-failed");
    assert.equal(value.exitCode, code); assert.equal(value.interruptedSignal, null);
    assert.equal(value.stdout, "result\n"); assert.equal(value.stderr, "diagnostic\n");
    assert.deepEqual(invocation, [process.execPath, args, { cwd, env, shell: false,
      stdio: ["ignore", "pipe", "pipe"], detached: true, windowsHide: true, windowsVerbatimArguments: false }]);
    assert.equal(checks(), 1); assert.deepEqual(handlers(), before);
    assert.equal(item.child.stdout.destroyed, true); assert.equal(item.child.stderr.destroyed, true);
  });
}

for (const outcome of ["ESRCH", "EPERM", "EIO"]) {
  test(`POSIX close accepts only ESRCH as absent-group evidence: ${outcome}`, async (t) => {
    const item = childFixture(), before = handlers(), checks = groupCheck(t, outcome);
    const pending = captureProbeCommand(process.execPath, [], { platform: "linux", spawnProcess: () => item.child });
    item.close(); const value = await pending;
    assert.equal(value.cleanupComplete, outcome === "ESRCH");
    assert.equal(value.ok, true); assert.equal(value.exitCode, 0);
    assert.equal(checks(), 1); assert.deepEqual(handlers(), before);
  });
}

test("Windows normal close does not attempt POSIX process-group inspection", async (t) => {
  const item = childFixture(), before = handlers();
  t.mock.method(process, "kill", () => assert.fail("no POSIX group lookup on Windows"));
  const pending = captureProbeCommand(process.execPath, [], { platform: "win32", spawnProcess: () => item.child });
  item.close(); const value = await pending;
  assert.equal(value.ok, true); assert.equal(value.cleanupComplete, true);
  assert.deepEqual(handlers(), before);
});

// No executable or PID below is real: only the homes, project and retained
// probe directory are disposable filesystem fixtures. There are no sleep races.
for (const uncertainCapture of [1, 2]) {
  test(`public probe retains its fixture after uncertain successful capture ${uncertainCapture}`,
    { skip: process.platform === "win32" }, async (t) => {
      const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cd-probe-descendants-")));
      let allocated, launches = 0; const checks = [];
      t.after(() => {
        // All children were simulated; no process can still use these fixtures.
        if (allocated) fs.rmSync(allocated, { recursive: true, force: true });
        fs.rmSync(root, { recursive: true, force: true });
      });
      const cwd = path.join(root, "source"), bin = path.join(root, "bin");
      fs.mkdirSync(cwd); fs.mkdirSync(bin);
      fs.writeFileSync(path.join(cwd, "package.json"), "{}");
      fs.writeFileSync(path.join(bin, "npm"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      const env = { PATH: bin, CLEAN_DEVELOPMENT_HOME: path.join(root, "home"),
        CLEAN_DEVELOPMENT_DATA_HOME: path.join(root, "data"), CLEAN_DEVELOPMENT_CONFIG_HOME: path.join(root, "config"),
        CLEAN_DEVELOPMENT_ROOT: path.join(root, "managed") };
      const before = handlers();
      t.mock.method(childProcess, "spawn", (_command, args, options) => {
        launches += 1;
        allocated = path.dirname(options.cwd);
        const item = childFixture(2147483000 + launches);
        queueMicrotask(() => {
          item.child.stdout.write(args[0] === "--version" ? "10.9.2\n" : `${options.env.npm_config_cache}\n`);
          item.close();
        });
        return item.child;
      });
      t.mock.method(process, "kill", (pid, signal) => {
        checks.push([pid, signal]);
        if (launches === uncertainCapture) return true;
        throw Object.assign(new Error("group is gone"), { code: "ESRCH" });
      });
      const value = await probeTool("npm", { cwd, env, execute: true });
      assert.equal(value.status, "failed"); assert.equal(value.reason, "cleanup-uncertain");
      assert.equal(value.cleanup, "retained-process-uncertain"); assert.equal(value.retainedFixture, allocated);
      assert.ok(fs.statSync(path.join(allocated, "project", "package.json")).isFile());
      assert.equal(launches, uncertainCapture, "uncertain query must not launch a version command");
      assert.deepEqual(checks, Array.from({ length: uncertainCapture }, (_, i) => [-(2147483001 + i), 0]));
      assert.deepEqual(handlers(), before);
      assert.equal(fs.existsSync(env.CLEAN_DEVELOPMENT_ROOT), false);
    });
}
