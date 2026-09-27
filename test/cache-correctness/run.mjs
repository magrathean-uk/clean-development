import path from "node:path";
import { fileURLToPath } from "node:url";
import { Lab } from "./harness.mjs";
import { goLab } from "./go.mjs";
import { cargoLab } from "./cargo.mjs";
import { npmLab, uvLab } from "./packages.mjs";
export const cases = { go: goLab, cargo: cargoLab, npm: npmLab, uv: uvLab };
export async function runToolLab(tool, { keep = false } = {}) {
  if (!Object.hasOwn(cases, tool)) throw new Error(`Unknown real-tool lab: ${tool}`);
  const lab = new Lab(tool); let error = null;
  try { await cases[tool](lab); } catch (caught) { error = caught; }
  return lab.finish(error, keep);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && !process.env.NODE_TEST_CONTEXT) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log("Usage: node test/cache-correctness/run.mjs --run [--tools=go,npm,uv,cargo]\nExplicit runs retain new disposable evidence roots; exits: passed=0, failed=1, blocked=2.");
  } else {
    if (!args.includes("--run") || args.some((arg) => arg !== "--run" && !arg.startsWith("--tools=")) || args.filter((arg) => arg.startsWith("--tools=")).length > 1) throw new Error("Use --run [--tools=go,npm,uv,cargo] or --help");
    const tools = (args.find((arg) => arg.startsWith("--tools="))?.slice(8) ?? Object.keys(cases).join(",")).split(",");
    if (new Set(tools).size !== tools.length || tools.some((tool) => !Object.hasOwn(cases, tool))) throw new Error("Select unique supported tool names");
    const reports = [];
    for (const tool of tools) { const report = await runToolLab(tool, { keep: true }); reports.push(report); console.error(`${tool}: ${report.status}; ${report.evidenceRoot}`); }
    console.log(JSON.stringify(reports, null, 2));
    process.exitCode = reports.some((r) => r.status === "failed") ? 1 : reports.some((r) => r.status === "blocked") ? 2 : 0;
  }
}
