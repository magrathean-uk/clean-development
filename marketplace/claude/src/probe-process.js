import path from "node:path";
import { spawn } from "node:child_process";
import { environmentValue } from "./platform.js";
import { windowsBatchInvocation } from "./runtime.js";

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (value) => { clearTimeout(timer); child.removeListener("exit", exited); resolve(value); };
    const exited = () => done(true);
    const timer = setTimeout(() => done(false), timeoutMs);
    child.once("exit", exited);
  });
}

async function terminate(child, env) {
  if (!child.pid) return true;
  let complete = true;
  if (process.platform === "win32") {
    // Use the OS executable directly, never a shell or a PATH-supplied taskkill.
    const systemRoot = environmentValue(env, "SystemRoot");
    if (!systemRoot || !path.isAbsolute(systemRoot)) complete = false;
    else {
      complete = await new Promise((resolve) => {
        const killer = spawn(path.join(systemRoot, "System32", "taskkill.exe"), ["/pid", String(child.pid), "/T", "/F"],
          { env, stdio: "ignore", windowsHide: true });
        const timer = setTimeout(() => { killer.kill(); resolve(false); }, 1500);
        killer.once("error", () => { clearTimeout(timer); resolve(false); });
        killer.once("close", (code) => { clearTimeout(timer); resolve(code === 0); });
      });
    }
    try { child.kill("SIGKILL"); } catch { complete = false; }
  } else {
    try { process.kill(-child.pid, "SIGKILL"); }
    catch (error) { if (error.code !== "ESRCH") complete = false; }
  }
  return (await waitForExit(child, 1000)) && complete;
}

/** Capture a known probe command, not arbitrary repository scripts. A process
 * group/tree is best-effort cleanup, not containment of a hostile executable. */
export function captureProbeCommand(command, args, { cwd, env, timeoutMs = 5000, maxOutputBytes = 65536 } = {}) {
  if (typeof command !== "string" || !path.isAbsolute(command) || !Array.isArray(args)
    || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) throw new Error("Invalid probe command");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000
    || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 1024 * 1024) throw new Error("Invalid probe command limits");
  const invocation = process.platform === "win32" && /\.(cmd|bat)$/i.test(command)
    ? windowsBatchInvocation(command, args, env) : { command, args };
  return new Promise((resolve) => {
    let child, timer, stopping = null, settled = false, bytes = 0, interruptedSignal = null;
    const stdout = [], stderr = [];
    const finish = (failure, cleanupComplete = true) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.removeListener("SIGINT", interruptInt);
      process.removeListener("SIGTERM", interruptTerm);
      child?.stdout?.destroy(); child?.stderr?.destroy();
      resolve({ ok: !failure, failure, cleanupComplete, interruptedSignal, exitCode: child?.exitCode ?? null,
        stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    };
    const stop = (reason) => {
      if (stopping || settled) return;
      // Set the in-flight guard before termination can emit a child error.
      stopping = Promise.resolve().then(() => terminate(child, env));
      stopping.then((complete) => finish(reason, complete), () => finish(reason, false));
    };
    const interruptInt = () => { interruptedSignal = "SIGINT"; stop("interrupted"); };
    const interruptTerm = () => { interruptedSignal = "SIGTERM"; stop("interrupted"); };
    try {
      child = spawn(invocation.command, invocation.args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32", windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments || false });
    } catch { finish("spawn-failed"); return; }
    const collect = (chunks) => (chunk) => {
      if (stopping || settled) return;
      bytes += chunk.length;
      if (bytes > maxOutputBytes) { stop("output-limit"); return; }
      chunks.push(chunk);
    };
    child.stdout.on("data", collect(stdout)); child.stderr.on("data", collect(stderr));
    child.stdout.on("error", () => stop("output-failed")); child.stderr.on("error", () => stop("output-failed"));
    child.on("error", () => {
      if (settled) return;
      // An error after PID allocation is not evidence that no process exists.
      // Keep the initiating failure and wait for bounded termination evidence.
      if (!child.pid) finish("spawn-failed");
      else stop("process-failed");
    });
    child.once("close", (code) => {
      if (stopping) return;
      if (code === 0) finish(null);
      else finish("command-failed");
    });
    timer = setTimeout(() => stop("timeout"), timeoutMs);
    process.once("SIGINT", interruptInt); process.once("SIGTERM", interruptTerm);
  });
}
