const LIMIT = 32;
const VALUE_LIMIT = 8192;

/** Inspect only an unambiguous leading cache-option prefix. This is not a
 * native CLI parser: stop at commands, unknown options and --, never at a
 * guessed child-argument boundary. Do not inspect or return unrelated argv. */
export function inspectNativeCacheOptions(tool, args) {
  if (!["npm", "uv"].includes(tool)) return null;
  if (!Array.isArray(args)) throw new TypeError("Command arguments must be an array");
  const option = tool === "npm" ? "--cache" : "--cache-dir";
  const variable = tool === "npm" ? "npm_config_cache" : "UV_CACHE_DIR";
  const report = { scope: "leading-cache-options-only", declarations: [], stopReason: "end-of-input",
    effectiveDestination: null, observed: false };
  let index = 0;
  while (index < args.length) {
    if (report.declarations.length >= LIMIT) { report.stopReason = "inspection-limit"; break; }
    const token = args[index];
    if (token === "--") { report.stopReason = "argument-boundary"; break; }
    if (tool === "uv" && ["--no-cache", "--no-cache-dir", "-n"].includes(token)) {
      report.declarations.push({ option: token, variable, effect: "temporary-cache", value: null });
      index += 1;
      continue;
    }
    if (typeof token !== "string" || (token !== option && !token.startsWith(`${option}=`))) {
      report.stopReason = "command-or-unknown-option"; break;
    }
    const attached = token.startsWith(`${option}=`);
    const value = attached ? token.slice(option.length + 1) : args[index + 1];
    // Keep invalid/oversized paths out of the report instead of truncating them
    // into a plausible destination or consuming a following option's value.
    if (typeof value !== "string" || !value || value.length > VALUE_LIMIT
      || /[\r\n\0]/.test(value) || (!attached && value.startsWith("-"))) {
      report.declarations.push({ option, variable, effect: "unknown", value: null });
      report.stopReason = "invalid-or-missing-value"; break;
    }
    report.declarations.push({ option, variable, effect: "path-override", value });
    index += attached ? 1 : 2;
  }
  report.ambiguous = report.declarations.length > 1 || report.declarations.some((item) => item.effect === "unknown");
  return report;
}
