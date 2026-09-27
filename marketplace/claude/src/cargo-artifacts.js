import fs from "node:fs";
import path from "node:path";
import { environmentValue } from "./platform.js";
import { isInjectedEnvironmentValue } from "./routing-environment.js";

// Deliberately an allowlist, not a shell parser or a Cargo alias resolver. Build
// (even debug), package, documentation and --no-run outputs may be deliverables.
const INTERMEDIATE = new Set(["check", "c", "test", "t", "run", "r", "bench", "clean"]);
const DELIVERABLE = new Set(["build", "b", "package", "publish", "rustc", "doc", "rustdoc"]);
const INSPECTION = new Set(["help", "version", "metadata", "locate-project"]);
const VALUES = new Set(["--color", "--manifest-path", "--config", "-C", "-Z", "--target-dir", "--artifact-dir", "--out-dir",
  "--target", "--profile", "--package", "-p", "--exclude", "--features", "-F", "--jobs", "-j", "--bin", "--example", "--test", "--bench", "--message-format", "--registry", "--index", "--format-version"]);
const SWITCHES = new Set(["-v", "-vv", "--verbose", "-q", "--quiet", "--offline", "--locked", "--frozen", "--release", "-r",
  "--workspace", "--all", "--all-features", "--no-default-features", "--all-targets", "--lib", "--bins", "--examples", "--tests", "--benches",
  "--no-run", "--no-fail-fast", "--keep-going", "--ignore-rust-version", "--future-incompat-report", "--timings", "--open",
  "--allow-dirty", "--no-verify", "--no-metadata", "--exclude-lockfile", "--dry-run", "--no-deps", "--document-private-items", "--list", "-l", "--help", "-h", "--version", "-V"]);

export function cargoArtifactError(reason) {
  const error = new Error(`Cargo artifact boundary: ${reason}. Choose an explicit --target-dir outside managed build roots for a recognised command, or use 'clean-development run --session skip -- cargo ...' for native execution. No artifacts were moved or deleted.`);
  error.code = "ERR_CARGO_ARTIFACT_BOUNDARY";
  return error;
}

function nativeConfigurationPresent(cwd, env, home) {
  let current = path.resolve(cwd);
  const directories = new Set();
  for (let depth = 0; depth < 256; depth += 1) {
    directories.add(path.join(current, ".cargo"));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
    if (depth === 255) return true;
  }
  const cargoHome = environmentValue(env, "CARGO_HOME");
  if (cargoHome || home) directories.add(cargoHome ? path.resolve(cwd, cargoHome) : path.join(home, ".cargo"));
  for (const directory of directories) {
    for (const name of ["config", "config.toml"]) {
      try { fs.lstatSync(path.join(directory, name)); return true; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  return false;
}

/** Read-only classification. Unknown syntax never grants disposable ownership.
 * Native Cargo config is not parsed: without an explicit target it may redirect
 * outputs or redefine an alias, so its presence conservatively blocks routing.
 * No manifest scripts, Cargo executable or model is consulted. */
export function inspectCargoArtifacts(args, { env = process.env, cwd = process.cwd(), home } = {}) {
  const result = { kind: "ambiguous", command: null, target: null, outputs: [], routeTarget: false, requiresExternal: false, reason: null };
  const fail = (reason) => ({ ...result, reason });
  if (args.length > 512 || args.some(arg => typeof arg !== "string" || arg.length > 8192 || /[\0\r\n]/.test(arg))) return fail("unrecognised or oversized invocation");
  let configOption = false;
  let exported = false;
  let help = false;
  let effectiveCwd = cwd;
  let targetFlag = null;
  const explicitEnvironment = [];
  for (const key of Object.keys(env)) {
    if (["cargo_target_dir", "cargo_build_target_dir"].includes(key.toLowerCase()) && env[key]
      && !isInjectedEnvironmentValue(env, key, env[key])) explicitEnvironment.push([key, env[key]]);
  }
  const targets = explicitEnvironment.filter(([key]) => key.toLowerCase() === "cargo_target_dir");
  const selected = targets.length ? targets : explicitEnvironment;
  if (new Set(selected.map(([, value]) => value)).size > 1) return fail("conflicting Cargo output environment spellings");
  result.target = selected[0]?.[1] || null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (i === 0 && arg.startsWith("+") && arg.length > 1) continue;
    if (arg === "--") {
      if (!["run", "r", "test", "t", "bench"].includes(result.command)) return fail("ambiguous arguments after --");
      break; // Program/test arguments are not Cargo output options.
    }
    if (!arg.startsWith("-")) {
      if (!result.command) result.command = arg;
      else if (!["test", "t", "bench", "help"].includes(result.command)) return fail("unrecognised positional arguments");
      continue;
    }
    const attached = /^(-[CZpjF])([^=].*)$/.exec(arg);
    const name = attached ? attached[1] : arg.split("=", 1)[0];
    if (VALUES.has(name)) {
      const value = attached ? attached[2] : arg.includes("=") ? arg.slice(name.length + 1) : args[++i];
      if (!value || value === "--" || (value.startsWith("-") && name !== "-j" && name !== "--jobs")) return fail("missing or ambiguous option value");
      if (name === "--target-dir") {
        if (targetFlag !== null) return fail("repeated --target-dir declarations");
        targetFlag = value;
      }
      if (["--artifact-dir", "--out-dir"].includes(name)) { exported = true; result.outputs.push(value); }
      if (name === "-C") effectiveCwd = path.resolve(cwd, value);
      if (name === "--config" || (name === "-Z" && value !== "unstable-options")) configOption = true;
    } else if (SWITCHES.has(arg) || arg.startsWith("--timings=")) {
      if (["--no-run", "--timings"].includes(arg) || arg.startsWith("--timings=")) exported = true;
      if (["--help", "-h", "--version", "-V"].includes(arg)) help = true;
    } else return fail("unrecognised Cargo option; disposable output cannot be established");
  }
  const command = result.command;
  if (command && !INTERMEDIATE.has(command) && !DELIVERABLE.has(command) && !INSPECTION.has(command)) return fail("custom command or alias; disposable output cannot be established");
  result.target = targetFlag ?? result.target;
  result.outputs.push(...explicitEnvironment.map(([, value]) => value));
  if (result.target) result.outputs.push(result.target);
  if (!command || help || INSPECTION.has(command) || (command === "package" && args.some(arg => ["--list", "-l"].includes(arg)))) {
    result.kind = "inspection";
    return result;
  }
  result.kind = DELIVERABLE.has(command) || exported ? "deliverable" : "intermediate";
  const nativeConfig = configOption || nativeConfigurationPresent(effectiveCwd, env, home);
  result.requiresExternal = result.kind === "deliverable" || nativeConfig;
  if (result.requiresExternal && !result.target) return fail(result.kind === "deliverable"
    ? "deliverable-producing invocation requires an explicit output target"
    : "native Cargo configuration makes implicit output selection ambiguous");
  result.routeTarget = !result.target;
  return result;
}

/** Cache-only adapters never select final output. Still refuse a recognised
 * explicit output flag that points into prune authority. This is not native
 * config or shell-script evaluation; unknown syntax remains the tool's domain. */
export function explicitCacheToolOutputs(tool, args, env) {
  const commands = { go: new Set(["build", "test"]), npm: new Set(["pack"]), uv: new Set(["build"]) };
  if (!commands[tool]?.has(args[0])) return [];
  const flags = { go: ["-o"], npm: ["--pack-destination"], uv: ["-o", "--out-dir"] }[tool];
  const outputs = [];
  for (let i = 1; i < args.length && args[i] !== "--"; i += 1) {
    for (const flag of flags) {
      if (args[i] === flag) {
        const value = args[++i];
        if (value && value !== "--") outputs.push(value);
        break;
      }
      if (args[i].startsWith(`${flag}=`)) outputs.push(args[i].slice(flag.length + 1));
    }
  }
  if (tool === "npm") {
    for (const [key, value] of Object.entries(env)) if (key.toLowerCase() === "npm_config_pack_destination" && value) outputs.push(value);
  }
  return outputs.filter(Boolean);
}
