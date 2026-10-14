import path from "node:path";
import { SHIM_TOOLS } from "./constants.js";

/** Effective configuration coverage, not proof of execution or filesystem writes. */
export function toolCoverage(config, { detected = SHIM_TOOLS } = {}) {
  return detected.filter((tool) => SHIM_TOOLS.includes(tool)).map((tool) => {
    const enabled = config.enabled !== false && config.tools?.[tool] !== false;
    const optedIn = tool !== "swift" || config.tools?.swift === true;
    const active = enabled && optedIn;
    const report = { tool, enabled: active, scope: "effective configuration; session choice and native overrides still apply",
      behavior: !active ? "native" : tool === "cargo" ? "managed-build" : tool === "swift" ? "command-local" : "cache-only",
      reason: config.enabled === false ? "project-disabled" : !optedIn ? "opt-in-required" : !enabled ? "tool-disabled" : "enabled",
      outputs: [], pruning: tool === "cargo" && active ? "registered marker-verified Cargo builds only" : "none" };
    if (tool === "cargo") report.outputs.push({ kind: "build", destination: active ? config.buildRoot : "native target", retained: !active });
    else if (tool === "swift") {
      report.outputs.push({ kind: "shared-cache", destination: active ? path.join(config.cacheRoot, "swiftpm") : "native SwiftPM cache", retained: true });
      report.outputs.push({ kind: "mixed-products", destination: active && config.swiftpmWorkspaceRoot ? config.swiftpmWorkspaceRoot : "native package .build", retained: true });
      report.nativeOutputRemains = !active || !config.swiftpmWorkspaceRoot;
      report.note = "Only enabled swift build/test commands receive path flags; compiler/Xcode caches, output flags and credentials remain native";
    } else {
      report.outputs.push({ kind: "cache", destination: active ? config.cacheRoot : "native tool cache", retained: true });
      report.outputs.push({ kind: "script-output", destination: "native project or explicit output path", retained: true });
      report.nativeOutputRemains = true;
    }
    return report;
  });
}
