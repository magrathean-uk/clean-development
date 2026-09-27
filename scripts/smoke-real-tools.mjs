import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedEnvironment } from "./harness-utils.mjs";
import { resolveExecutable } from "../src/runtime.js";
import { parseSmokeOptions, parseToolVersion, verificationSource, smokeOutcome, SMOKE_TOOLS, SMOKE_HELP, runVerificationCommand } from "./verification-utils.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "bin", "clean-development.js");
let options;
try { options = parseSmokeOptions(process.argv.slice(2)); }
catch (error) { console.error(error.message); process.exit(2); }
if (options.help) { console.log(SMOKE_HELP); process.exit(0); }
const source = verificationSource(root);
const startedAt = new Date().toISOString();
const started = performance.now();
const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clean-development-smoke-")));
const managed = path.join(temporary, "managed");
const inherited = isolatedEnvironment(temporary);
// Toolchains remain installed at their original locations, while tool user/cache
// settings and fixture writes use disposable homes. Ignore ambient npm options.
for (const key of Object.keys(inherited)) {
  if (key.toUpperCase().startsWith("NPM_CONFIG_") || ["RUSTUP_TRACE_DIR", "RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER"].includes(key.toUpperCase())) delete inherited[key];
}
const env = {
  ...inherited,
  HOME: path.join(temporary, "tool-home"), USERPROFILE: path.join(temporary, "tool-home"),
  XDG_CACHE_HOME: path.join(temporary, "tool-cache"), XDG_CONFIG_HOME: path.join(temporary, "tool-config"),
  XDG_DATA_HOME: path.join(temporary, "tool-data"), XDG_STATE_HOME: path.join(temporary, "tool-state"),
  CARGO_HOME: path.join(temporary, "cargo-home"),
  RUSTUP_HOME: process.env.RUSTUP_HOME || path.join(os.homedir(), ".rustup"),
  CARGO_NET_OFFLINE: "true",
  RUSTUP_AUTO_INSTALL: "0",
  GOENV: "off", GOWORK: "off", GOTOOLCHAIN: "local", GOPROXY: "off", GOSUMDB: "off",
  npm_config_userconfig: path.join(temporary, "npm-user.config"),
  npm_config_globalconfig: path.join(temporary, "npm-global.config"),
  npm_config_offline: "true", npm_config_audit: "false", npm_config_fund: "false",
  TMPDIR: path.join(temporary, "tmp"), TMP: path.join(temporary, "tmp"), TEMP: path.join(temporary, "tmp")
};
const commandLimits = { timeoutMs: 120000, maxOutputBytes: 2 * 1024 * 1024 };
function available(command) {
  return resolveExecutable(command, env, path.join(temporary, "data", "bin"));
}
function execute(command, args, cwd, timeout = commandLimits.timeoutMs) {
  return runVerificationCommand(command, args, { cwd, env, timeoutMs: timeout, maxOutputBytes: commandLimits.maxOutputBytes });
}
function runTool(command, args, cwd) {
  return execute(process.execPath, [cli, "run", "--", command, ...args], cwd);
}
function version(tool) {
  const executable = available(tool);
  if (!executable) throw new Error(`Tool unavailable during version check: ${tool}`);
  const result = execute(executable, tool === "go" ? ["version"] : ["--version"], temporary, 10000);
  const value = parseToolVersion(tool, result.stdout);
  if (!value) throw new Error(`Unrecognised version output for ${tool}`);
  return value;
}

function filesBelow(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(file) : entry.isFile() ? [file] : [];
  });
}

function assertManagedArtifact(file, directory) {
  const relative = path.relative(directory, fs.realpathSync(file));
  assert.ok(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), `Artifact escaped ${directory}: ${file}`);
  assert.ok(fs.statSync(file).size > 0, `Artifact is empty: ${file}`);
}

const fixtures = {
  cargo() {
    const project = path.join(temporary, "rust-smoke");
    fs.mkdirSync(path.join(project, "src"), { recursive: true });
    fs.writeFileSync(path.join(project, "Cargo.toml"), "[package]\nname = \"clean-development-smoke\"\nversion = \"0.0.0\"\nedition = \"2024\"\n");
    fs.writeFileSync(path.join(project, "src", "lib.rs"), "pub fn answer() -> u32 { 42 }\n");
    const result = runTool("cargo", ["check", "--quiet", "--offline", "--message-format=json"], project);
    assert.equal(fs.existsSync(path.join(project, "target")), false);
    const artifacts = result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
      .filter((entry) => entry.reason === "compiler-artifact").flatMap((entry) => entry.filenames);
    assert.ok(artifacts.length > 0, "Cargo reported no compiler artifacts");
    for (const artifact of artifacts) assertManagedArtifact(artifact, path.join(managed, "builds"));
  },

  go() {
    const project = path.join(temporary, "go-smoke");
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, "go.mod"), "module example.invalid/clean-development-smoke\n\ngo 1.22\n");
    fs.writeFileSync(path.join(project, "main_test.go"), "package smoke\nimport \"testing\"\nfunc TestSmoke(t *testing.T) {}\n");
    runTool("go", ["test", "./..."], project);
    const cache = path.join(managed, "caches", "go", "build");
    const artifacts = filesBelow(cache).filter((file) => /[a-f0-9]{64}-[ad]$/.test(path.basename(file)) && fs.statSync(file).size > 0);
    assert.ok(artifacts.length > 0, "Go produced no managed compiler cache entries");
    for (const artifact of artifacts) assertManagedArtifact(artifact, cache);
  },

  npm() {
    const project = path.join(temporary, "npm-smoke");
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "clean-development-smoke", version: "0.0.0", private: true, scripts: { check: "node -e \"\"" } }));
    fs.writeFileSync(path.join(project, "index.js"), "module.exports = 42;\n");
    runTool("npm", ["run", "check", "--silent"], project);
    const result = runTool("npm", ["config", "get", "cache"], project);
    const cache = path.join(managed, "caches", "node", "npm");
    assert.equal(fs.realpathSync(result.stdout.trim()), cache);
    const packed = JSON.parse(runTool("npm", ["pack", "--json", "--offline", "--ignore-scripts"], project).stdout)[0];
    runTool("npm", ["cache", "add", path.join(project, packed.filename), "--offline", "--ignore-scripts"], project);
    const artifacts = filesBelow(path.join(cache, "_cacache", "content-v2"));
    assert.ok(artifacts.length > 0, "npm produced no managed package cache content");
    for (const artifact of artifacts) assertManagedArtifact(artifact, cache);
  },

  uv() {
    assert.ok(available("python3"), "The uv smoke check requires an installed python3 to create its local wheel");
    const project = path.join(temporary, "uv-smoke");
    fs.mkdirSync(project, { recursive: true });
    const result = runTool("uv", ["cache", "dir", "--no-config"], project);
    const cache = path.join(managed, "caches", "python", "uv");
    assert.equal(fs.realpathSync(result.stdout.trim()), cache);
    const wheel = path.join(project, "clean_development_smoke-0.0.0-py3-none-any.whl");
    const module = "VALUE = 42\n";
    const generated = execute(available("python3"), ["-I", "-c", [
      "import sys, zipfile",
      "with zipfile.ZipFile(sys.argv[1], 'w') as wheel:",
      "    wheel.writestr('clean_development_smoke.py', 'VALUE = 42\\n')",
      "    wheel.writestr('clean_development_smoke-0.0.0.dist-info/METADATA', 'Metadata-Version: 2.1\\nName: clean-development-smoke\\nVersion: 0.0.0\\n')",
      "    wheel.writestr('clean_development_smoke-0.0.0.dist-info/WHEEL', 'Wheel-Version: 1.0\\nGenerator: clean-development-smoke\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n')",
      "    wheel.writestr('clean_development_smoke-0.0.0.dist-info/RECORD', '')"
    ].join("\n"), wheel], project);
    assert.equal(generated.status, 0, generated.stderr || generated.error?.message);
    const installed = path.join(project, "installed");
    runTool("uv", ["pip", "install", "--python", "python3", "--target", installed, "--offline", "--no-index", "--no-deps", "--no-config", "--no-python-downloads", "--no-managed-python", wheel], project);
    assert.equal(fs.readFileSync(path.join(installed, "clean_development_smoke.py"), "utf8"), module);
    const artifacts = filesBelow(cache).filter((file) => path.basename(file) === "clean_development_smoke.py");
    assert.ok(artifacts.length > 0, "uv produced no managed wheel cache content");
    for (const artifact of artifacts) {
      assertManagedArtifact(artifact, cache);
      assert.equal(fs.readFileSync(artifact, "utf8"), module);
    }
  }
};

const results = [];
let setupError = null;
try {
  for (const name of ["caches", "builds", "scratch"]) fs.mkdirSync(path.join(managed, name), { recursive: true });
  for (const directory of [env.TMPDIR, env.HOME, env.CARGO_HOME]) fs.mkdirSync(directory);
  fs.writeFileSync(path.join(temporary, ".clean-development.json"), '{"schemaVersion":1}\n');
  fs.writeFileSync(env.npm_config_userconfig, "");
  fs.writeFileSync(env.npm_config_globalconfig, "");
  for (const tool of SMOKE_TOOLS) {
    const required = options.required.includes(tool);
    if (!available(tool)) {
      results.push({ tool, required, status: "skipped", reason: "executable-unavailable", version: null, durationMs: 0 });
      continue;
    }
    const began = performance.now();
    let phase = "fixture";
    try {
      fixtures[tool]();
      phase = "version";
      const toolVersion = version(tool);
      const prerequisites = tool === "uv" ? { python3: version("python3") } : {};
      results.push({ tool, required, status: "passed", reason: null, version: toolVersion, prerequisites,
        fixture: `${tool}-offline-managed-artifact-v1`, durationMs: Math.round(performance.now() - began) });
    } catch (error) {
      results.push({ tool, required, status: "failed", reason: `${phase}-failed`, version: null,
        errorCode: /^[A-Z0-9_]+$/.test(error.code || "") ? error.code : "CHECK_FAILED", durationMs: Math.round(performance.now() - began) });
      if (!options.json) console.error(`${tool}: ${error.message}`);
    }
  }
} catch (error) {
  setupError = "fixture-setup-failed";
  if (!options.json) console.error(error.message);
} finally {
  try { fs.rmSync(temporary, { recursive: true, force: true }); }
  catch { setupError = "fixture-cleanup-failed"; }
}
let sourceUnchanged = false;
try {
  const after = verificationSource(root);
  sourceUnchanged = after.fingerprint === source.fingerprint && after.gitCommit === source.gitCommit;
  if (!sourceUnchanged) setupError = "source-changed-during-run";
} catch { setupError = "source-recheck-failed"; }
const outcome = smokeOutcome(results, options.required);
const report = { schemaVersion: 1, kind: "real-tool-smoke", packageVersion: JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version,
  source, sourceUnchanged, environment: { platform: process.platform, arch: process.arch, node: process.version, osRelease: os.release() },
  startedAt, finishedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - started),
  commandLimits, requiredTools: options.required, results, ...outcome, ok: outcome.ok && !setupError, setupError,
  scope: "local predefined offline fixtures, not native agent-host acceptance or a network/process sandbox" };
if (options.json) console.log(JSON.stringify(report, null, 2));
else if (report.ok) console.log(`Real-tool smoke checks passed: ${outcome.passed.join(", ")}.`);
else {
  if (!outcome.passed.length && !results.some((item) => item.status === "failed")) console.error("No real tools were available; smoke checks did not run");
  if (outcome.missingRequired.length) console.error(`Required tool checks did not pass: ${outcome.missingRequired.join(", ")}`);
  if (setupError) console.error(setupError);
}
process.exitCode = report.ok ? 0 : 1;
