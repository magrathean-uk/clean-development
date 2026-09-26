import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const bump = JSON.parse(fs.readFileSync(path.join(root, ".version-bump.json"), "utf8"));

function versionIn(file) {
  const contents = fs.readFileSync(path.join(root, file), "utf8");
  if (file === "src/constants.js") return contents.match(/VERSION\s*=\s*["']([^"']+)["']/)?.[1];
  if (file.endsWith(".yaml")) return contents.match(/^version:\s*([^\s#]+)/m)?.[1];
  const parsed = JSON.parse(contents);
  if (file === "package-lock.json" && parsed.packages?.[""]?.version !== parsed.version) {
    throw new Error("package-lock.json root package version does not match its top-level version");
  }
  if (file.endsWith("marketplace.json")) return parsed.plugins?.[0]?.version;
  return parsed.version;
}

if (bump.version !== packageJson.version) throw new Error(".version-bump.json does not match package.json");
for (const file of bump.files) {
  if (!fs.existsSync(path.join(root, file))) throw new Error(`Version registry references missing file: ${file}`);
  const version = versionIn(file);
  if (version !== packageJson.version) throw new Error(`${file} has version ${version || "<missing>"}; expected ${packageJson.version}`);
}

const bugTemplate = fs.readFileSync(path.join(root, ".github/ISSUE_TEMPLATE/bug.yml"), "utf8");
const bugTemplateVersion = bugTemplate.match(/id:\s*version\s*\n[\s\S]*?placeholder:\s*["']?([^"'\s#]+)["']?/)?.[1];
if (bugTemplateVersion !== packageJson.version) {
  throw new Error(`Bug report template suggests version ${bugTemplateVersion || "<missing>"}; expected ${packageJson.version}`);
}

const javascript = [];
for (const top of ["bin", "src", "scripts", ".opencode"]) {
  const start = path.join(root, top);
  if (!fs.existsSync(start)) continue;
  const pending = [start];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile() && [".js", ".mjs"].includes(path.extname(entry.name))) javascript.push(target);
    }
  }
}

for (const file of javascript) {
  const checked = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (checked.status !== 0) throw new Error(`${path.relative(root, file)} failed syntax check:\n${checked.stderr}`);
}

for (const executable of ["bin/clean-development.js", "bin/clean-development-shim.js", "hooks/session-start"]) {
  const mode = fs.statSync(path.join(root, executable)).mode & 0o111;
  if (!mode) throw new Error(`${executable} is not executable`);
}

const codexSkill = fs.readFileSync(path.join(root, "skills/clean-development/SKILL.md"), "utf8");
const claudeSkill = fs.readFileSync(path.join(root, "claude-skills/clean-development/SKILL.md"), "utf8");
if (/^disable-model-invocation:/m.test(codexSkill)) {
  throw new Error("Codex skill must use agents/openai.yaml instead of Claude-only frontmatter");
}
if (!/^disable-model-invocation:\s*true\s*$/m.test(claudeSkill)) {
  throw new Error("Claude management skill must remain explicit-only with disable-model-invocation: true");
}
if (claudeSkill.replace(/^disable-model-invocation: true\r?\n/m, "") !== codexSkill) {
  throw new Error("Codex and Claude/Grok skill instructions must match apart from host invocation metadata");
}
const codexSkillPolicy = fs.readFileSync(path.join(root, "skills/clean-development/agents/openai.yaml"), "utf8");
if (!/^  allow_implicit_invocation:\s*false\s*$/m.test(codexSkillPolicy)) {
  throw new Error("Codex management skill must remain explicit-only with allow_implicit_invocation: false");
}
const claudeMarketplace = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin/marketplace.json"), "utf8"));
if (claudeMarketplace.plugins?.[0]?.skills !== "./claude-skills/") {
  throw new Error("Claude marketplace must replace root skill discovery with ./claude-skills/");
}
const codexMarketplace = JSON.parse(fs.readFileSync(path.join(root, ".agents/plugins/marketplace.json"), "utf8"));
const codexSource = codexMarketplace.plugins?.[0]?.source;
if (codexSource?.source !== "local" || codexSource?.path !== "./") {
  throw new Error("Codex marketplace must use the current local source/path format rooted at the package");
}
const rootManifest = JSON.parse(fs.readFileSync(path.join(root, "plugin.json"), "utf8"));
const codexManifest = JSON.parse(fs.readFileSync(path.join(root, ".codex-plugin/plugin.json"), "utf8"));
const defaultPrompts = [
  ...(rootManifest.extensions?.["com.openai"]?.interface?.defaultPrompt || []),
  codexManifest.interface?.defaultPrompt
].filter(Boolean);
if (defaultPrompts.some((prompt) => prompt !== "Use Clean Development only when explicitly requested.")) {
  throw new Error("Plugin default prompts must remain explicit-only and must not bootstrap normal sessions");
}
const grokMarketplace = JSON.parse(fs.readFileSync(path.join(root, ".grok-plugin/marketplace.json"), "utf8"));
const grokSource = grokMarketplace.plugins?.[0]?.source;
if (grokSource?.type !== "local" || grokSource?.path !== "./.grok-plugin") {
  throw new Error("Grok marketplace must use the dedicated no-skill plugin source");
}
if (!fs.existsSync(path.join(root, ".grok-plugin", "plugin.json")) || fs.existsSync(path.join(root, ".grok-plugin", "skills"))) {
  throw new Error("Dedicated Grok plugin must have a manifest and no skills directory");
}

console.log(`Checked ${javascript.length} JavaScript files, ${bump.files.length} synchronized version files, and the bug-report version prompt.`);
