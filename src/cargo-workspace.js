import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setEnvironmentValue } from "./platform.js";
import { identifyWorkspace } from "./workspace.js";

function manifestContext(args, cwd) {
  const forwarded = args[0]?.startsWith("+") ? [args[0]] : [];
  let base = path.resolve(cwd);
  let manifest = null;
  const configuration = [];
  const seen = new Set();
  for (let index = 0; index < args.length && args[index] !== "--"; index += 1) {
    const argument = args[index];
    const attached = /^(-[CZ])([^=].*)$/.exec(argument);
    const name = attached ? attached[1] : argument.split("=", 1)[0];
    if (!["-C", "--manifest-path", "--config", "-Z"].includes(name)) continue;
    const value = attached ? attached[2] : argument.includes("=") ? argument.slice(name.length + 1) : args[++index];
    if (!value || value === "--") throw new Error(`Cargo ${name} requires a value`);
    if (["-C", "--manifest-path"].includes(name) && seen.has(name)) throw new Error(`Cargo ${name} was provided more than once`);
    seen.add(name);
    if (name === "-C") {
      base = path.resolve(cwd, value);
      // Keep rustup/wrapper selection at the child's launch cwd. Cargo itself
      // must apply -C after the toolchain has been selected.
      forwarded.push("-C", value);
    } else if (name === "--manifest-path") manifest = value;
    else configuration.push(name, value);
  }
  return { base, manifest: manifest ? path.resolve(base, manifest) : null, forwarded, configuration };
}

export function cargoInvocationCwd(args, cwd = process.cwd()) {
  return manifestContext(args, cwd).base;
}

function discoveryContext(args, cwd) {
  const context = manifestContext(args, cwd);
  let directory = context.manifest ? path.dirname(context.manifest) : context.base;
  let nearest = context.manifest;
  let needsCargo = false;
  while (true) {
    const file = directory === path.dirname(context.manifest || "") && context.manifest
      ? context.manifest : path.join(directory, "Cargo.toml");
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) throw new Error(`Cargo manifest is not a file: ${file}`);
      nearest ||= file;
      // This is a conservative fast path, not a TOML parser. Any potential
      // workspace key, including escaped spelling, is resolved by Cargo itself.
      if (stat.size > 1024 * 1024 || /workspace|\\[uU]/.test(fs.readFileSync(file, "utf8"))) needsCargo = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return { ...context, nearest, needsCargo };
}

/** Resolve nontrivial Cargo layouts only at actual command dispatch, before locks
 * or ownership writes. Planning never calls this function. No dependency
 * resolution, project scripts, metadata build or persistent discovery cache. */
export function resolveCargoWorkspace(args, { executable, cwd = process.cwd(), env = process.env,
  invoke = spawnSync, invocation = (command, argv) => ({ command, args: argv }) } = {}) {
  const context = discoveryContext(args, cwd);
  if (!context.needsCargo) return identifyWorkspace("cargo", args, cwd);
  const argv = [...context.forwarded, "locate-project", "--workspace", "--message-format=json",
    "--manifest-path", context.nearest, ...context.configuration];
  const discoveryEnv = { ...env };
  setEnvironmentValue(discoveryEnv, "CARGO_NET_OFFLINE", "true");
  setEnvironmentValue(discoveryEnv, "RUSTUP_AUTO_INSTALL", "0");
  const prepared = invocation(executable, argv, discoveryEnv);
  const result = invoke(prepared.command, prepared.args, {
    cwd, env: discoveryEnv, encoding: "utf8", timeout: 5000,
    killSignal: "SIGKILL", maxBuffer: 65536, windowsHide: true,
    windowsVerbatimArguments: prepared.windowsVerbatimArguments || false
  });
  if (result.error || result.status !== 0) {
    const reason = result.error?.code || result.signal || `exit ${result.status}`;
    throw new Error(`Cannot resolve Cargo workspace (${reason}); managed build routing stopped before ownership writes. Check cargo locate-project --workspace with the selected toolchain.`);
  }
  let manifest;
  try {
    manifest = JSON.parse(result.stdout).root;
    if (typeof manifest !== "string" || !path.isAbsolute(manifest)
      || path.basename(manifest) !== "Cargo.toml" || !fs.statSync(manifest).isFile()) throw new Error("invalid manifest");
    manifest = fs.realpathSync.native(manifest);
  } catch {
    throw new Error("Cargo workspace discovery returned an invalid manifest; managed build routing stopped before ownership writes");
  }
  return identifyWorkspace("cargo", args, cwd, { root: path.dirname(manifest) });
}
