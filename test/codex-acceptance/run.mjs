// Explicit preparation/verification only: this tool never starts a model host.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeFixture, loadFixture, setup, evaluateEvidence, observer, quote } from "./fixture.mjs";

export function main(args) {
  const phase = args.shift();
  const flags = {};
  while (args.length) {
    const key = args.shift(), value = args.shift();
    if (!["--scratch-root", "--npm", "--lab", "--case", "--disposition", "--project", "--event", "--host-version", "--session-id", "--tool-call-id", "--nonce", "--parent-session-id", "--subagent-id"].includes(key) || !value || Object.hasOwn(flags, key)) throw new Error("Use explicit named options"); flags[key] = value;
  }
  let report;
  if (phase === "prepare") {
    const item = makeFixture({ backend: "live", scratchRoot: flags["--scratch-root"], npm: flags["--npm"] });
    const file = path.join(item.root, "environment.sh");
    fs.writeFileSync(file, Object.entries(item.env).map(([key, value]) => `export ${key}=${quote(value)}`).join("\n") + "\n", { flag: "wx", mode: 0o600 });
    report = { root: item.root, source: item.source, environmentFile: file, modelCalls: false, liveAcceptance: "not-run",
      observerCommand: `${quote(process.execPath)} ${quote(observer)} observe CASE_NAME`,
      prerequisite: "Authenticate only the disposable profile and request the observer through an actual host tool call; this harness never launches Codex" };
  } else {
    const item = loadFixture(flags["--lab"]);
    if (phase === "setup") { setup(item); report = { root: item.root, setup: "completed", liveAcceptance: "not-run" }; }
    else if (phase === "verify") {
      if (!["routed", "native"].includes(flags["--disposition"])) throw new Error("Declare routed or native disposition");
      report = evaluateEvidence(item, flags["--case"], { routed: flags["--disposition"] === "routed", project: flags["--project"] || "normal",
      linkage: { event: flags["--event"], hostVersion: flags["--host-version"], sessionId: flags["--session-id"], toolCallId: flags["--tool-call-id"], nonce: flags["--nonce"], parentSessionId: flags["--parent-session-id"], subagentId: flags["--subagent-id"] } });
    }
    else throw new Error("Use prepare|setup|verify; no host launch phase exists");
  }
  console.log(JSON.stringify(report, null, 2)); return report.status === "failed" ? 1 : 0;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.length > 2) {
  try { process.exitCode = main(process.argv.slice(2)); } catch { console.error("Codex acceptance preparation/verification failed"); process.exitCode = 1; }
}
