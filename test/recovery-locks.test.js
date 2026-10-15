import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { acquireRecoveryLocks } from "../src/recovery-io.js";

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "recovery-lock-worker.mjs");

function fixture(t) {
  const scratch = process.env.CLEAN_DEVELOPMENT_REVIEW_SCRATCH || os.tmpdir();
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(scratch, "clean-recovery-lock-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = path.join(root, "state");
  fs.mkdirSync(state);
  const lock = path.join(state, "runtime.lock");
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "owner.json"), `${JSON.stringify({
    schemaVersion: 1, token: "confirmed-dead", pid: 2_147_483_647,
    acquiredAt: new Date(Date.now() - 10_000).toISOString()
  })}\n`);
  const stale = new Date(Date.now() - 5_000);
  fs.utimesSync(lock, stale, stale);
  return { root, state, lock };
}

function waitFor(child, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for worker event ${type}`)), 10_000);
    const onMessage = (message) => {
      if (message.type === "failed") {
        clearTimeout(timer);
        reject(new Error(message.error));
      } else if (message.type === type) {
        clearTimeout(timer);
        child.off("message", onMessage);
        resolve(message);
      }
    };
    child.on("message", onMessage);
    child.once("exit", (code) => {
      if (code !== 0) { clearTimeout(timer); reject(new Error(`Worker exited ${code}`)); }
    });
  });
}

function waitForFailure(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for worker failure")), 10_000);
    const onMessage = (message) => {
      if (message.type === "failed") {
        clearTimeout(timer);
        child.off("message", onMessage);
        resolve(message);
      }
    };
    child.on("message", onMessage);
  });
}

for (const mode of ["sync", "async"]) {
  test(`recovery cannot rename a stale lock while an ordinary ${mode} remover holds the removal guard`, async (t) => {
    const { state, lock, root } = fixture(t);
    const gate = path.join(root, "continue-removal");
    const worker = fork(WORKER, [lock, gate, mode], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    t.after(() => { if (worker.exitCode === null) worker.kill("SIGKILL"); });
    const exited = new Promise((resolve, reject) => worker.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Worker exited ${code}`))));
    await waitFor(worker, "before-owner-unlink");

    await assert.rejects(acquireRecoveryLocks(state, { timeoutMs: 150 }), /Recovery lock unavailable: .*runtime\.lock/);
    assert.equal(fs.readdirSync(state).some((name) => name.startsWith("runtime.lock.recovery-stale-")), false);
    fs.writeFileSync(gate, "continue\n");
    await waitFor(worker, "released");
    await exited;

    const recovery = await acquireRecoveryLocks(state, { timeoutMs: 500 });
    try {
      const owner = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8"));
      assert.equal(owner.pid, process.pid);
      assert.notEqual(owner.token, "confirmed-dead");
      assert.equal(recovery.retained.some((entry) => entry.path.includes(".recovery-stale-")), false);
    } finally {
      recovery.release();
    }
  });
}

test("recovery removers serialize on setup.lock and retain the stale generation once", async (t) => {
  const { state, lock } = fixture(t);
  const first = await acquireRecoveryLocks(state, { timeoutMs: 500 });
  try {
    await assert.rejects(acquireRecoveryLocks(state, { timeoutMs: 100 }), /Recovery lock unavailable: .*setup\.lock/);
    assert.equal(fs.existsSync(lock), true);
    assert.ok(fs.readdirSync(state).some((name) => name.startsWith("runtime.lock.recovery-stale-")));
    assert.equal(JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")).pid, process.pid);
  } finally {
    first.release();
  }
  const next = await acquireRecoveryLocks(state, { timeoutMs: 500 });
  next.release();
});

test("two recovery processes serialize removal of the same stale setup lock", async (t) => {
  const { state, root } = fixture(t);
  const setupLock = path.join(state, "setup.lock");
  fs.mkdirSync(setupLock);
  fs.writeFileSync(path.join(setupLock, "owner.json"), `${JSON.stringify({
    schemaVersion: 1, token: "stale-setup", pid: 2_147_483_647, acquiredAt: new Date().toISOString()
  })}\n`);
  const gate = path.join(root, "continue-rename");
  const first = fork(WORKER, [setupLock, gate, "recovery", state], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  t.after(() => { if (first.exitCode === null) first.kill("SIGKILL"); });
  const firstExit = new Promise((resolve, reject) => first.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`First recovery exited ${code}`))));
  await waitFor(first, "before-stale-rename");

  const second = fork(WORKER, [setupLock, gate, "recovery-contender", state], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  t.after(() => { if (second.exitCode === null) second.kill("SIGKILL"); });
  const secondFailure = waitForFailure(second);
  const failed = await secondFailure;
  assert.match(failed.error, /Recovery lock unavailable: .*setup\.lock/);
  fs.writeFileSync(gate, "continue\n");
  const firstOwner = await waitFor(first, "acquired");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(setupLock, "owner.json"), "utf8")), firstOwner.owner);
  assert.equal(fs.readdirSync(state).filter((name) => name.startsWith("setup.lock.recovery-stale-")).length, 1);
  first.send("release");
  await waitFor(first, "released");
  await firstExit;
});

test("recovery reports a stale rename before post-rename verification can fail", async (t) => {
  const { state } = fixture(t);
  const setupLock = path.join(state, "setup.lock");
  fs.mkdirSync(setupLock);
  fs.writeFileSync(path.join(setupLock, "owner.json"), `${JSON.stringify({
    schemaVersion: 1, token: "stale-setup", pid: 2_147_483_647, acquiredAt: new Date().toISOString()
  })}\n`);
  const lstatSync = fs.lstatSync;
  let injected = false;
  fs.lstatSync = (target, ...args) => {
    if (!injected && path.basename(String(target)).startsWith("setup.lock.recovery-stale-")) {
      injected = true;
      throw Object.assign(new Error("simulated post-rename identity read failure"), { code: "EIO" });
    }
    return lstatSync(target, ...args);
  };
  let failure;
  try {
    await assert.rejects(acquireRecoveryLocks(state, { timeoutMs: 500 }), (error) => {
      failure = error;
      return error.code === "EIO" && error.message === "simulated post-rename identity read failure";
    });
  } finally {
    fs.lstatSync = lstatSync;
  }
  const saved = fs.readdirSync(state).find((name) => name.startsWith("setup.lock.recovery-stale-"));
  assert.ok(injected);
  assert.ok(saved);
  assert.ok(failure.recovery.retainedLocks.some((entry) => entry.path === path.join(state, saved)));
  assert.equal(fs.existsSync(setupLock), false);
  assert.equal(fs.existsSync(`${setupLock}.removal-guard`), true);
});

for (const lockName of ["setup.lock", "runtime.lock"]) {
  for (const guardKind of ["empty directory", "malformed file"]) {
    test(`recovery waits on an absent ${lockName} with a ${guardKind} removal guard`, async (t) => {
      const { state } = fixture(t);
      const lock = path.join(state, lockName);
      if (lockName === "runtime.lock") fs.rmSync(lock, { recursive: true });
      const guard = `${lock}.removal-guard`;
      if (guardKind === "empty directory") fs.mkdirSync(guard);
      else fs.writeFileSync(guard, "malformed guard\n");

      await assert.rejects(acquireRecoveryLocks(state, { timeoutMs: 0 }), (error) => error.code === "ERECOVERYLOCK");
      assert.equal(fs.existsSync(lock), false);
      assert.equal(fs.existsSync(guard), true);
      if (guardKind === "malformed file") assert.equal(fs.readFileSync(guard, "utf8"), "malformed guard\n");

      fs.rmSync(guard, { recursive: true });
      const acquired = await acquireRecoveryLocks(state, { timeoutMs: 500 });
      try {
        assert.equal(fs.existsSync(path.join(state, "setup.lock", "owner.json")), true);
        assert.equal(fs.existsSync(path.join(state, "runtime.lock", "owner.json")), true);
      } finally {
        acquired.release();
      }
    });
  }
}

test("recovery removes only its empty lock directory when a guard appears just after mkdir", async (t) => {
  const { state } = fixture(t);
  const lock = path.join(state, "setup.lock");
  const guard = `${lock}.removal-guard`;
  const mkdirSync = fs.mkdirSync;
  let inserted = false;
  fs.mkdirSync = (target, ...args) => {
    const result = mkdirSync(target, ...args);
    if (!inserted && path.resolve(String(target)) === lock) {
      inserted = true;
      mkdirSync(guard, { mode: 0o700 });
    }
    return result;
  };
  try {
    await assert.rejects(acquireRecoveryLocks(state, { timeoutMs: 0 }), (error) => error.code === "ERECOVERYLOCK");
  } finally {
    fs.mkdirSync = mkdirSync;
  }
  assert.equal(inserted, true);
  assert.equal(fs.existsSync(lock), false);
  assert.equal(fs.lstatSync(guard).isDirectory(), true);
});
