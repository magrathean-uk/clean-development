/**
 * Return the single package report from `npm pack --json` output.
 *
 * npm before 12 prints a one-element array of reports; npm 12 prints an object
 * keyed by package name. Accept either shape and require that the report is for
 * the expected package, so an unexpected or ambiguous result fails loudly
 * instead of being read as the wrong package.
 */
export function normalizeNpmPackReport(value, packageName) {
  let report;
  if (Array.isArray(value)) {
    if (value.length !== 1) throw new Error("npm pack did not return exactly one report");
    [report] = value;
  } else if (value !== null && typeof value === "object" && Object.keys(value).length === 1 && Object.hasOwn(value, packageName)) {
    report = value[packageName];
  } else {
    throw new Error("npm pack report shape is invalid");
  }
  if (report === null || typeof report !== "object" || Array.isArray(report) || report.name !== packageName) {
    throw new Error("npm pack report package identity is invalid");
  }
  return report;
}
