import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { resolveConfig, writeUserConfig } from "../src/config.js";
import { DEFAULT_CONFIG } from "../src/constants.js";
import { environmentForTool } from "../src/adapters.js";
import { explainCommand, formatExplanation } from "../src/explain.js";
import { identifyWorkspace, detectStack } from "../src/workspace.js";
import { preflightToolRouting } from "../src/routing-context.js";
import { planSession } from "../src/session.js";
import { runTool } from "../src/runtime.js";
import { listWorkspaceRecords, prunePlan } from "../src/state.js";
import { inspectSwiftpmCommand, planSwiftpm, prepareSwiftpm } from "../src/swiftpm.js";

const cli = path.resolve("bin/clean-development.js");
const writeConfig = (directory, config) => fs.writeFileSync(path.join(directory, ".clean-development.json"), JSON.stringify({ schemaVersion: 1, ...config }));
function fixture(t, { enabled = true, retained = true } = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cd-swiftpm-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"), project = path.join(root, "source A"), bin = path.join(root, "bin");
  for (const directory of [home, project, bin]) fs.mkdirSync(directory);
  fs.writeFileSync(path.join(project, "Package.swift"), "// Never evaluate this manifest in a planning test.\n");
  const env = { HOME: home, USERPROFILE: home, CLEAN_DEVELOPMENT_HOME: home,
    CLEAN_DEVELOPMENT_DATA_HOME: path.join(root, "data"), CLEAN_DEVELOPMENT_CONFIG_HOME: path.join(root, "config"),
    PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}`, CLEAN_DEVELOPMENT_SESSION_MODE: "session-only" };
  for (const name of ["SystemRoot", "ComSpec", "PATHEXT", "WINDIR"]) if (process.env[name]) env[name] = process.env[name];
  const settings = { root: path.join(root, "disposable"), tools: { swift: enabled } };
  if (retained) settings.swiftpmWorkspaceRoot = path.join(root, "retained");
  writeConfig(project, settings);
  const config = resolveConfig({ cwd: project, env });
  const ready = () => {
    for (const key of ["root", "cacheRoot", "buildRoot", "scratchRoot", "swiftpmWorkspaceRoot"])
      if (config[key]) fs.mkdirSync(config[key], { recursive: true });
  };
  return { root, home, project, bin, env, config, settings, ready };
}
function snapshot(root) {
  const result = {};
  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, item.name);
    result[item.name] = item.isDirectory() ? snapshot(file) : item.isSymbolicLink() ? { link: fs.readlinkSync(file) }
      : { bytes: fs.readFileSync(file).toString("base64") };
  }
  return result;
}
function plan(item, args = ["build"], changes = {}) {
  return planSwiftpm(args, { config: item.config, env: item.env, cwd: item.project, ...changes });
}
function fakeSwift(item) {
  const capture = path.join(item.root, "capture.json"), script = path.join(item.bin, "capture.cjs");
  fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(capture)},JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),env:process.env}));process.exit(23);\n`);
  const command = path.join(item.bin, process.platform === "win32" ? "swift.cmd" : "swift");
  fs.writeFileSync(command, process.platform === "win32"
    ? `@echo off\r\nsetlocal DisableDelayedExpansion\r\n"${process.execPath}" "${script}" %*\r\nexit /b %errorlevel%\r\n`
    : `#!${process.execPath}\nrequire(${JSON.stringify(script)});\n`, { mode: 0o755 });
  return capture;
}
function directoryLink(target, name, t) {
  try { fs.symlinkSync(target, name, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (process.platform === "win32" && error.code === "EPERM") { t.skip("directory-link privilege unavailable"); return false; } throw error; }
  return true;
}

test("SwiftPM is disabled by default; path configuration does not grant opt-in", (t) => {
  const item = fixture(t, { enabled: false });
  assert.equal(DEFAULT_CONFIG.tools.swift, false);
  assert.deepEqual(plan(item).additions, []);
  const before = snapshot(item.root);
  assert.equal(explainCommand("swift", ["build"], { cwd: item.project, env: item.env }).routing.status, "disabled");
  const session = planSession({ config: item.config, cwd: item.project, env: item.env });
  assert.equal(session.managed.environment.SWIFTPM_BUILD_DIR, undefined);
  assert.deepEqual(environmentForTool("swift", [], { config: item.config, env: item.env, cwd: item.project }).env, item.env);
  assert.deepEqual(snapshot(item.root), before);
});

test("opt-in without a retained root changes only cache selection", (t) => {
  const item = fixture(t, { retained: false }), before = snapshot(item.root), result = plan(item);
  assert.deepEqual(result.additions, ["--cache-path", path.join(item.config.cacheRoot, "swiftpm")]);
  assert.equal(result.scratch.path, null);
  assert.deepEqual(snapshot(item.root), before);
});

test("retained-root precedence is independent of disposable-root precedence", async (t) => {
  for (let mask = 0; mask < 16; mask++) await t.test(`layers ${mask}`, (t) => {
    const item = fixture(t, { retained: false });
    const paths = ["user-retained", "project-retained", "environment-retained", "command-retained"].map((s) => path.join(item.root, s));
    const user = { ...item.config, swiftpmWorkspaceRoot: paths[0] };
    if (mask & 1) writeUserConfig(user, item.env);
    if (mask & 2) writeConfig(item.project, { ...item.settings, swiftpmWorkspaceRoot: paths[1] });
    const env = { ...item.env, ...(mask & 4 ? { CLEAN_DEVELOPMENT_SWIFTPM_WORKSPACE_ROOT: paths[2] } : {}) };
    const overrides = mask & 8 ? { swiftpmWorkspaceRoot: paths[3] } : {};
    const before = snapshot(item.root), config = resolveConfig({ cwd: item.project, env, overrides });
    const winner = mask & 8 ? 3 : mask & 4 ? 2 : mask & 2 ? 1 : mask & 1 ? 0 : -1;
    assert.equal(config.swiftpmWorkspaceRoot, paths[winner]);
    if (winner >= 0) assert.equal(config.pathSources.swiftpmWorkspaceRoot,
      [config.locations.configPath, path.join(item.project, ".clean-development.json"), "environment: CLEAN_DEVELOPMENT_SWIFTPM_WORKSPACE_ROOT", "command line"][winner]);
    assert.equal(config.root, item.config.root);
    assert.deepEqual(snapshot(item.root), before);
  });
});

test("nested packages, sibling checkouts and canonical aliases have appropriate identities", (t) => {
  const item = fixture(t), nested = path.join(item.project, "nested"), second = path.join(item.root, "second", "source A");
  for (const directory of [nested, second]) { fs.mkdirSync(path.join(directory, "src"), { recursive: true }); fs.writeFileSync(path.join(directory, "Package.swift"), "// manifest\n"); }
  const a = identifyWorkspace("swift", ["build"], item.project);
  const n = identifyWorkspace("swift", ["test"], path.join(nested, "src"));
  const b = identifyWorkspace("swift", ["build", "--package-path", path.relative(item.project, second)], item.project);
  assert.equal(n.root, nested); assert.equal(b.root, second);
  assert.equal(new Set([a.id, n.id, b.id]).size, 3);
  const alias = path.join(item.root, "nested-alias");
  if (!directoryLink(path.join(nested, "src"), alias, t)) return;
  assert.equal(identifyWorkspace("swift", ["build"], alias).id, n.id);
  writeConfig(nested, { ...item.settings, tools: { swift: false } });
  assert.equal(preflightToolRouting("swift", ["build", "--package-path", alias], { config: item.config, cwd: item.project, env: item.env }).disabled, true);
  assert.ok(detectStack(nested, { home: item.home }).tools.includes("swift"));
});

test("native scratch/cache controls are preserved even under force", async (t) => {
  const cases = [
    { args: ["--scratch-path", "relative"] }, { args: ["--scratch-path=with = spaces"] },
    { args: ["--build-path", "legacy"] }, { env: { SWIFTPM_BUILD_DIR: "native-env" } },
    { env: { SWIFTPM_BUILD_DIR: "" } }, { env: { swiftpm_build_dir: "case-variant" } },
    { args: ["--scratch-path", "s", "--cache-path", "c"], cache: true },
    { env: { SWIFTPM_BUILD_DIR: "e", SWIFTPM_CACHE_PATH: "caller-config" }, cache: true }
  ];
  for (const [index, variant] of cases.entries()) await t.test(String(index), (t) => {
    const item = fixture(t), env = Object.freeze({ ...item.env, ...variant.env, CLEAN_DEVELOPMENT_FORCE: "1" });
    const args = Object.freeze(["build", ...(variant.args || [])]);
    const before = snapshot(item.root), result = plan(item, args, { env });
    assert.equal(result.scratch.path, null);
    assert.equal(result.additions.includes("--scratch-path"), false);
    assert.equal(result.additions.includes("--cache-path"), !variant.cache);
    assert.deepEqual(snapshot(item.root), before);
  });
});

test("configuration, security, SDK, module-cache and output controls remain user-owned", (t) => {
  const item = fixture(t), env = Object.freeze({ ...item.env, CLANG_MODULE_CACHE_PATH: "clang", SWIFT_MODULECACHE_PATH: "swift",
    SWIFTPM_BUILD_SBOM_OUTPUT_DIR: "sbom-env", TOKEN_SENTINEL: "do-not-record" });
  const args = Object.freeze(["test", "--package-path=.", "--config-path", "config-native", "--security-path", "security-native",
    "--swift-sdks-path", "sdk-native", "--xunit-output", "report.xml", "--attachments-path", "attachments",
    "-Xswiftc", "--cache-path", "-Xcc", "--package-path", "--filter", "SomeTest"]);
  const before = snapshot(item.root), result = plan(item, args, { env });
  assert.equal(result.workspace.root, item.project);
  assert.deepEqual(result.outputs.map((i) => i.path), ["report.xml", "attachments"]);
  assert.equal(JSON.stringify(result).includes("do-not-record"), false);
  const sbom = plan(item, ["build", "--sbom-spec", "spdx", "--sbom-output-dir", "release-sbom", "--sbom-warning-only"]);
  assert.equal(sbom.outputs[0].path, "release-sbom");
  assert.deepEqual(snapshot(item.root), before);
});

test("unknown or ambiguous build/test syntax fails before writes or child execution", async (t) => {
  const cases = [["build", "--package-path"], ["build", "--package-path", ".", "--package-path=other"],
    ["build", "--scratch-path="], ["test", "--multiroot-data-file", "workspace"], ["build", "@response"],
    ["test", "--", "--package-path", "other"], ["build", "--future-option", "value"], ["test", "list"],
    ["build", ...Array(513).fill("-v")], ["build", "--package-path", "missing"]];
  for (const [index, args] of cases.entries()) await t.test(String(index), async (t) => {
    const item = fixture(t), capture = fakeSwift(item), before = snapshot(item.root);
    await assert.rejects(runTool("swift", args, { config: item.config, cwd: item.project, env: item.env }));
    assert.equal(fs.existsSync(capture), false);
    assert.deepEqual(snapshot(item.root), before);
    assert.equal(explainCommand("swift", args, { cwd: item.project, env: item.env }).routing.status, "blocked");
  });
  assert.throws(() => inspectSwiftpmCommand(["build", "bad\0value"]), /NUL/);
});

test("all relocated scratch roots must be disjoint from source and disposable/storage metadata", async (t) => {
  for (const key of ["root", "cacheRoot", "buildRoot", "scratchRoot", "project", "dataDir", "configDir"]) await t.test(key, (t) => {
    const item = fixture(t), target = key === "project" ? item.project : item.config[key] || item.config.locations[key], before = snapshot(item.root);
    for (const root of [target, path.join(target, "retained")]) assert.throws(() => plan(item, ["build"], { config: { ...item.config, swiftpmWorkspaceRoot: root } }), /disjoint/);
    assert.deepEqual(snapshot(item.root), before);
  });
});

test("retained roots cannot hide in caller source, historical Cargo output or directory aliases", (t) => {
  const item = fixture(t), b = path.join(item.root, "target"), sub = path.join(item.project, "src");
  fs.mkdirSync(b); fs.mkdirSync(sub); fs.writeFileSync(path.join(b, "Package.swift"), "// target\n");
  writeConfig(b, { ...item.settings, swiftpmWorkspaceRoot: path.join(item.project, "retained") });
  assert.throws(() => preflightToolRouting("swift", ["build", "--package-path", b], { config: item.config, cwd: sub, env: item.env }), /disjoint/);
  const historic = path.join(item.root, "historic"); fs.mkdirSync(historic);
  fs.writeFileSync(path.join(historic, ".clean-development-owned.json"), "{}");
  assert.throws(() => plan(item, ["build"], { config: { ...item.config, swiftpmWorkspaceRoot: path.join(historic, "retained") } }), /owned Cargo/);
  const alias = path.join(item.root, "source-link");
  if (!directoryLink(item.project, alias, t)) return;
  assert.throws(() => plan(item, ["build"], { config: { ...item.config, swiftpmWorkspaceRoot: path.join(alias, "retained") } }), /disjoint/);
});

test("unavailable bases never get recreated by dispatch; a prepared cache does not mask a missing volume", (t) => {
  const item = fixture(t), before = snapshot(item.root);
  assert.throws(() => prepareSwiftpm(plan(item)), { code: "ENOENT" });
  assert.deepEqual(snapshot(item.root), before);
  fs.mkdirSync(item.config.cacheRoot, { recursive: true });
  const cached = snapshot(item.root);
  assert.throws(() => prepareSwiftpm(plan(item)), { code: "ENOENT" });
  assert.deepEqual(snapshot(item.root), cached);
});

test("retained workspace creation is idempotent but never adopts an unmarked directory", (t) => {
  const item = fixture(t); item.ready(); const result = plan(item), parent = path.dirname(result.scratch.path);
  fs.mkdirSync(parent); fs.writeFileSync(path.join(parent, "keep"), "unrelated");
  const before = snapshot(item.root);
  assert.throws(() => prepareSwiftpm(result)); assert.deepEqual(snapshot(item.root), before);
  fs.rmSync(parent, { recursive: true }); // fixture reset only
  prepareSwiftpm(result); const ready = snapshot(item.root); prepareSwiftpm(result);
  assert.deepEqual(snapshot(item.root), ready);
  assert.deepEqual(listWorkspaceRecords(item.config), []);
  assert.deepEqual(prunePlan(item.config), []);
  assert.equal(fs.existsSync(item.config.locations.stateDir), false);
});

test("changed, oversized or linked retained markers fail closed without repair", async (t) => {
  for (const kind of ["wrong-package", "oversized", "symlink", "directory"]) await t.test(kind, (t) => {
    const item = fixture(t); item.ready(); const result = plan(item); prepareSwiftpm(result);
    const file = path.join(path.dirname(result.scratch.path), ".clean-development-swiftpm.json");
    if (kind === "wrong-package") { const value = JSON.parse(fs.readFileSync(file)); value.packageRoot += "other"; fs.writeFileSync(file, JSON.stringify(value)); }
    if (kind === "oversized") fs.writeFileSync(file, " ".repeat(8193));
    if (kind === "directory") { fs.unlinkSync(file); fs.mkdirSync(file); }
    if (kind === "symlink") {
      const target = `${file}.original`; fs.renameSync(file, target);
      try { fs.symlinkSync(target, file); } catch (error) { if (process.platform === "win32" && error.code === "EPERM") { t.skip("file symlink unavailable"); return; } throw error; }
    }
    const before = snapshot(item.root); assert.throws(() => prepareSwiftpm(result)); assert.deepEqual(snapshot(item.root), before);
  });
});

test("owned scratch child and cache child cannot be replaced by symlinks", (t) => {
  const item = fixture(t); item.ready(); const result = plan(item); prepareSwiftpm(result);
  const outside = path.join(item.root, "outside"); fs.mkdirSync(outside);
  fs.rmdirSync(result.scratch.path);
  if (!directoryLink(outside, result.scratch.path, t)) return;
  const before = snapshot(item.root); assert.throws(() => prepareSwiftpm(result)); assert.deepEqual(snapshot(item.root), before);
});

test("dispatch inserts only documented flags and preserves exact argv/cwd/env/status", async (t) => {
  const item = fixture(t); item.ready(); const capture = fakeSwift(item);
  const env = Object.freeze({ ...item.env, SWIFTPM_BUILD_SBOM_OUTPUT_DIR: "explicit-sbom", CLANG_MODULE_CACHE_PATH: "external", SENTINEL: "secret" });
  const args = Object.freeze(["test", "--package-path", ".", "--xunit-output", "test report.xml", "-Xswiftc", "-DKEEP"]);
  const preview = plan(item, args, { env });
  assert.equal(await runTool("swift", args, { config: item.config, env, cwd: item.project }), 23);
  const actual = JSON.parse(fs.readFileSync(capture));
  assert.deepEqual(actual.args, [args[0], ...preview.additions, ...args.slice(1)]);
  assert.equal(actual.cwd, item.project);
  for (const [key, value] of Object.entries(env)) assert.equal(actual.env[key], value);
  assert.equal(actual.env.SWIFTPM_BUILD_DIR, undefined);
  assert.deepEqual(prunePlan(item.config), []);
});

test("archive/plugin/compiler/help invocations pass unchanged without creating storage", async (t) => {
  for (const args of [["package", "archive-source", "--output", "release.zip"], ["package", "plugin", "custom"],
    ["run", "tool", "--package-path", "application-arg"], ["-emit-executable", "source.swift", "-o", "final"],
    ["build", "--help"], ["--version"]]) await t.test(args.join(" "), async (t) => {
    const item = fixture(t), capture = fakeSwift(item);
    assert.equal(await runTool("swift", args, { config: item.config, env: item.env, cwd: item.project }), 23);
    assert.deepEqual(JSON.parse(fs.readFileSync(capture)).args, args);
    assert.equal(fs.existsSync(item.config.root), false);
    assert.equal(fs.existsSync(item.config.swiftpmWorkspaceRoot), false);
    const native = spawnSync(process.execPath, [cli, "run", "--", "swift", ...args], { cwd: item.project, env: item.env, encoding: "utf8", timeout: 10000 });
    assert.equal(native.status, 23, native.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(capture)).args, args);
    assert.equal(fs.existsSync(item.config.root), false);
    assert.equal(fs.existsSync(item.config.locations.runtimeDir), false);
  });
});

test("disabled target and skip never receive path injection or persistence authority", async (t) => {
  const item = fixture(t), capture = fakeSwift(item), b = path.join(item.root, "disabled"); fs.mkdirSync(b);
  fs.writeFileSync(path.join(b, "Package.swift"), "// disabled\n"); writeConfig(b, { ...item.settings, tools: { swift: false } });
  const args = ["build", "--package-path", b];
  assert.equal(await runTool("swift", args, { config: item.config, env: item.env, cwd: item.project }), 23);
  assert.deepEqual(JSON.parse(fs.readFileSync(capture)).args, args);
  fs.writeFileSync(path.join(item.project, ".clean-development.json"), "malformed");
  const env = { ...item.env, SWIFTPM_BUILD_DIR: "user-native" };
  const child = spawnSync(process.execPath, [cli, "run", "--session", "skip", "--", "swift", ...args], { env, cwd: item.project, encoding: "utf8", timeout: 10000 });
  assert.equal(child.status, 23, child.stderr);
  assert.equal(JSON.parse(fs.readFileSync(capture)).env.SWIFTPM_BUILD_DIR, "user-native");
  assert.equal(fs.existsSync(item.config.root), false);
  assert.equal(fs.existsSync(item.config.locations.runtimeDir), false);
});

test("explanations distinguish retained mixed output and user deliverables without running Swift", (t) => {
  const item = fixture(t), capture = fakeSwift(item), before = snapshot(item.root);
  const report = explainCommand("swift", ["test", "--xunit-output", "qa\nreport.xml"], { cwd: item.project, env: item.env });
  assert.equal(report.routing.status, "predicted");
  assert.equal(report.routing.swiftpm.scratch.path, plan(item).scratch.path);
  assert.deepEqual(report.routing.variables, []);
  assert.match(formatExplanation(report), /never pruned/);
  assert.equal(formatExplanation(report).includes("qa\nreport"), false);
  assert.equal(fs.existsSync(capture), false); assert.deepEqual(snapshot(item.root), before);
});

test("malformed retained-root configuration never silently derives disposable storage", (t) => {
  const item = fixture(t);
  for (const value of ["", "relative", 42, false, [], {}]) {
    writeConfig(item.project, { ...item.settings, swiftpmWorkspaceRoot: value });
    assert.throws(() => resolveConfig({ cwd: item.project, env: item.env }));
  }
  writeConfig(item.project, item.settings);
  for (const value of ["", "relative"]) assert.throws(() => resolveConfig({ cwd: item.project,
    env: { ...item.env, CLEAN_DEVELOPMENT_SWIFTPM_WORKSPACE_ROOT: value } }));
  assert.equal(fs.existsSync(item.config.root), false);
});

test("Swift cache children and missing retained parents fail closed without touching their referents", (t) => {
  const item = fixture(t); item.ready(); const result = plan(item); prepareSwiftpm(result);
  const outside = path.join(item.root, "external-cache"); fs.mkdirSync(outside);
  fs.rmdirSync(result.cache.path);
  if (!directoryLink(outside, result.cache.path, t)) return;
  const before = snapshot(item.root); assert.throws(() => prepareSwiftpm(result)); assert.deepEqual(snapshot(item.root), before);
});

test("retained storage below home remains valid when the caller is home, not a project", (t) => {
  const item = fixture(t), retained = path.join(item.home, "Retained");
  writeConfig(item.project, { ...item.settings, swiftpmWorkspaceRoot: retained });
  const config = resolveConfig({ cwd: item.project, env: item.env });
  const result = preflightToolRouting("swift", ["build", "--package-path", item.project], { config, cwd: item.home, env: item.env });
  assert.equal(result.disabled, false); assert.equal(result.swiftpm.scratch.base, retained);
});

test("CLI detects invalid retained roots before applying persistence or executing a tool", (t) => {
  const item = fixture(t), capture = fakeSwift(item);
  writeConfig(item.project, { ...item.settings, swiftpmWorkspaceRoot: path.join(item.project, "products") });
  const before = snapshot(item.root);
  const child = spawnSync(process.execPath, [cli, "run", "--session", "persist", "--", "swift", "build"], { cwd: item.project, env: item.env, encoding: "utf8", timeout: 10000 });
  assert.notEqual(child.status, 0); assert.match(child.stderr, /disjoint/);
  assert.equal(fs.existsSync(capture), false); assert.deepEqual(snapshot(item.root), before);
});

test("installed-style nested Swift commands select their own package without inherited Swift paths", async (t) => {
  const item = fixture(t); item.ready(); const capture = fakeSwift(item);
  const second = path.join(item.root, "second"); fs.mkdirSync(second); fs.writeFileSync(path.join(second, "Package.swift"), "// second\n");
  writeConfig(second, item.settings);
  const args = ["build", "--package-path", second];
  const inherited = { ...item.env, CLEAN_DEVELOPMENT_ACTIVE: "1", CLEAN_DEVELOPMENT_WORKSPACE: item.project };
  const expected = preflightToolRouting("swift", args, { config: item.config, env: inherited, cwd: item.project }).swiftpm;
  assert.equal(await runTool("swift", args, { config: item.config, env: inherited, cwd: item.project }), 23);
  const actual = JSON.parse(fs.readFileSync(capture));
  assert.ok(actual.args.includes(expected.scratch.path));
  assert.notEqual(expected.scratch.path, plan(item).scratch.path);
  assert.equal(actual.env.SWIFTPM_BUILD_DIR, undefined);
});

test("an ordinary persistence proposal cannot implicitly enable SwiftPM", (t) => {
  const item = fixture(t, { enabled: false });
  fs.unlinkSync(path.join(item.project, ".clean-development.json"));
  const config = resolveConfig({ cwd: item.project, env: item.env });
  const proposal = planSession({ config, cwd: item.project, env: item.env });
  assert.equal(proposal.projectConfig.proposed.tools.swift, undefined);
  assert.deepEqual(proposal.managed.environment, {});
});

test("a globally disabled starting project passes through without reading a broken target config", async (t) => {
  const item = fixture(t), capture = fakeSwift(item), target = path.join(item.root, "target"); fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, ".clean-development.json"), "invalid");
  const args = ["build", "--package-path", target];
  assert.equal(await runTool("swift", args, { config: { ...item.config, enabled: false }, env: item.env, cwd: item.project }), 23);
  assert.deepEqual(JSON.parse(fs.readFileSync(capture)).args, args);
  assert.equal(fs.existsSync(item.config.root), false);
});
