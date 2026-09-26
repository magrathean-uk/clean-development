import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "clean-development-package-"));
const previousRelease = "v0.1.0";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  return result;
}

function runJson(command, args, options = {}) {
  return JSON.parse(run(command, args, options).stdout);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function fakeCargo(directory) {
  fs.mkdirSync(directory);
  const child = path.join(directory, "capture-session-env.mjs");
  fs.writeFileSync(child, [
    "const names = ['CLEAN_DEVELOPMENT_SESSION_MODE', 'CLEAN_DEVELOPMENT_ACTIVE', 'CLEAN_DEVELOPMENT_RESOLVED_ROOT', 'CLEAN_DEVELOPMENT_WORKSPACE_ID', 'CARGO_TARGET_DIR'];",
    "process.stdout.write(JSON.stringify(Object.fromEntries(names.map((name) => [name, process.env[name] || null]))));"
  ].join("\n"));
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(directory, "cargo.cmd"), `@echo off\r\n\"${process.execPath}\" \"${child}\"\r\n`);
  } else {
    const command = path.join(directory, "cargo");
    fs.writeFileSync(command, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(child)}\n`, { mode: 0o755 });
  }
  return directory;
}

function sessionChild(binary, mode, cwd, env) {
  return runJson(binary, ["run", "--session", mode, "--", "cargo"], { cwd, env });
}

try {
  const previousTag = spawnSync("git", ["rev-parse", "--verify", `${previousRelease}^{commit}`], {
    cwd: root,
    encoding: "utf8"
  });
  if (previousTag.status !== 0) {
    throw new Error(`Installed upgrade verification requires the ${previousRelease} Git tag. Fetch full tag history before running npm run test:package.`);
  }
  const packed = JSON.parse(run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary]).stdout)[0];
  const tarball = path.join(temporary, packed.filename);
  const names = new Set(packed.files.map((entry) => entry.path));
  for (const required of [
    ".agents/plugins/marketplace.json",
    ".claude-plugin/marketplace.json",
    ".claude-plugin/plugin.json",
    ".codex-plugin/plugin.json",
    ".cursor-plugin/plugin.json",
    ".devin-plugin/plugin.json",
    ".grok-plugin/marketplace.json",
    ".grok-plugin/plugin.json",
    ".hermes-plugin/plugin.yaml",
    ".kimi-plugin/plugin.json",
    ".opencode/plugins/clean-development.js",
    ".pi/extensions/clean-development.ts",
    "bin/clean-development.js",
    "claude-skills/clean-development/SKILL.md",
    "docs/audit-2026-09-18.md",
    "docs/agent-integrations.md",
    "docs/architecture.md",
    "docs/configuration.md",
    "docs/master-plan.md",
    "docs/safety-model.md",
    "docs/skill-compatibility.md",
    "docs/verification.md",
    "gemini-extension.json",
    "hooks/session-start",
    "integrations/claude/hooks.json",
    "src/cli.js",
    "src/session.js",
    "plugin.json",
    "skills/clean-development/SKILL.md",
    "skills/clean-development/agents/openai.yaml",
    "CHANGELOG.md",
    "CODE_OF_CONDUCT.md",
    "CONTRIBUTING.md",
    "GOVERNANCE.md",
    "LICENSE",
    "README.md",
    "RELEASING.md",
    "ROADMAP.md",
    "SECURITY.md",
    "SUPPORT.md"
  ]) {
    assert.ok(names.has(required), `tarball is missing ${required}`);
  }
  const prefix = path.join(temporary, "prefix");
  run("npm", ["install", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", tarball]);
  const binary = path.join(prefix, "node_modules", ".bin", process.platform === "win32" ? "clean-development.cmd" : "clean-development");
  const version = run(binary, ["--version"], { cwd: temporary }).stdout.trim();
  assert.equal(version, packageJson.version);
  const contract = run(process.execPath, ["--input-type=module", "--eval", [
    "const plugin = await import('clean-development');",
    "const api = await import('clean-development/api');",
    "if (typeof plugin.default !== 'function' || typeof api.resolveConfig !== 'function' || typeof api.planSession !== 'function') process.exit(9);"
  ].join("\n")], { cwd: prefix });
  assert.equal(contract.status, 0);
  const project = path.join(temporary, "session-project");
  const managed = path.join(temporary, "managed");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "Cargo.toml"), "[package]\nname='package-check'\nversion='0.1.0'\n");
  const fakeBin = fakeCargo(path.join(temporary, "fake-bin"));
  const sessionEnv = {
    ...process.env,
    CLEAN_DEVELOPMENT_HOME: path.join(temporary, "home"),
    CLEAN_DEVELOPMENT_DATA_HOME: path.join(temporary, "data"),
    CLEAN_DEVELOPMENT_CONFIG_HOME: path.join(temporary, "config"),
    CLEAN_DEVELOPMENT_ROOT: managed,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`
  };
  const planned = runJson(binary, ["session", "--dry-run", "--json"], { cwd: project, env: sessionEnv });
  assert.deepEqual(planned.plan.detected.tools, ["cargo"]);
  assert.equal(fs.existsSync(path.join(project, ".clean-development.json")), false);
  assert.equal(fs.existsSync(managed), false);

  const skipProject = path.join(temporary, "fresh-skip-project");
  fs.mkdirSync(skipProject);
  fs.writeFileSync(path.join(skipProject, "Cargo.toml"), "[package]\nname='package-skip-check'\nversion='0.1.0'\n");
  const skipEnv = {
    ...sessionEnv,
    CLEAN_DEVELOPMENT_HOME: path.join(temporary, "skip-home"),
    CLEAN_DEVELOPMENT_DATA_HOME: path.join(temporary, "skip-data"),
    CLEAN_DEVELOPMENT_CONFIG_HOME: path.join(temporary, "skip-config"),
    CLEAN_DEVELOPMENT_ROOT: path.join(temporary, "skip-managed")
  };
  const freshSkip = sessionChild(binary, "skip", skipProject, skipEnv);
  assert.equal(freshSkip.CLEAN_DEVELOPMENT_SESSION_MODE, "skip");
  assert.equal(freshSkip.CLEAN_DEVELOPMENT_ACTIVE, null);
  assert.equal(freshSkip.CARGO_TARGET_DIR, null);
  assert.equal(fs.existsSync(skipEnv.CLEAN_DEVELOPMENT_DATA_HOME), false);
  assert.equal(fs.existsSync(skipEnv.CLEAN_DEVELOPMENT_CONFIG_HOME), false);
  assert.equal(fs.existsSync(skipEnv.CLEAN_DEVELOPMENT_ROOT), false);
  assert.equal(fs.existsSync(path.join(skipProject, ".clean-development.json")), false);

  const sessionOnly = sessionChild(binary, "session-only", project, sessionEnv);
  const canonicalManaged = fs.realpathSync.native(managed);
  assert.equal(sessionOnly.CLEAN_DEVELOPMENT_SESSION_MODE, "session-only");
  assert.equal(sessionOnly.CLEAN_DEVELOPMENT_ACTIVE, "1");
  assert.equal(sessionOnly.CLEAN_DEVELOPMENT_RESOLVED_ROOT, canonicalManaged);
  assert.ok(sessionOnly.CLEAN_DEVELOPMENT_WORKSPACE_ID);
  assert.ok(sessionOnly.CARGO_TARGET_DIR.startsWith(`${path.join(canonicalManaged, "builds")}${path.sep}`));
  assert.equal(fs.existsSync(path.join(project, ".clean-development.json")), false);
  assert.equal(fs.existsSync(path.join(project, "target")), false);

  const persisted = sessionChild(binary, "persist", project, sessionEnv);
  assert.equal(persisted.CLEAN_DEVELOPMENT_SESSION_MODE, "session-only");
  assert.equal(persisted.CLEAN_DEVELOPMENT_ACTIVE, "1");
  assert.equal(persisted.CLEAN_DEVELOPMENT_RESOLVED_ROOT, canonicalManaged);
  assert.ok(persisted.CLEAN_DEVELOPMENT_WORKSPACE_ID);
  assert.ok(persisted.CARGO_TARGET_DIR.startsWith(`${path.join(canonicalManaged, "builds")}${path.sep}`));
  const projectConfigFile = path.join(project, ".clean-development.json");
  const persistedProjectContents = fs.readFileSync(projectConfigFile, "utf8");
  const projectConfig = JSON.parse(persistedProjectContents);
  assert.equal(projectConfig.enabled, true);
  assert.equal(projectConfig.tools.cargo, true);

  const skipped = sessionChild(binary, "skip", project, sessionEnv);
  assert.equal(skipped.CLEAN_DEVELOPMENT_SESSION_MODE, "skip");
  assert.equal(skipped.CLEAN_DEVELOPMENT_ACTIVE, null);
  assert.equal(skipped.CLEAN_DEVELOPMENT_RESOLVED_ROOT, null);
  assert.equal(skipped.CLEAN_DEVELOPMENT_WORKSPACE_ID, null);
  assert.equal(skipped.CARGO_TARGET_DIR, null);
  assert.equal(fs.readFileSync(projectConfigFile, "utf8"), persistedProjectContents);

  const previousArchive = path.join(temporary, `${previousRelease}.tar`);
  const previousSource = path.join(temporary, "previous-source");
  fs.mkdirSync(previousSource);
  run("git", ["archive", "--format=tar", "--output", previousArchive, previousRelease]);
  run("tar", ["-xf", previousArchive, "-C", previousSource]);
  const previousPacked = runJson("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary], { cwd: previousSource });
  const previousPrefix = path.join(temporary, "previous-prefix");
  run("npm", ["install", "--prefix", previousPrefix, "--ignore-scripts", "--no-audit", "--no-fund", path.join(temporary, previousPacked[0].filename)]);
  const previousBinary = path.join(previousPrefix, "node_modules", ".bin", process.platform === "win32" ? "clean-development.cmd" : "clean-development");
  assert.equal(run(previousBinary, ["--version"], { cwd: temporary }).stdout.trim(), "0.1.0");

  const lifecycleRoot = path.join(temporary, "lifecycle-managed");
  const lifecycleEnv = {
    ...sessionEnv,
    CLEAN_DEVELOPMENT_HOME: path.join(temporary, "lifecycle-home"),
    CLEAN_DEVELOPMENT_DATA_HOME: path.join(temporary, "lifecycle-data"),
    CLEAN_DEVELOPMENT_CONFIG_HOME: path.join(temporary, "lifecycle-config"),
    CLEAN_DEVELOPMENT_ROOT: lifecycleRoot,
    CODEX_HOME: path.join(temporary, "lifecycle-codex")
  };
  const installed = runJson(previousBinary, ["setup", "--agents", "codex", "--json"], { cwd: temporary, env: lifecycleEnv });
  assert.equal(installed.runtime.version, "0.1.0");
  const upgraded = runJson(binary, ["update", "--agents", "codex", "--json"], { cwd: temporary, env: lifecycleEnv });
  assert.equal(upgraded.command, "update");
  assert.equal(upgraded.runtime.version, packageJson.version);
  const runtimeReceipt = JSON.parse(fs.readFileSync(path.join(lifecycleEnv.CLEAN_DEVELOPMENT_DATA_HOME, "state", "runtime.json"), "utf8"));
  assert.equal(runtimeReceipt.version, packageJson.version);
  assert.equal(runtimeReceipt.status, "installed");
  assert.equal(runtimeReceipt.source, fs.realpathSync.native(path.join(prefix, "node_modules", "clean-development")));
  const archivedReceipts = path.join(lifecycleEnv.CLEAN_DEVELOPMENT_DATA_HOME, "state", "runtime-receipts");
  assert.ok(fs.readdirSync(archivedReceipts).some((name) => name.startsWith("0.1.0-")));

  const status = runJson(binary, ["status", "--json"], { cwd: temporary, env: lifecycleEnv });
  assert.equal(status.version, packageJson.version);
  assert.equal(status.configured, true);
  assert.equal(status.root, fs.realpathSync.native(lifecycleRoot));
  assert.equal(status.runtime.version, packageJson.version);
  assert.equal(status.runtime.status, "installed");
  const launcher = path.join(lifecycleEnv.CLEAN_DEVELOPMENT_DATA_HOME, "bin", process.platform === "win32" ? "clean-development.cmd" : "clean-development");
  assert.equal(fs.existsSync(launcher), true);
  const uninstalled = runJson(binary, ["uninstall", "--json"], { cwd: temporary, env: lifecycleEnv });
  assert.equal(uninstalled.dryRun, false);
  assert.equal(uninstalled.runtime.retained.length, 0);
  assert.equal(fs.existsSync(launcher), false);
  assert.equal(fs.existsSync(path.join(lifecycleEnv.CLEAN_DEVELOPMENT_DATA_HOME, "runtime", packageJson.version)), false);
  assert.equal(fs.existsSync(path.join(lifecycleEnv.CLEAN_DEVELOPMENT_DATA_HOME, "runtime", "0.1.0")), false);

  const currentLifecycleEnv = {
    ...sessionEnv,
    CLEAN_DEVELOPMENT_HOME: path.join(temporary, "current-home"),
    CLEAN_DEVELOPMENT_DATA_HOME: path.join(temporary, "current-data"),
    CLEAN_DEVELOPMENT_CONFIG_HOME: path.join(temporary, "current-config"),
    CLEAN_DEVELOPMENT_ROOT: path.join(temporary, "current-managed"),
    CODEX_HOME: path.join(temporary, "current-codex")
  };
  const currentInstalled = runJson(binary, ["setup", "--agents", "codex", "--json"], { cwd: temporary, env: currentLifecycleEnv });
  assert.equal(currentInstalled.runtime.version, packageJson.version);
  const currentStatus = runJson(binary, ["status", "--json"], { cwd: temporary, env: currentLifecycleEnv });
  assert.equal(currentStatus.configured, true);
  assert.equal(currentStatus.runtime.version, packageJson.version);
  assert.equal(currentStatus.runtime.status, "installed");
  const currentLauncher = path.join(currentLifecycleEnv.CLEAN_DEVELOPMENT_DATA_HOME, "bin", process.platform === "win32" ? "clean-development.cmd" : "clean-development");
  assert.equal(fs.existsSync(currentLauncher), true);
  const currentUninstalled = runJson(binary, ["uninstall", "--json"], { cwd: temporary, env: currentLifecycleEnv });
  assert.equal(currentUninstalled.runtime.retained.length, 0);
  assert.equal(fs.existsSync(currentLauncher), false);
  assert.equal(fs.existsSync(path.join(currentLifecycleEnv.CLEAN_DEVELOPMENT_DATA_HOME, "runtime", packageJson.version)), false);
  console.log(`Verified ${packed.filename} (${packed.files.length} files, ${packed.size} bytes).`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
