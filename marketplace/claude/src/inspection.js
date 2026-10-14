import { environmentValue } from "./platform.js";

/** Explicit inspection mode is an execution boundary, never routing consent. */
export function assertInspectionOperation(command, parsed, env) {
  if (environmentValue(env, "DEV_ENV_INSPECT_ONLY") !== "1") return;
  const options = parsed.options || {};
  const readOnly = ["help", "version", "status", "doctor", "explain"].includes(command)
    || (command === "env" && Boolean(options.tool))
    || (["setup", "update", "prepare", "session", "uninstall", "scratch"].includes(command) && options["dry-run"] === true)
    || (command === "probe" && !options.execute)
    || (["prune", "recover"].includes(command) && !options.apply)
    || (command === "xcode" && [undefined, "status", "prune"].includes(parsed.positionals?.[0]) && !options.apply);
  if (!readOnly) {
    throw new Error(`Inspection mode cannot execute '${command}'; start a normal session with available reviewed storage before writing`);
  }
}
