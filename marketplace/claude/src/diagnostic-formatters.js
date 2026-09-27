// Pure text rendering: no filesystem, environment, process or routing access.
// Encode complete generated lines exactly once; only our joins introduce line breaks.
function terminalLine(value) {
  // JSON escapes C0 controls, quotes, backslashes and unpaired surrogates.
  // Also make C1, direction controls and Unicode line separators visible.
  return JSON.stringify(String(value)).slice(1, -1)
    .replace(/[\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function formatExplanation(report) {
  const lines = [
    "Clean Development command prediction (read-only)",
    `Command: ${report.command}`,
    `Executable: ${report.executable.path || "not found"}${report.executable.found ? "" : " (unavailable)"}`,
    `Session: ${report.session.mode} (${report.session.source})`,
    `Routing: ${report.routing.status}`
  ];
  if (report.workspace) lines.push(`Workspace: ${report.workspace.root}`, `Workspace evidence: ${report.workspace.authority}`);
  if (report.routing.reason) lines.push(`Reason: ${report.routing.reason}`);
  for (const entry of report.routing.variables) {
    lines.push(`${entry.action === "preserve" ? "Preserve" : "Set"} ${entry.name}=${entry.value}`, `  ${entry.reason}; source: ${entry.source}`);
  }
  if (report.routing.commandLineTarget) lines.push(`Cargo command-line target: ${report.routing.commandLineTarget}`);
  return [...lines, "", ...report.limitations].map(terminalLine).join("\n");
}

function bytes(value) {
  if (!Number.isSafeInteger(value)) return "unknown";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${index ? value.toFixed(2) : value} ${units[index]}`;
}

export function formatStorageStatus(report) {
  const lines = [`Clean Development ${report.version} — read-only storage status`, `Build root: ${report.buildRoot}`];
  if (report.workspaceDetails) {
    lines.push(`Retention: ${report.retentionBuildDays} days. Valid registered records: ${report.workspaces}.`, "");
    for (const row of report.workspaceDetails) {
      const measured = row.size.status === "not-measured" ? "not measured" : `${bytes(row.size.logicalBytes)} (${row.size.status})`;
      const protection = [row.reason, row.pinned && row.reason !== "pinned" ? "pinned" : null,
        row.activeOrUncertain ? "active/uncertain lease" : null].filter(Boolean).join("; ");
      lines.push(`${row.workspaceId}  ${measured}  ${protection}`,
        `  Source: ${row.workspace} | Last used: ${row.lastUsedAt}`, `  Build: ${row.path}`);
    }
    if (!report.workspaceDetails.length) lines.push("No valid registered build records. Unregistered files are not cleanup candidates.");
  }
  if (report.sizeMeasurements) {
    lines.push("", "Managed roots (logical bytes; overlapping roots are not additive):");
    for (const [name, size] of Object.entries(report.sizeMeasurements)) lines.push(`  ${name}: ${bytes(size.logicalBytes)} (${size.status})`);
    if (report.registeredBuilds) lines.push(`Registered builds: ${bytes(report.registeredBuilds.observedLogicalBytes)} (${report.registeredBuilds.status})`,
      `Eligible under current retention: ${bytes(report.eligibleBuilds.observedLogicalBytes)} (${report.eligibleBuilds.status}); actual reclaimable space unknown.`);
  }
  if (report.buildBudget) lines.push(`Build budget: ${bytes(report.buildBudget.limitBytes)} — ${report.buildBudget.status}. Advisory only; pins, leases and retention unchanged.`);
  lines.push("", "Nothing changed. Use prune --json to review a fresh plan before explicitly applying it.");
  return lines.map(terminalLine).join("\n");
}

export function formatProbe(report) {
  const lines = [`Clean Development — ${report.executed ? "isolated probe" : "probe plan (read-only)"}`,
    `Tool: ${report.tool} | Status: ${report.status}`,
    `Executable: ${report.executable.path || "not found"}`];
  if (report.toolVersion) lines.push(`Version: ${report.toolVersion}`);
  for (const item of report.observations) lines.push(`${item.name}: ${item.matches ? "matched" : "MISMATCH"} (disposable storage)`);
  if (report.reason) lines.push(`Reason: ${report.reason}`);
  lines.push(`Cleanup: ${report.cleanup}`, `Scope: ${report.scope}`);
  if (report.retainedFixture) lines.push(`Retained fixture: ${report.retainedFixture}`);
  if (!report.executed && report.status === "not-tested") lines.push("Use --execute to run the displayed fixed query in disposable storage.");
  return lines.map(terminalLine).join("\n");
}
