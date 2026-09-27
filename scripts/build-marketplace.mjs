import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundleRoot = path.join(root, "marketplace", "claude");
const check = process.argv.slice(2);

if (check.length > 1 || (check.length === 1 && check[0] !== "--check")) {
  throw new Error("Usage: node scripts/build-marketplace.mjs [--check]");
}

function regularFile(file, label) {
  const status = fs.lstatSync(file);
  if (status.isSymbolicLink() || !status.isFile()) throw new Error(`${label} must be a regular file: ${file}`);
  return status;
}

function sourceTree(relative, files) {
  const directory = path.join(root, relative);
  const status = fs.lstatSync(directory);
  if (status.isSymbolicLink() || !status.isDirectory()) throw new Error(`Source must be a real directory: ${relative}`);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    const childRelative = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Source must not contain symlinks: ${childRelative}`);
    if (entry.isDirectory()) sourceTree(childRelative, files);
    else if (entry.isFile()) files.set(childRelative, { source: child, mode: fs.statSync(child).mode & 0o777 });
    else throw new Error(`Source contains an unsupported entry: ${childRelative}`);
  }
}

function text(contents, mode = 0o644) {
  return { contents: `${contents.trimEnd()}\n`, mode };
}

function pluginManifest() {
  const source = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin", "plugin.json"), "utf8"));
  const repository = "https://github.com/magrathean-uk/clean-development";
  return text(JSON.stringify({
    name: source.name,
    displayName: "Clean Development",
    description: "Inspect and manage local development caches and build output with explicit session consent.",
    version: source.version,
    author: source.author,
    homepage: source.homepage,
    repository: source.repository,
    license: source.license,
    keywords: source.keywords,
    icon: "./.claude-plugin/icon.svg",
    privacyPolicyUrl: `${repository}/blob/main/PRIVACY.md`,
    supportUrl: `${repository}/blob/main/SUPPORT.md`,
    documentationUrl: `${repository}/blob/main/README.md`,
    termsOfServiceUrl: `${repository}/blob/main/TERMS.md`
  }, null, 2));
}

function readme() {
  return text(`# Clean Development for Claude Code

Clean Development keeps supported development caches and build output in a managed local location. This bundle supports local Claude Code sessions. It does not require a published npm package.

## Requirements

- Node.js 20.12 or later.
- Claude Code with this plugin enabled.

Invoke the manual-only management skill with \`/clean-development:clean-development\`. The plugin includes the CLI source, so when a global \`clean-development\` command is unavailable, use \`node \${CLAUDE_PLUGIN_ROOT}/bin/clean-development.js\` with the same arguments.

## Consent and routing

Installation does not configure storage, change project settings, or route commands. For inspection, use \`status --json\` and \`doctor --json\`. Before choosing a route for a repository, review \`session --dry-run --json\`; use session-only routing or save project settings only after the user chooses. \`setup --agents claude\` is an explicit opt-in for the native Claude integration.

Routing applies only to explicitly wrapped child commands. Their command arguments, working directory, tool behavior, and exit status remain their own.

## Data handling

The bundle has no remote cache backend, telemetry, or network service. Managed data stays on the local machine at the location chosen during setup or routing.

Local paths can include usernames and private project names. Configuration, workspace records, ownership receipts, and managed files remain locally until removed through the documented controls. There is no publisher service retaining data received from Claude. Wrapped commands retain the normal environment, including credentials, and may contact their own package registries or services. Claude processes prompts and tool output under its own policies. Clean Development does not upload those records to the publisher and is not a network sandbox.

[Privacy](PRIVACY.md) · [Support](SUPPORT.md) · [Software terms](TERMS.md) · [License](LICENSE)
`);
}

function expectedFiles() {
  const files = new Map();
  for (const directory of ["bin", "src", "integrations", "hooks", "schemas"]) sourceTree(directory, files);
  for (const relative of ["package.json", "LICENSE", "SUPPORT.md", "PRIVACY.md", "TERMS.md", "SECURITY.md", "docs/verification.md"]) {
    const source = path.join(root, relative);
    files.set(relative, { source, mode: regularFile(source, "Source").mode & 0o777 });
  }
  const icon = path.join(root, ".claude-plugin", "icon.svg");
  files.set(path.join(".claude-plugin", "icon.svg"), { source: icon, mode: regularFile(icon, "Source").mode & 0o777 });
  const skill = path.join(root, "claude-skills", "clean-development", "SKILL.md");
  files.set(path.join("skills", "clean-development", "SKILL.md"), { source: skill, mode: regularFile(skill, "Source").mode & 0o777 });
  files.set(path.join(".claude-plugin", "plugin.json"), pluginManifest());
  files.set("README.md", readme());
  return files;
}

function listBundleFiles(directory, prefix = "") {
  if (!fs.existsSync(directory)) return [];
  const status = fs.lstatSync(directory);
  if (status.isSymbolicLink() || !status.isDirectory()) throw new Error(`Bundle root must be a real directory: ${directory}`);
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Bundle must not contain symlinks: ${relative}`);
    if (entry.isDirectory()) files.push(...listBundleFiles(target, relative));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`Bundle contains an unsupported entry: ${relative}`);
  }
  return files;
}

function contents(entry) {
  return entry.source ? fs.readFileSync(entry.source) : Buffer.from(entry.contents);
}

function compare(files) {
  const errors = [];
  const expected = new Set(files.keys());
  for (const relative of listBundleFiles(bundleRoot)) {
    if (!expected.has(relative)) errors.push(`Unexpected bundle file: ${relative}`);
  }
  for (const [relative, entry] of files) {
    const target = path.join(bundleRoot, relative);
    if (!fs.existsSync(target)) {
      errors.push(`Missing bundle file: ${relative}`);
      continue;
    }
    const status = fs.lstatSync(target);
    if (status.isSymbolicLink() || !status.isFile()) {
      errors.push(`Bundle entry is not a regular file: ${relative}`);
      continue;
    }
    if (!fs.readFileSync(target).equals(contents(entry))) errors.push(`Stale bundle file: ${relative}`);
    // NTFS permissions cannot represent the Unix modes stored by Git. Content
    // and regular-file checks remain mandatory on every platform.
    if (process.platform !== "win32" && (status.mode & 0o777) !== entry.mode) errors.push(`Bundle mode differs: ${relative}`);
  }
  return errors;
}

function writeAtomically(target, value, mode) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, value, { mode });
  fs.renameSync(temporary, target);
  fs.chmodSync(target, mode);
}

const files = expectedFiles();
const initialErrors = compare(files).filter((error) => error.startsWith("Unexpected") || error.includes("not a regular file"));
if (initialErrors.length > 0) throw new Error(`Refusing to modify an unrecognized bundle:\n${initialErrors.join("\n")}`);

if (check[0] === "--check") {
  const errors = compare(files);
  if (errors.length > 0) throw new Error(`Claude marketplace bundle is stale:\n${errors.join("\n")}`);
  console.log("Claude marketplace bundle is current.");
} else {
  for (const [relative, entry] of files) writeAtomically(path.join(bundleRoot, relative), contents(entry), entry.mode);
  const errors = compare(files);
  if (errors.length > 0) throw new Error(`Claude marketplace bundle verification failed:\n${errors.join("\n")}`);
  console.log(`Built Claude marketplace bundle with ${files.size} files.`);
}
