import fs from "node:fs";
import path from "node:path";
import { VERSION } from "./constants.js";
import { integrationStatus } from "./integrations.js";
import { readJson } from "./io.js";
import { createSizeScanner } from "./measurement.js";
import { activeWorkspaceIds, listWorkspaceRecords, prunePlan } from "./state.js";

const OWNED_REASONS = new Set(["eligible", "pinned", "active", "recent"]);

export function parseByteSize(value) {
  const match = String(value).trim().match(/^(\d+)(B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)?$/i);
  if (!match) throw new Error("Invalid build budget; use whole bytes or an integer with B, KB, MB, GB, TB, KiB, MiB, GiB or TiB");
  const unit = (match[2] || "B").toUpperCase();
  const power = ["K", "M", "G", "T"].indexOf(unit[0]) + 1;
  const bytes = BigInt(match[1]) * BigInt(unit.includes("I") ? 1024 : 1000) ** BigInt(power);
  if (bytes > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Build budget exceeds the safe integer range");
  return Number(bytes);
}

function total(rows) {
  let observed = 0n;
  let incomplete = 0;
  for (const row of rows) {
    const size = row.size;
    if (size?.status !== "complete" || !Number.isSafeInteger(size.logicalBytes)) incomplete += 1;
    if (Number.isSafeInteger(size?.logicalBytes)) observed += BigInt(size.logicalBytes);
  }
  const overflow = observed > BigInt(Number.MAX_SAFE_INTEGER);
  return { status: incomplete || overflow ? "partial" : "complete", entries: rows.length, incompleteEntries: incomplete,
    observedLogicalBytes: overflow ? null : Number(observed), reclaimableBytes: null };
}

/** Inspect valid registered records only. This report never authorises deletion. */
export function storageStatus(config, { workspaces = false, sizes = false, buildBudgetBytes = null,
  maxEntries, maxDurationMs, env = process.env } = {}) {
  if (buildBudgetBytes !== null && (!Number.isSafeInteger(buildBudgetBytes) || buildBudgetBytes < 0)) {
    throw new Error("buildBudgetBytes must be a non-negative safe integer or null");
  }
  if (buildBudgetBytes !== null) { workspaces = true; sizes = true; }
  if (!sizes && (maxEntries !== undefined || maxDurationMs !== undefined)) throw new Error("Scan limits require --sizes or --build-budget");
  const scanner = sizes ? createSizeScanner({ maxEntries, maxDurationMs }) : null;
  const active = activeWorkspaceIds(config);
  const records = listWorkspaceRecords(config);
  const result = {
    schemaVersion: 1, version: VERSION, inspectedAt: new Date().toISOString(),
    configured: fs.existsSync(config.locations.configPath), configFile: config.locations.configPath,
    projectConfig: config.projectConfigPath, root: config.root, rootSource: config.rootSource,
    cacheRoot: config.cacheRoot, buildRoot: config.buildRoot, scratchRoot: config.scratchRoot,
    runtime: readJson(path.join(config.locations.stateDir, "runtime.json"), null),
    integrations: integrationStatus(config, env).integrations,
    workspaces: records.length, activeWorkspaces: [...active].sort()
  };
  if (workspaces) {
    result.workspaceDetails = prunePlan(config).map((entry) => ({
      workspaceId: entry.workspaceId, name: path.basename(entry.workspace), workspace: entry.workspace,
      buildRoot: entry.buildRoot, path: entry.path, lastUsedAt: entry.lastUsedAt,
      pinned: entry.pinned, activeOrUncertain: active.has(entry.workspaceId),
      selectedBuildRoot: path.resolve(entry.buildRoot) === path.resolve(config.buildRoot),
      eligible: entry.eligible, reason: entry.reason,
      size: scanner && OWNED_REASONS.has(entry.reason) ? scanner.measure(entry.path)
        : { status: "not-measured", reason: scanner ? entry.reason : "sizes-not-requested" }
    })).sort((a, b) => a.workspaceId.localeCompare(b.workspaceId) || a.buildRoot.localeCompare(b.buildRoot));
    result.retentionBuildDays = config.retention.buildDays;
    result.workspaceScope = "valid registered records; sizes and budget cover only the selected build root";
    if (scanner) {
      const selected = result.workspaceDetails.filter((entry) => entry.selectedBuildRoot);
      result.registeredBuilds = total(selected);
      result.eligibleBuilds = total(selected.filter((entry) => entry.eligible));
      if (buildBudgetBytes !== null) {
        const complete = result.registeredBuilds.status === "complete";
        const bytes = result.registeredBuilds.observedLogicalBytes;
        result.buildBudget = { scope: "registered-build-logical-bytes", limitBytes: buildBudgetBytes,
          status: complete ? (bytes > buildBudgetBytes ? "over" : "within") : "unknown",
          overByBytes: complete ? Math.max(0, bytes - buildBudgetBytes) : null,
          advisoryOnly: true, retentionUnchanged: true };
      }
    }
  }
  if (scanner) {
    result.scanLimits = scanner.limits;
    result.sizeMeasurements = Object.fromEntries([
      ["caches", config.cacheRoot], ["builds", config.buildRoot], ["scratch", config.scratchRoot]
    ].map(([name, root]) => [name, scanner.measure(root)]));
    // Legacy keys remain, but incomplete observations must not masquerade as totals.
    result.bytes = Object.fromEntries(Object.entries(result.sizeMeasurements)
      .map(([name, size]) => [name, size.status === "complete" ? size.logicalBytes : null]));
    result.sizeNote = "Logical file-name bytes, not space saved or reclaimable space. Scans share a budget, are not atomic, skip symlinks/special files and do not cross devices. Roots may overlap; do not sum them.";
  }
  return result;
}

function display(value) {
  return JSON.stringify(String(value)).slice(1, -1).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
function bytes(value) {
  if (!Number.isSafeInteger(value)) return "unknown";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${index ? value.toFixed(2) : value} ${units[index]}`;
}

export function formatStorageStatus(report) {
  const lines = [`Clean Development ${report.version} — read-only storage status`, `Build root: ${display(report.buildRoot)}`];
  if (report.workspaceDetails) {
    lines.push(`Retention: ${report.retentionBuildDays} days. Valid registered records: ${report.workspaces}.`, "");
    for (const row of report.workspaceDetails) {
      const measured = row.size.status === "not-measured" ? "not measured" : `${bytes(row.size.logicalBytes)} (${row.size.status})`;
      const protection = [row.reason, row.pinned && row.reason !== "pinned" ? "pinned" : null,
        row.activeOrUncertain ? "active/uncertain lease" : null].filter(Boolean).join("; ");
      lines.push(`${display(row.workspaceId)}  ${measured}  ${display(protection)}`,
        `  Source: ${display(row.workspace)} | Last used: ${display(row.lastUsedAt)}`, `  Build: ${display(row.path)}`);
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
  return lines.join("\n");
}
