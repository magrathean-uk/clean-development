#!/usr/bin/env node
// Holds nested installer locks until stdin closes. The worker leaves the main thread responsive.
import { Worker, isMainThread, workerData, parentPort } from "node:worker_threads";
import { withLock } from "../../install-lock.mjs";

if (isMainThread) {
  const flag = new Int32Array(new SharedArrayBuffer(4));
  const release = () => { Atomics.store(flag, 0, 1); Atomics.notify(flag, 0); };
  process.on("SIGTERM", release);
  process.stdin.on("data", () => {});
  process.stdin.on("end", release);
  process.stdin.on("error", release);
  const worker = new Worker(new URL(import.meta.url), { workerData: { paths: process.argv.slice(2), flag } });
  worker.on("message", (text) => process.stdout.write(text));
  worker.on("error", (error) => { console.error(error); process.exitCode = 1; });
  worker.on("exit", (code) => {
    if (code) process.exitCode = code;
    process.removeListener("SIGTERM", release); process.stdin.destroy();
  });
} else {
  const { paths, flag } = workerData;
  if (!paths.length) throw new Error("an installer lock path is required");
  const nest = (remaining) => withLock(remaining[0], () => {
    if (remaining.length > 1) return nest(remaining.slice(1));
    parentPort.postMessage("held\n"); Atomics.wait(flag, 0, 0); return "released";
  });
  parentPort.postMessage(`result ${JSON.stringify(nest(paths))}\n`);
}
