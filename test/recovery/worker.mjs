// Disposable fixture only; no production fault switches or shell interpolation.
import fs from "node:fs";
import path from "node:path";
import { main } from "../../src/cli.js";
import { applyRecovery } from "../../src/recovery.js";

if (process.argv[2] === "recovery-worker") {
  const spec = JSON.parse(process.argv[3]);
  const originalRename = fs.renameSync;
  const originalLink = fs.linkSync;
  const originalUnlink = fs.unlinkSync;
  const originalCopy = fs.cpSync;
  const originalMkdir = fs.mkdirSync;
  const originalFsync = fs.fsyncSync;
  const send = (value) => process.send?.(value);
  let injected = false;
  function interrupt(boundary) {
    if (injected || spec.boundary !== boundary) return;
    injected = true;
    send({ event: "boundary", boundary });
    if (spec.crash) process.kill(process.pid, "SIGKILL");
    if (spec.barrier) {
      const start = Date.now();
      const wait = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(spec.barrier)) {
        if (Date.now() - start > 15_000) throw new Error("Disposable recovery barrier timed out");
        Atomics.wait(wait, 0, 0, 10);
      }
      return;
    }
    const error = new Error(`Injected EIO at ${boundary}`);
    error.code = "EIO";
    throw error;
  }
  fs.renameSync = function (from, to) {
    const result = originalRename(from, to);
    if (path.dirname(to) === path.join(process.env.CLEAN_DEVELOPMENT_DATA_HOME, "bin")) interrupt("launcher-published");
    if (to === path.join(process.env.CLEAN_DEVELOPMENT_DATA_HOME, "state", "runtime.json")) interrupt("receipt-published");
    if (to === path.join(process.env.CLEAN_DEVELOPMENT_DATA_HOME, "state", "recovery.json")) interrupt("witness-published");
    return result;
  };
  fs.cpSync = function (...args) {
    const result = originalCopy(...args);
    interrupt("runtime-copy");
    return result;
  };
  fs.unlinkSync = function (file) {
    const result = originalUnlink(file);
    if (path.dirname(file) === path.join(process.env.CLEAN_DEVELOPMENT_DATA_HOME, "bin")) interrupt("launcher-removed");
    return result;
  };
  fs.linkSync = function (...args) {
    const result = originalLink(...args);
    interrupt("repair-published");
    return result;
  };
  fs.fsyncSync = function (...args) {
    const result = originalFsync(...args);
    interrupt("repair-staged");
    return result;
  };
  fs.mkdirSync = function (...args) {
    try { return originalMkdir(...args); }
    catch (error) {
      if (error.code === "EEXIST" && path.basename(String(args[0])) === "setup.lock") send({ event: "contended" });
      throw error;
    }
  };
  try {
    const result = spec.command === "recover"
      ? await applyRecovery({ apply: true, planId: spec.planId })
      : await main([spec.command, ...(spec.command === "uninstall" ? [] : ["--agents", "codex"]), "--json"]);
    send({ event: "result", ok: true, result });
  } catch (error) {
    send({ event: "result", ok: false, code: error.code, message: error.message, recovery: error.recovery });
    process.exitCode = 1;
  } finally { process.disconnect?.(); }
}
