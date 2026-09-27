import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveExecutable } from "../src/runtime.js";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repository, "bin", "clean-development.js");
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  console.log("Usage: node scripts/run-fixture-lab.mjs [--output NEW_DIRECTORY]\nRuns offline baseline/routed fixtures; retains projects and report.json.");
  process.exit(0);
}
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--output" || !args[1])) {
  throw new Error("Use --help or --output NEW_DIRECTORY");
}
if (process.platform === "win32") throw new Error("This fixture runner currently supports macOS and Linux");

const requestedOutput = args.length ? path.resolve(args[1]) : null;
if (requestedOutput) fs.mkdirSync(requestedOutput);
const outputRoot = fs.realpathSync(requestedOutput || fs.mkdtempSync(path.join(os.tmpdir(), "clean-development-lab-")));
const tools = Object.fromEntries(["cargo", "go", "npm"].map((name) => [name, resolveExecutable(name, process.env)]));
const toolPath = [...new Set([path.dirname(process.execPath), ...Object.values(tools).filter(Boolean).map((file) => path.dirname(file)), "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(path.delimiter);
const report = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  repository,
  outputRoot,
  platform: `${process.platform}-${process.arch}`,
  node: process.version,
  tools,
  commands: [],
  cases: [],
  checks: [],
  errors: []
};
const reportFile = path.join(outputRoot, "report.json");
const saveReport = () => fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
const digest = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
saveReport();

function execute(command, argv, cwd, env, label) {
  const started = Date.now();
  const result = spawnSync(command, argv, { cwd, env, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  report.commands.push({ label, command, args: argv, cwd, exitCode: result.status, signal: result.signal, milliseconds: Date.now() - started, stdout: result.stdout || "", stderr: result.stderr || "", error: result.error?.message });
  saveReport();
  if (result.error || result.status !== 0) throw new Error(`${label}: ${result.error?.message || `exit ${result.status}${result.signal ? ` (${result.signal})` : ""}`}; see report.json`);
  return result.stdout.trim();
}

function materialize(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const target = path.join(destination, entry.name.replace(/\.fixture$/, ""));
    if (entry.isDirectory()) materialize(path.join(source, entry.name), target);
    else fs.copyFileSync(path.join(source, entry.name), target);
  }
}

function inventory(directory) {
  const result = { path: directory, exists: fs.existsSync(directory), files: 0, bytes: 0 };
  const pending = result.exists ? [directory] : [];
  while (pending.length) {
    const current = pending.pop();
    const details = fs.lstatSync(current);
    if (details.isSymbolicLink()) continue;
    if (details.isDirectory()) {
      for (const name of fs.readdirSync(current)) pending.push(path.join(current, name));
    } else if (details.isFile()) {
      result.files += 1;
      result.bytes += details.size;
    }
  }
  return result;
}

function check(name, condition) {
  report.checks.push({ name, pass: Boolean(condition) });
  assert.ok(condition, name);
}

function within(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function laneEnvironment(directory) {
  const locations = Object.fromEntries(["home", "tmp", "config", "data", "xdg-cache", "cargo-home", "go-path"].map((name) => [name, path.join(directory, name)]));
  for (const target of Object.values(locations)) fs.mkdirSync(target, { recursive: true });
  const userNpmConfig = path.join(directory, "npm-user.conf");
  const globalNpmConfig = path.join(directory, "npm-global.conf");
  fs.writeFileSync(userNpmConfig, "");
  fs.writeFileSync(globalNpmConfig, "");
  return {
    PATH: toolPath,
    HOME: locations.home,
    TMPDIR: locations.tmp,
    TMP: locations.tmp,
    TEMP: locations.tmp,
    XDG_CACHE_HOME: locations["xdg-cache"],
    XDG_CONFIG_HOME: locations.config,
    XDG_DATA_HOME: locations.data,
    CLEAN_DEVELOPMENT_HOME: locations.home,
    CLEAN_DEVELOPMENT_CONFIG_HOME: path.join(directory, "clean-config"),
    CLEAN_DEVELOPMENT_DATA_HOME: path.join(directory, "clean-data"),
    CLEAN_DEVELOPMENT_ROOT: path.join(directory, "managed"),
    CARGO_HOME: locations["cargo-home"],
    CARGO_NET_OFFLINE: "true",
    RUSTUP_HOME: process.env.RUSTUP_HOME || path.join(os.homedir(), ".rustup"),
    RUSTUP_AUTO_INSTALL: "0",
    GOPATH: locations["go-path"],
    GOPROXY: "off",
    GOSUMDB: "off",
    GOTOOLCHAIN: "local",
    GOENV: "off",
    GOWORK: "off",
    GOTELEMETRY: "off",
    npm_config_userconfig: userNpmConfig,
    npm_config_globalconfig: globalNpmConfig,
    npm_config_offline: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    SOURCE_DATE_EPOCH: "1700000000",
    TZ: "UTC",
    LC_ALL: "C"
  };
}

for (const mode of ["baseline", "routed"]) {
  const directory = path.join(outputRoot, mode);
  const env = laneEnvironment(directory);
  if (mode === "routed") execute(process.execPath, [cli, "prepare", "--json"], directory, env, "routed:prepare");
  for (const [language, tool] of [["rust", "cargo"], ["node", "npm"], ["go", "go"]]) {
    const project = path.join(directory, "projects", language);
    const item = { mode, language, project, environment: env, status: "running" };
    report.cases.push(item);
    if (!tools[tool]) {
      item.status = "skipped";
      report.errors.push(`${mode}:${language}: ${tool} is not installed`);
      continue;
    }
    materialize(path.join(repository, "test", "lab", "fixtures", language), project);
    const run = (argv, cwd = project) => mode === "routed"
      ? execute(process.execPath, [cli, "run", "--", tool, ...argv], cwd, env, `${mode}:${language}`)
      : execute(tools[tool], argv, cwd, env, `${mode}:${language}`);
    try {
      console.log(`${mode}: ${language}`);
      item.version = run([tool === "go" ? "version" : "--version"]);
      if (language === "rust") {
        run(["test", "--workspace", "--offline"]);
        item.output = run(["run", "--offline", "--quiet", "--bin", "clean-lab"]);
        // Metadata is now inspection-only, not authority to route build output.
        // Inspect a real compiler-reported metadata file instead of its prediction.
        const compiled = run(["check", "--workspace", "--offline", "--message-format=json"]);
        const artifacts = compiled.split("\n").filter(Boolean).map(line => JSON.parse(line))
          .filter(entry => entry.reason === "compiler-artifact").flatMap(entry => entry.filenames);
        const metadataFile = artifacts.find(file => file.endsWith(".rmeta"));
        assert.ok(metadataFile && fs.statSync(metadataFile).size > 0, "Cargo reported no nonempty compiler metadata");
        const targetDirectory = path.dirname(path.dirname(path.dirname(metadataFile)));
        item.artifacts = { target: inventory(targetDirectory), compilerMetadata: inventory(metadataFile), localTarget: inventory(path.join(project, "target")) };
        check(`${mode}: Rust CLI output`, item.output === "total=12");
        check(`${mode}: Rust target contains compiled files`, item.artifacts.target.files > 0);
        check(`${mode}: Rust target location`, mode === "routed" ? within(path.join(env.CLEAN_DEVELOPMENT_ROOT, "builds"), targetDirectory) && !item.artifacts.localTarget.exists : targetDirectory === path.join(project, "target"));
      } else if (language === "node") {
        const packages = path.join(project, "packages");
        fs.mkdirSync(packages);
        run(["pack", "--offline", "--ignore-scripts", "--json", "--pack-destination", packages], path.join(project, "vendor", "clean-lab-math"));
        run(["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false"]);
        run(["test", "--silent"]);
        item.output = run(["start", "--silent"]);
        const cache = run(["config", "get", "cache"]);
        item.tarballSha256 = digest(path.join(packages, "clean-lab-math-1.0.0.tgz"));
        item.artifacts = { cache: inventory(cache), contentCache: inventory(path.join(cache, "_cacache")), nodeModules: inventory(path.join(project, "node_modules")), tarball: inventory(path.join(packages, "clean-lab-math-1.0.0.tgz")) };
        check(`${mode}: Node CLI output`, item.output === "total=12");
        check(`${mode}: npm content cache populated`, item.artifacts.contentCache.files > 0);
        check(`${mode}: node_modules remains project-local`, item.artifacts.nodeModules.files > 0);
        check(`${mode}: npm cache location`, mode === "routed" ? cache === path.join(env.CLEAN_DEVELOPMENT_ROOT, "caches", "node", "npm") : within(directory, cache));
      } else {
        run(["test", "./..."]);
        fs.mkdirSync(path.join(project, "bin"));
        const binary = path.join(project, "bin", "clean-lab");
        run(["build", "-o", binary, "./cmd/clean-lab"]);
        item.output = execute(binary, [], project, env, `${mode}:go:executable`);
        const locations = JSON.parse(run(["env", "-json", "GOCACHE", "GOMODCACHE"]));
        item.artifacts = { buildCache: inventory(locations.GOCACHE), moduleCache: inventory(locations.GOMODCACHE), binary: inventory(binary) };
        check(`${mode}: Go CLI output`, item.output === "total=12");
        check(`${mode}: Go build cache populated`, item.artifacts.buildCache.files > 0);
        check(`${mode}: Go cache locations`, mode === "routed" ? locations.GOCACHE === path.join(env.CLEAN_DEVELOPMENT_ROOT, "caches", "go", "build") && locations.GOMODCACHE === path.join(env.CLEAN_DEVELOPMENT_ROOT, "caches", "go", "modules") : within(directory, locations.GOCACHE) && within(directory, locations.GOMODCACHE));
      }
      item.status = "passed";
    } catch (error) {
      item.status = "failed";
      item.error = error.message;
      report.errors.push(`${mode}:${language}: ${error.message}`);
    }
    saveReport();
  }
}

const nodeCases = report.cases.filter((item) => item.language === "node" && item.status === "passed");
if (nodeCases.length === 2) {
  const matching = nodeCases[0].tarballSha256 === nodeCases[1].tarballSha256;
  report.checks.push({ name: "baseline/routed local npm tarballs match", pass: matching });
  if (!matching) report.errors.push("Local npm tarballs differ between baseline and routed cases");
}
report.completedAt = new Date().toISOString();
report.ok = report.errors.length === 0 && report.cases.every((item) => item.status === "passed");
saveReport();
console.log(`${report.cases.filter((item) => item.status === "passed").length}/6 cases passed. Evidence: ${reportFile}`);
process.exitCode = report.ok ? 0 : 1;
