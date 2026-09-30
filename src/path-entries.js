import path from "node:path";

/** Keep PATH entry spelling while exposing its literal directory for comparisons.
 * An ambiguous Windows entry has a null value: discovery cannot use it, while
 * environment edits can preserve it without inventing a different directory.
 */
export function pathEntries(value, platform = process.platform) {
  const input = String(value || "");
  if (platform !== "win32") return input.split(path.delimiter).map((raw) => ({ raw, value: raw }));
  const entries = [];
  let start = 0, quoted = false;
  for (let index = 0; index <= input.length; index += 1) {
    if (input[index] === '"') quoted = !quoted;
    if (index < input.length && (input[index] !== ";" || quoted)) continue;
    const raw = input.slice(start, index);
    const decoded = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    entries.push({ raw, value: decoded.includes('"') ? null : decoded });
    start = index + 1;
  }
  return entries;
}

/** A newly inserted literal Windows directory must not become several entries. */
export function formatPathEntry(value, platform = process.platform) {
  return platform === "win32" && value.includes(";") ? `"${value}"` : value;
}

/** Decode whole-entry double quotes in Windows PATH, not shell expressions. */
export function windowsPathEntries(value) {
  return pathEntries(value, "win32").map((entry) => entry.value).filter((entry) => entry);
}
