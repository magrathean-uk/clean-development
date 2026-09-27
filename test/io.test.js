import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fork } from "node:child_process";
import { acquireDirectoryLock, acquireDirectoryLockSync, writeJsonExclusive } from "../src/io.js";

function staleLockFixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clean-development-lock-")));
  const lock = path.join(root, "stale.lock");
  const owner = path.join(lock, "owner.json");
  fs.mkdirSync(lock);
  fs.writeFileSync(owner, `${JSON.stringify({
    schemaVersion: 1,
    token: "stale-token",
    pid: 2_147_483_647,
    acquiredAt: new Date(Date.now() - 10_000).toISOString()
  })}\n`);
  const stale = new Date(Date.now() - 10_000);
  fs.utimesSync(lock, stale, stale);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { lock, owner };
}

function preventOwnerRemoval(owner, callback) {
  const unlinkSync = fs.unlinkSync;
  fs.unlinkSync = (file) => {
    if (path.resolve(file) === path.resolve(owner)) {
      const error = new Error("simulated busy lock owner");
      error.code = "EBUSY";
      throw error;
    }
    return unlinkSync(file);
  };
  try {
    return callback();
  } finally {
    fs.unlinkSync = unlinkSync;
  }
}

test("an unremovable stale async lock still honors its timeout", async (t) => {
  const { lock, owner } = staleLockFixture(t);
  await preventOwnerRemoval(owner, () => assert.rejects(
    acquireDirectoryLock(lock, { timeoutMs: 0 }),
    /Timed out waiting for setup lock/
  ));
});

test("an unremovable stale sync lock still honors its timeout", (t) => {
  const { lock, owner } = staleLockFixture(t);
  preventOwnerRemoval(owner, () => assert.throws(
    () => acquireDirectoryLockSync(lock, { timeoutMs: 0 }),
    /Timed out waiting for runtime lock/
  ));
});

function releaseLockDuringValidation(lock, callback) {
  const owner = path.join(lock, "owner.json");
  const lstatSync = fs.lstatSync;
  let released = false;
  fs.lstatSync = (file, options) => {
    if (!released && path.resolve(file) === path.resolve(lock)) {
      released = true;
      fs.unlinkSync(owner);
      fs.rmdirSync(lock);
      const error = new Error("simulated concurrent lock release");
      error.code = "ENOENT";
      throw error;
    }
    return lstatSync(file, options);
  };
  const restore = () => { fs.lstatSync = lstatSync; };
  try {
    const result = callback();
    if (result && typeof result.finally === "function") return result.finally(restore);
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

function transientLock(root) {
  const lock = path.join(root, "transient.lock");
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "owner.json"), `${JSON.stringify({
    schemaVersion: 1,
    token: "departing-owner",
    pid: process.pid,
    acquiredAt: new Date().toISOString()
  })}\n`);
  return lock;
}

test("an async lock retries when the current owner releases before validation", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clean-development-lock-race-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lock = transientLock(root);
  const release = await releaseLockDuringValidation(lock, () => acquireDirectoryLock(lock, { timeoutMs: 100 }));
  release();
  assert.equal(fs.existsSync(lock), false);
});

test("a sync lock retries when the current owner releases before validation", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clean-development-lock-race-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lock = transientLock(root);
  const release = releaseLockDuringValidation(lock, () => acquireDirectoryLockSync(lock, { timeoutMs: 100 }));
  release();
  assert.equal(fs.existsSync(lock), false);
});

test("exclusive JSON creation never replaces an existing project file", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clean-development-exclusive-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "project.json");
  fs.writeFileSync(file, "user-owned\n");
  assert.throws(() => writeJsonExclusive(file, { owner: "clean-development" }), { code: "EEXIST" });
  assert.equal(fs.readFileSync(file, "utf8"), "user-owned\n");
});


// Safety invariant: a release/recovery must not revoke another generation's
// lock. Missing, changed or unreadable ownership evidence must fail closed.
// These workers use the real io.js, OS PIDs and filesystem. The mkdir wrapper
// only reports a real EEXIST (and optionally waits at that boundary); it never
// fabricates a filesystem result. No sleep is used to order competing owners.
async function lockWorker() {
  const fs = (await import("node:fs")).default;
  const path = (await import("node:path")).default;
  const { acquireDirectoryLock, acquireDirectoryLockSync } = await import(process.argv[2]);
  const { lock, mode, timeoutMs = 5_000, gate = null, probeError = null } = JSON.parse(process.argv[3]);
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  const send = (message) => process.send({ ...message, pid: process.pid });
  const watchdog = setTimeout(() => process.exit(98), 15_000);
  process.on("disconnect", () => process.exit(0));
  const mkdirSync = fs.mkdirSync;
  let reported = false;
  fs.mkdirSync = (file, ...args) => {
    try { return mkdirSync(file, ...args); } catch (error) {
      if (error.code === "EEXIST" && path.resolve(file) === lock && !reported) {
        reported = true;
        send({ type: "contended" });
        const deadline = Date.now() + 10_000;
        while (gate && !fs.existsSync(gate)) {
          if (Date.now() >= deadline) throw new Error("Test barrier timed out");
          Atomics.wait(waiter, 0, 0, 10);
        }
      }
      throw error;
    }
  };
  // Supplemental error-path evidence only; the main regressions below do not
  // replace process.kill or any filesystem operation's outcome.
  if (probeError) {
    const kill = process.kill;
    process.kill = (pid, signal) => {
      if (signal !== 0) return kill(pid, signal);
      throw Object.assign(new Error("Uncertain process lookup"), { code: probeError });
    };
  }
  let release;
  process.on("message", (message) => {
    if (message === "stop") {
      clearTimeout(watchdog);
      process.exit(0);
    }
    if (message === "release") {
      try { send({ type: "released", result: release() }); }
      catch (error) { send({ type: "release-error", error: error.message }); }
    }
  });
  try {
    release = mode === "sync"
      ? acquireDirectoryLockSync(lock, { timeoutMs })
      : await acquireDirectoryLock(lock, { timeoutMs });
    send({ type: "acquired", owner: JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")) });
  } catch (error) {
    send({ type: "failed", error: error.message });
  }
}

function processLockFixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clean-development-lock-processes-")));
  const lock = path.join(root, "workspace.lock");
  const owner = path.join(lock, "owner.json");
  const workerFile = path.join(root, "worker.mjs");
  fs.writeFileSync(workerFile, `(${lockWorker.toString()})();\n`);
  const workers = [];
  t.after(async () => {
    for (const worker of workers) {
      if (!worker.closed) worker.child.kill("SIGKILL");
    }
    await Promise.all(workers.map((worker) => worker.exit));
    fs.rmSync(root, { recursive: true, force: true });
  });
  function start(mode, options = {}) {
    const child = fork(workerFile, [new URL("../src/io.js", import.meta.url).href, JSON.stringify({ lock, mode, ...options })], {
      execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"]
    });
    const events = [];
    const pending = new Set();
    const worker = { child, closed: false, stderr: "", history: [] };
    const drain = () => {
      for (const waiting of pending) {
        const index = events.findIndex((event) => waiting.types.includes(event.type));
        if (index >= 0) waiting.finish(null, events.splice(index, 1)[0]);
        else if (worker.closed) waiting.finish(new Error(`Worker exited waiting for ${waiting.types}: ${worker.stderr}`));
      }
    };
    child.stderr.on("data", (chunk) => { worker.stderr += chunk; });
    child.on("message", (event) => { events.push(event); worker.history.push(event); drain(); });
    worker.exit = new Promise((resolve) => {
      child.once("exit", (code, signal) => { worker.closed = true; drain(); resolve({ code, signal }); });
    });
    child.on("error", (error) => {
      worker.stderr += error.message;
      for (const waiting of pending) waiting.finish(error);
    });
    worker.expect = (types) => new Promise((resolve, reject) => {
      const waiting = { types: Array.isArray(types) ? types : [types] };
      const timer = setTimeout(() => waiting.finish(new Error(
        `Timed out waiting for ${waiting.types}: ${JSON.stringify(worker.history)} ${worker.stderr}`
      )), 10_000);
      waiting.finish = (error, event) => {
        clearTimeout(timer);
        pending.delete(waiting);
        if (error) reject(error); else resolve(event);
      };
      pending.add(waiting);
      drain();
    });
    worker.release = async () => {
      child.send("release");
      const event = await worker.expect(["released", "release-error"]);
      assert.equal(event.type, "released", event.error);
      return event.result;
    };
    workers.push(worker);
    return worker;
  }
  return { root, lock, owner, start };
}

function ageLock(lock) {
  const old = new Date(Date.now() - 10_000);
  fs.utimesSync(lock, old, old);
}

for (const mode of ["async", "sync"]) {
  test(`${mode} real processes serialize acquisition, time out and reject a repeated old release`, async (t) => {
    const { lock, owner, start } = processLockFixture(t);
    const first = start(mode);
    const acquired = await first.expect("acquired");
    const original = fs.readFileSync(owner, "utf8");
    const next = start(mode === "sync" ? "async" : "sync");
    await next.expect("contended");
    const timed = start(mode, { timeoutMs: 150 });
    await timed.expect("contended");
    const result = await timed.expect(["failed", "acquired"]);
    assert.equal(result.type, "failed");
    assert.match(result.error, /Timed out waiting for .* lock/);
    assert.equal(fs.readFileSync(owner, "utf8"), original);
    assert.equal(new Set([first.child.pid, next.child.pid, timed.child.pid]).size, 3);
    assert.equal(await first.release(), true);
    const successor = await next.expect("acquired");
    assert.notEqual(successor.owner.token, acquired.owner.token);
    assert.equal(await first.release(), false);
    assert.equal(JSON.parse(fs.readFileSync(owner, "utf8")).token, successor.owner.token);
    assert.equal(await next.release(), true);
    assert.equal(fs.existsSync(lock), false);
  });

  test(`${mode} real contenders recover a crashed owner without overlapping ownership`, async (t) => {
    const { lock, owner, start } = processLockFixture(t);
    const holder = start(mode);
    const original = await holder.expect("acquired");
    const contenders = [start("async"), start("sync")];
    await Promise.all(contenders.map((worker) => worker.expect("contended")));
    holder.child.kill("SIGKILL");
    await holder.exit;
    assert.throws(() => process.kill(original.pid, 0), { code: "ESRCH" });
    // Make the genuinely dead owner's directory old; no mocked PID or clock.
    ageLock(lock);
    const acquisitions = contenders.map(async (worker, index) => ({ index, event: await worker.expect("acquired") }));
    const first = await Promise.race(acquisitions);
    assert.equal(JSON.parse(fs.readFileSync(owner, "utf8")).token, first.event.owner.token);
    assert.notEqual(first.event.owner.token, original.owner.token);
    assert.equal(await contenders[first.index].release(), true);
    const second = await acquisitions[1 - first.index];
    assert.notEqual(second.event.owner.token, first.event.owner.token);
    assert.equal(await contenders[first.index].release(), false);
    assert.equal(JSON.parse(fs.readFileSync(owner, "utf8")).token, second.event.owner.token);
    assert.equal(await contenders[second.index].release(), true);
    assert.equal(fs.existsSync(lock), false);
  });

  test(`${mode} contender rechecks a replacement lock after a real EEXIST wait`, async (t) => {
    const { root, lock, owner, start } = processLockFixture(t);
    const holder = start(mode);
    await holder.expect("acquired");
    const gate = path.join(root, "continue");
    const contender = start(mode, { timeoutMs: 150, gate });
    await contender.expect("contended");
    fs.renameSync(lock, path.join(root, "retired.lock"));
    const replacement = start(mode === "async" ? "sync" : "async");
    const current = await replacement.expect("acquired");
    const contents = fs.readFileSync(owner, "utf8");
    assert.equal(await holder.release(), false);
    fs.writeFileSync(gate, "continue\n");
    const result = await contender.expect(["failed", "acquired"]);
    assert.equal(result.type, "failed");
    assert.match(result.error, /Timed out waiting for .* lock/);
    assert.equal(fs.readFileSync(owner, "utf8"), contents);
    assert.equal(JSON.parse(contents).pid, current.pid);
    assert.equal(await replacement.release(), true);
    assert.equal(fs.existsSync(lock), false);
  });

  test(`${mode} real contender retains uncertain ownership instead of revoking a live holder`, async (t) => {
    for (const variant of ["missing", "malformed", "tokenless", "invalid-pid", "unknown-schema", "invalid-time"]) {
      await t.test(variant, async (t) => {
        const { root, lock, owner, start } = processLockFixture(t);
        const holder = start(mode);
        const { owner: record } = await holder.expect("acquired");
        const gate = path.join(root, "continue");
        const contender = start(mode, { timeoutMs: 150, gate });
        await contender.expect("contended");
        let contents;
        if (variant === "missing") fs.unlinkSync(owner);
        else {
          if (variant === "malformed") contents = "{interrupted";
          if (variant === "tokenless") contents = JSON.stringify({ ...record, token: "", pid: 2_147_483_647 });
          if (variant === "invalid-pid") contents = JSON.stringify({ ...record, pid: -1 });
          if (variant === "unknown-schema") contents = JSON.stringify({ ...record, schemaVersion: 99, pid: 2_147_483_647 });
          if (variant === "invalid-time") contents = JSON.stringify({ ...record, acquiredAt: "unknown", pid: 2_147_483_647 });
          fs.writeFileSync(owner, contents);
        }
        ageLock(lock);
        fs.writeFileSync(gate, "continue\n");
        const result = await contender.expect(["failed", "acquired"]);
        assert.equal(result.type, "failed", "Uncertain ownership must not authorize recovery");
        assert.match(result.error, /Timed out waiting for .* lock/);
        assert.equal(holder.closed, false);
        assert.equal(fs.existsSync(lock), true);
        if (variant === "missing") assert.equal(fs.existsSync(owner), false);
        else assert.equal(fs.readFileSync(owner, "utf8"), contents);
      });
    }
  });

  test(`${mode} release retains a substituted directory even when its owner token was copied`, async (t) => {
    const { root, lock, owner, start } = processLockFixture(t);
    const holder = start(mode);
    await holder.expect("acquired");
    const contents = fs.readFileSync(owner, "utf8");
    const retired = path.join(root, "retired.lock");
    fs.renameSync(lock, retired);
    fs.mkdirSync(lock);
    fs.writeFileSync(owner, contents);
    assert.equal(await holder.release(), false);
    assert.equal(fs.readFileSync(owner, "utf8"), contents);
    assert.equal(fs.readFileSync(path.join(retired, "owner.json"), "utf8"), contents);
  });

  test(`${mode} release never follows a substituted lock symlink`, async (t) => {
    const { root, lock, owner, start } = processLockFixture(t);
    const holder = start(mode);
    await holder.expect("acquired");
    const contents = fs.readFileSync(owner, "utf8");
    const retired = path.join(root, "retired.lock");
    fs.renameSync(lock, retired);
    fs.symlinkSync(retired, lock, process.platform === "win32" ? "junction" : "dir");
    assert.equal(await holder.release(), false);
    assert.equal(fs.lstatSync(lock).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(path.join(retired, "owner.json"), "utf8"), contents);
  });

  test(`${mode} release retains replaced owner files with copied contents`, async (t) => {
    for (const variant of ["copy", "symlink"]) {
      await t.test(variant, async (t) => {
        const { root, owner, start } = processLockFixture(t);
        const holder = start(mode);
        await holder.expect("acquired");
        const contents = fs.readFileSync(owner, "utf8");
        const saved = path.join(root, "saved-owner.json");
        fs.renameSync(owner, saved);
        if (variant === "copy") fs.writeFileSync(owner, contents);
        else {
          try { fs.symlinkSync(saved, owner, "file"); }
          catch (error) {
            if (process.platform !== "win32" || error.code !== "EPERM") throw error;
            t.skip("File symlinks require Windows developer mode or elevated privileges");
            return;
          }
        }
        assert.equal(await holder.release(), false);
        assert.equal(fs.readFileSync(owner, "utf8"), contents);
        assert.equal(fs.readFileSync(saved, "utf8"), contents);
      });
    }
  });

  test(`${mode} uncertain process lookup errors retain a real holder's lock`, async (t) => {
    for (const probeError of ["EPERM", "EACCES", "EIO"]) {
      await t.test(probeError, async (t) => {
        const { lock, owner, start } = processLockFixture(t);
        const holder = start(mode);
        await holder.expect("acquired");
        ageLock(lock);
        const contents = fs.readFileSync(owner, "utf8");
        const contender = start(mode, { timeoutMs: 150, probeError });
        const result = await contender.expect(["failed", "acquired"]);
        assert.equal(result.type, "failed");
        assert.match(result.error, /Timed out waiting for .* lock/);
        assert.equal(fs.readFileSync(owner, "utf8"), contents);
        assert.equal(await holder.release(), true);
      });
    }
  });
}
