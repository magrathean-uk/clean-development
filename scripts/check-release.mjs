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
  for (const groups of Object.values(doc.hooks)) for (const group of groups) for (const hook of group.hooks) {
    if (!hook.command.includes(`/runtime/clean-development/${VERSION}/bin/cd-hook'`)) errors.push(`${harness} fragment version differs`);
  }
}
const monorepo = path.dirname(root);
if (fs.existsSync(path.join(monorepo, "runbook/claude-work/provision.py"))) {
  const provisioning = fs.readFileSync(path.join(monorepo, "runbook/claude-work/provision.py"), "utf8");
  if (!provisioning.includes(`'clean-development','${VERSION}'`)) errors.push("claude-work pin differs");
  const config = fs.readFileSync(path.join(monorepo, "bin/codex-config-install"), "utf8");
  if (!config.includes(`CLEAN_DEV_VERSION = "${VERSION}"`)) errors.push("Codex installer pin differs");
  const marketplace = JSON.parse(fs.readFileSync(path.join(monorepo, ".claude-plugin/marketplace.json")));
  if (marketplace.plugins.find((p) => p.name === "clean-development")?.version !== VERSION) errors.push("marketplace version differs");
}
if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
else console.log(`release ${VERSION}: runtime, environment, manifests, fragments and current provisioning pins agree`);
