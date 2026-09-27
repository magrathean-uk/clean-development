import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnInherited } from "../src/runtime.js";

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cd process & contract ")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (["NODE_OPTIONS", "NODE_PATH"].includes(key.toUpperCase())) delete env[key];
  return { root, env };
}
function handlers() {
  return { SIGINT: process.rawListeners("SIGINT"), SIGTERM: process.rawListeners("SIGTERM") };
}
function fakeChild() {
  const child = new EventEmitter();
  child.pid = 99999999; child.signals = [];
  child.kill = (signal) => { child.signals.push(signal); return true; };
  return child;
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("repeated ENOENT launches reject without retaining signal handlers", async (t) => {
  const item = fixture(t), before = handlers(); let spawned = 0;
  for (let index = 0; index < 20; index += 1) {
    await assert.rejects(spawnInherited(path.join(item.root, "missing-executable"), [], {
      cwd: item.root, env: item.env, onSpawn: () => { spawned += 1; }
    }), { code: "ENOENT" });
    assert.deepEqual(handlers(), before);
  }
  assert.equal(spawned, 0, "failed spawn must not advertise a running process");
});

test("invalid cwd and synchronous spawn arguments do not leak listeners", async (t) => {
  const item = fixture(t), before = handlers();
  await assert.rejects(spawnInherited(process.execPath, ["-e", ""], { cwd: path.join(item.root, "missing"), env: item.env }), { code: "ENOENT" });
  await assert.rejects(spawnInherited(process.execPath, ["\0"], { env: item.env }), /null bytes/);
  assert.deepEqual(handlers(), before);
});

test("non-executable launch failure retains the original error and no signal handlers", { skip: process.platform === "win32" }, async (t) => {
  const item = fixture(t), before = handlers(); const file = path.join(item.root, "not-executable");
  fs.writeFileSync(file, "not executable", { mode: 0o600 });
  await assert.rejects(spawnInherited(file, [], { env: item.env }), { code: "EACCES" });
  assert.deepEqual(handlers(), before);
});

test("ordinary exits preserve status, callback timing and unrelated handlers", async (t) => {
  const item = fixture(t); const unrelated = () => {};
  process.on("SIGINT", unrelated); process.once("SIGTERM", unrelated);
  t.after(() => { process.removeListener("SIGINT", unrelated); process.removeListener("SIGTERM", unrelated); });
  const before = handlers();
  for (const code of [0, 37]) {
    let child, calls = 0;
    const result = spawnInherited(process.execPath, ["-e", `process.exit(${code})`], {
      cwd: item.root, env: item.env, onSpawn: (value) => { child = value; calls += 1; }
    });
    assert.equal(calls, 1); assert.ok(child.pid > 0);
    assert.equal(await result, code); assert.equal(child.exitCode, code);
    assert.deepEqual(handlers(), before);
  }
});

test("onSpawn failure rejects only after its real child has stopped", async (t) => {
  const item = fixture(t), before = handlers(), failure = new Error("receipt update failed"); let child;
  const result = spawnInherited(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    cwd: item.root, env: item.env, onSpawn: (value) => { child = value; throw failure; }
  });
  await assert.rejects(result, (error) => error === failure);
  assert.ok(child.exitCode !== null || child.signalCode !== null, "the callback error cannot release ownership of a running child");
  assert.deepEqual(handlers(), before);
});

test("callback failure escalates an unresponsive launch but still waits for termination", async (t) => {
  const child = fakeChild(), before = handlers(), failure = new Error("fixture failure");
  t.mock.method(childProcess, "spawn", () => child);
  let settled = false;
  const result = spawnInherited("fixture", [], { onSpawn: () => { throw failure; } });
  const observed = result.then(() => { settled = true; }, (error) => { settled = true; assert.equal(error, failure); });
  assert.deepEqual(child.signals, ["SIGTERM"]);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(settled, false, "a kill request is not evidence the process exited");
  child.emit("exit", null, "SIGKILL"); child.emit("close", null, "SIGKILL");
  await observed; assert.equal(settled, true); assert.deepEqual(handlers(), before);
});

test("throwing null in a launch callback is still a rejected launch", async (t) => {
  const child = fakeChild(), before = handlers(); t.mock.method(childProcess, "spawn", () => child);
  const result = spawnInherited("fixture", [], { onSpawn: () => { throw null; } });
  const observed = result.then(() => assert.fail("expected rejection"), (error) => assert.equal(error, null));
  child.emit("close", 0, null); await observed; assert.deepEqual(handlers(), before);
});

test("failed spawn closes once even when error and close arrive without exit", async (t) => {
  const child = fakeChild(); child.pid = undefined;
  const before = handlers(), failure = Object.assign(new Error("cannot launch"), { code: "ENOENT" });
  t.mock.method(childProcess, "spawn", () => child);
  const result = spawnInherited("fixture", [], { onSpawn: () => assert.fail("no live child") });
  let settled = false;
  const observed = result.then(() => assert.fail("expected failure"), (error) => { settled = true; assert.equal(error, failure); });
  child.emit("error", failure); child.emit("error", new Error("secondary")); await tick();
  assert.equal(settled, false); child.emit("close", -2, null); await observed;
  assert.deepEqual(handlers(), before);
});

test("concurrent children keep independent repeated signal forwarding and cleanup", async (t) => {
  const first = fakeChild(), second = fakeChild(), before = handlers(); let count = 0;
  t.mock.method(childProcess, "spawn", () => count++ === 0 ? first : second);
  const a = spawnInherited("first", []), b = spawnInherited("second", []);
  process.emit("SIGINT"); process.emit("SIGINT");
  assert.deepEqual(first.signals, ["SIGINT", "SIGINT"]);
  assert.deepEqual(second.signals, ["SIGINT", "SIGINT"]);
  first.emit("exit", 0, null); first.emit("close", 0, null); assert.equal(await a, 0);
  process.emit("SIGTERM"); assert.deepEqual(first.signals, ["SIGINT", "SIGINT"]);
  assert.deepEqual(second.signals, ["SIGINT", "SIGINT", "SIGTERM"]);
  second.emit("exit", 37, null); second.emit("close", 37, null); assert.equal(await b, 37);
  assert.deepEqual(handlers(), before);
});

test("signal delivery errors cannot settle a child or drop its signal handlers early", async (t) => {
  const child = fakeChild(), before = handlers(); t.mock.method(childProcess, "spawn", () => child);
  child.kill = () => { throw Object.assign(new Error("signal failed"), { code: "EPERM" }); };
  let settled = false; const result = spawnInherited("fixture", []).then((value) => { settled = true; return value; });
  process.emit("SIGTERM"); await tick(); assert.equal(settled, false);
  assert.equal(process.listenerCount("SIGINT"), before.SIGINT.length + 1);
  child.emit("exit", 0, null); child.emit("close", 0, null); assert.equal(await result, 0);
  assert.deepEqual(handlers(), before);
});

test("real POSIX SIGINT reaches the child unchanged and yields its conventional exit code", { skip: process.platform === "win32" }, async (t) => {
  const item = fixture(t), ready = path.join(item.root, "ready"), runner = path.join(item.root, "runner.mjs");
  const moduleUrl = new URL("../src/runtime.js", import.meta.url).href;
  fs.writeFileSync(runner, `import {spawnInherited} from ${JSON.stringify(moduleUrl)}; const code=await spawnInherited(process.execPath,['-e',${JSON.stringify("require('node:fs').writeFileSync(process.env.READY,'ready');setInterval(()=>{},1000)")}],{env:process.env});process.exitCode=code;`);
  const child = childProcess.spawn(process.execPath, [runner], { env: { ...item.env, READY: ready }, stdio: "ignore" });
  t.after(() => { try { child.kill("SIGKILL"); } catch {} });
  const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal })); });
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(fs.existsSync(ready), "child became ready"); child.kill("SIGINT");
  let timeout;
  try {
    const actual = await Promise.race([exited, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("forwarding timed out")), 5000); })]);
    assert.deepEqual(actual, { code: 130, signal: null });
  } finally { clearTimeout(timeout); }
});
