import fs from "node:fs";
import path from "node:path";
import { acquireDirectoryLock, acquireDirectoryLockSync } from "../src/io.js";

// Node's test discovery may execute helper modules without arguments.
if (process.send && process.argv.length >= 5) {
  const [lock, gate, mode, state] = process.argv.slice(2);
  const pause = () => {
    const waiter = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(gate)) {
      if (Date.now() >= deadline) throw new Error("Test gate timed out");
      Atomics.wait(waiter, 0, 0, 10);
    }
  };

  try {
    if (mode === "recovery" || mode === "recovery-contender") {
      const { acquireRecoveryLocks } = await import("../src/recovery-io.js");
      const renameSync = fs.renameSync;
      const mkdirSync = fs.mkdirSync;
      if (mode === "recovery") {
        fs.renameSync = (source, destination) => {
          if (path.resolve(source) === path.resolve(lock)) {
            process.send({ type: "before-stale-rename" });
            pause();
          }
          return renameSync(source, destination);
        };
      } else {
        fs.mkdirSync = (directory, ...args) => {
          if (path.resolve(directory) === path.resolve(lock) + ".removal-guard") process.send({ type: "guard-attempt" });
          return mkdirSync(directory, ...args);
        };
      }
      const locks = await acquireRecoveryLocks(state, { timeoutMs: mode === "recovery" ? 2_000 : 500 });
      process.send({ type: "acquired", owner: JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")) });
      await new Promise((resolve) => process.once("message", (message) => message === "release" && resolve()));
      locks.release();
      process.send({ type: "released" });
    } else {
      const owner = path.join(lock, "owner.json");
      const unlinkSync = fs.unlinkSync;
      let paused = false;
      fs.unlinkSync = (file) => {
        if (!paused && path.resolve(file) === path.resolve(owner)) {
          paused = true;
          process.send({ type: "before-owner-unlink" });
          pause();
        }
        return unlinkSync(file);
      };
      const acquire = mode === "sync" ? acquireDirectoryLockSync : acquireDirectoryLock;
      const release = await acquire(lock, { timeoutMs: 2_000 });
      process.send({ type: "acquired" });
      release();
      process.send({ type: "released" });
    }
  } catch (error) {
    process.send({ type: "failed", error: error.message });
  }
}
