// Read-only release consistency check; also works in the standalone clean-development subtree.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../runtime/lib/conf.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))), errors = [];
const text = (p) => fs.readFileSync(path.join(root, p), "utf8");
for (const p of ["package.json", "plugin.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json"]) {
  if (JSON.parse(text(p)).version !== VERSION) errors.push(`${p}: version differs`);
}
if (text("runtime/VERSION").trim() !== VERSION) errors.push("runtime/VERSION differs");
if (!text("machine/env.zsh").includes(`export CLEAN_DEV_VERSION=${VERSION}\n`)) errors.push("env.zsh version differs");
for (const harness of ["claude", "codex"]) {
  const doc = JSON.parse(text(`fragments/${harness}-hooks.json`));
  for (const [event, groups] of Object.entries(doc.hooks)) for (const group of groups) for (const hook of group.hooks) {
    if (hook.command !== `\"$HOME/dev/machine/runtime/clean-development/active/bin/cd-hook\" ${event === "SessionStart" ? "session-start" : event === "SessionEnd" ? "session-end" : "stop"} ${harness}`) errors.push(`${harness} fragment must use the portable version-less active/bin/cd-hook command`);
    if (event === "Stop" && hook.async === true) errors.push(`${harness} Stop must be synchronous`);
  }
}
if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
else console.log(`release ${VERSION}: runtime, environment, manifests and hook fragments agree`);
