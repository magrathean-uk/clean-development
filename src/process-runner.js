import childProcess from "node:child_process";
import os from "node:os";
import { windowsBatchInvocation } from "./windows-command.js";

/** Run one foreground child. Keep its caller/lease alive until exit or close.
 * Signals target the direct child, not an independently detached process tree.
 */
export function spawnInherited(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const env = options.env || process.env;
    const invocation = process.platform === "win32" && /\.(cmd|bat)$/i.test(command)
      ? windowsBatchInvocation(command, args, env) : { command, args };
    const child = childProcess.spawn(invocation.command, invocation.args, {
      cwd: options.cwd || process.cwd(), env, stdio: "inherit", windowsHide: false,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments || false
    });
    let settled = false, failed = false, failure, escalation = null;
    const forward = (signal) => {
      try { child.kill(signal); } catch {
        // A signal racing with exit is harmless. Do not release ownership merely
        // because signalling failed: retain it until the child actually stops.
      }
    };
    const interrupt = () => forward("SIGINT");
    const terminate = () => forward("SIGTERM");
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", terminate);
      if (escalation !== null) clearTimeout(escalation);
      if (failed) reject(failure);
      else {
        const signalNumber = signal ? os.constants.signals[signal] : null;
        resolve(signal ? 128 + (signalNumber || 1) : (code ?? 1));
      }
    };
    // Failed spawn emits error then close, but need not emit exit. Keep an error
    // listener through close so multiple error notifications cannot be unhandled.
    child.on("error", (error) => {
      if (!failed) { failed = true; failure = error; }
    });
    child.once("exit", finish);
    child.once("close", finish);
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    try {
      if (Number.isInteger(child.pid) && child.pid > 0) options.onSpawn?.(child);
    } catch (error) {
      failed = true; failure = error;
      forward("SIGTERM");
      // A failing ownership callback cannot abandon a running child and resolve
      // early. Escalate only this failed launch; ordinary commands have no timer.
      if (!settled) escalation = setTimeout(() => forward("SIGKILL"), 250);
    }
  });
}
