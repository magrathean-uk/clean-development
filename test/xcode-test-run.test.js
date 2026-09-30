import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

const cli = path.resolve("bin/clean-development.js");
const DEVICE_ID = "11111111-2222-4333-8444-555555555555";
const FOREIGN_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const PERSONAL_ID = "99999999-8888-4777-8666-555555555555";
const DEVICE_TYPE = "com.apple.CoreSimulator.SimDeviceType.iPhone-Test";
const RUNTIME = "com.apple.CoreSimulator.SimRuntime.iOS-Test-1";

const XCRUN = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const fixture = process.env.FAKE_SIMCTL_DIR;
fs.appendFileSync(path.join(fixture, "calls.jsonl"), JSON.stringify(args) + "\\n");
if (args[0] !== "simctl") process.exit(2);
let index = 1, deviceSet = null;
if (args[index] === "--set") { deviceSet = args[index + 1]; index += 2; }
const command = args[index++];
const rest = args.slice(index);
const stateFile = path.join(fixture, "state.json");
const load = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
const save = (state) => fs.writeFileSync(stateFile, JSON.stringify(state));
if (command === "list" && rest[0] === "devicetypes") {
  console.log(JSON.stringify({ devicetypes: [{ identifier: ${JSON.stringify(DEVICE_TYPE)}, name: "iPhone Test" }] }));
} else if (command === "list" && rest[0] === "runtimes") {
  console.log(JSON.stringify({ runtimes: [{ identifier: ${JSON.stringify(RUNTIME)}, isAvailable: true,
    supportedDeviceTypes: [{ identifier: ${JSON.stringify(DEVICE_TYPE)} }] }] }));
} else if (command === "list" && rest[0] === "devices") {
  if (process.env.FAKE_DEVICE_LIST_PATH && fs.existsSync(process.env.FAKE_DEVICE_LIST_PATH)) {
    process.stdout.write(fs.readFileSync(process.env.FAKE_DEVICE_LIST_PATH, "utf8"));
    process.exit(0);
  }
  const state = load();
  const devices = state.devices.filter((device) => device.deviceSet === deviceSet);
  if (process.env.FAKE_ADD_EXTRA_PATH && fs.existsSync(process.env.FAKE_ADD_EXTRA_PATH)
    && !devices.some((device) => device.udid === ${JSON.stringify(FOREIGN_ID)})) {
    devices.push({ udid: ${JSON.stringify(FOREIGN_ID)}, name: "Foreign simulator", isAvailable: true,
      state: "Shutdown", deviceTypeIdentifier: ${JSON.stringify(DEVICE_TYPE)}, runtime: ${JSON.stringify(RUNTIME)},
      dataPath: path.join(deviceSet, ${JSON.stringify(FOREIGN_ID)}, "data"), deviceSet });
  }
  const grouped = {};
  for (const device of devices) (grouped[device.runtime] ||= []).push({
    udid: device.udid, name: device.name, isAvailable: device.isAvailable, state: device.state,
    deviceTypeIdentifier: device.deviceTypeIdentifier, dataPath: device.dataPath
  });
  console.log(JSON.stringify({ devices: grouped }));
} else if (command === "create") {
  if (!deviceSet || rest.length !== 3) process.exit(2);
  const [name, type, runtime] = rest;
  const udid = process.env.FAKE_CREATE_ID || ${JSON.stringify(DEVICE_ID)};
  const state = load();
  if (!state.devices.some((device) => device.udid === udid && device.deviceSet === deviceSet)) {
    const dataPath = path.join(deviceSet, udid, "data");
    fs.mkdirSync(dataPath, { recursive: true });
    state.devices.push({ udid, name, deviceTypeIdentifier: type, runtime,
      state: "Shutdown", isAvailable: true, dataPath, deviceSet });
    save(state);
  }
  console.log(udid);
  if (process.env.FAKE_INTERRUPT_DURING_CREATE === "1") process.kill(process.ppid, "SIGINT");
} else if (command === "shutdown" && rest.length === 1) {
  const state = load();
  const device = state.devices.find((entry) => entry.udid === rest[0] && entry.deviceSet === deviceSet);
  if (!device) process.exit(1);
  device.state = "Shutdown"; save(state);
} else if (command === "delete" && rest.length === 1) {
  if (process.env.FAKE_DELETE_FAIL_PATH && fs.existsSync(process.env.FAKE_DELETE_FAIL_PATH)) process.exit(1);
  const state = load();
  const device = state.devices.find((entry) => entry.udid === rest[0] && entry.deviceSet === deviceSet);
  if (!device) process.exit(1);
  state.devices = state.devices.filter((entry) => entry !== device);
  save(state);
  fs.rmSync(path.dirname(device.dataPath), { recursive: true, force: true });
} else process.exit(2);
`;

const PGREP = `#!/usr/bin/env node
import fs from "node:fs";
const [flag, name] = process.argv.slice(2);
if (flag !== "-x") process.exit(2);
process.exit(fs.existsSync(process.env.FAKE_RUNNING_DIR + "/" + name) ? 0 : 1);
`;

function executable(file, source) {
  fs.writeFileSync(file, source, { mode: 0o755 });
}

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "clean-development-xcode-test-run-")));
  const home = path.join(root, "home");
  const data = path.join(root, "data");
  const configHome = path.join(root, "config");
  const managed = path.join(root, "managed");
  const bin = path.join(root, "fake-bin");
  const fake = path.join(root, "fake-simctl");
  const running = path.join(root, "running");
  const project = path.join(root, "project");
  const devices = path.join(home, "Library", "Developer", "CoreSimulator", "Devices");
  for (const directory of [home, data, configHome, managed, bin, fake, running, project, devices]) fs.mkdirSync(directory, { recursive: true });
  executable(path.join(bin, "xcrun"), XCRUN);
  executable(path.join(bin, "pgrep"), PGREP);
  const state = path.join(fake, "state.json");
  const personalData = path.join(devices, PERSONAL_ID, "data");
  fs.mkdirSync(personalData, { recursive: true });
  fs.writeFileSync(state, JSON.stringify({ devices: [{ udid: PERSONAL_ID, name: "Personal iPhone", deviceTypeIdentifier: DEVICE_TYPE,
    runtime: RUNTIME, state: "Shutdown", isAvailable: true, dataPath: personalData, deviceSet: devices }] }));
  const env = {
    HOME: home,
    PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    CLEAN_DEVELOPMENT_HOME: home,
    CLEAN_DEVELOPMENT_DATA_HOME: data,
    CLEAN_DEVELOPMENT_CONFIG_HOME: configHome,
    CLEAN_DEVELOPMENT_ROOT: managed,
    FAKE_SIMCTL_DIR: fake,
    FAKE_RUNNING_DIR: running,
    FAKE_DELETE_FAIL_PATH: path.join(fake, "delete-fail"),
    FAKE_ADD_EXTRA_PATH: path.join(fake, "add-extra"),
    FAKE_DEVICE_LIST_PATH: path.join(fake, "device-list-override.json"),
    CAPTURE_PATH: path.join(root, "capture.json")
  };
  const result = (args, extraEnv = {}) => spawnSync(process.execPath, [cli, ...args], {
    cwd: project, env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 15_000
  });
  const calls = () => fs.existsSync(path.join(fake, "calls.jsonl"))
    ? fs.readFileSync(path.join(fake, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  const devicesNow = () => JSON.parse(fs.readFileSync(state, "utf8")).devices;
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, home, data, managed, bin, fake, running, project, devices, env, result, calls, devicesNow, state };
}

function runArgs(item, command = "node", args = [], session = "session-only") {
  return ["xcode", "test-run", "--session", session, "--device-type", DEVICE_TYPE,
    "--runtime", RUNTIME, "--", command, ...args];
}

function childScript(extra = "") {
  return `
import fs from "node:fs";
  fs.writeFileSync(process.env.CAPTURE_PATH, JSON.stringify({
  argv: process.argv.slice(2), cwd: process.cwd(), udid: process.env.CLEAN_DEVELOPMENT_XCODE_SIMULATOR_UDID,
  deviceType: process.env.CLEAN_DEVELOPMENT_XCODE_DEVICE_TYPE, runtime: process.env.CLEAN_DEVELOPMENT_XCODE_RUNTIME,
  runId: process.env.CLEAN_DEVELOPMENT_XCODE_TEST_RUN_ID, results: process.env.CLEAN_DEVELOPMENT_XCODE_RESULTS_PATH,
  mode: process.env.CLEAN_DEVELOPMENT_SESSION_MODE, pid: process.pid
}));
${extra}
process.stdout.write("test stdout\\n"); process.stderr.write("test stderr\\n"); process.exitCode = Number(process.env.TEST_EXIT || 0);
`;
}

function writeChild(item, source = childScript()) {
  const file = path.join(item.root, "test-child.mjs");
  fs.writeFileSync(file, source);
  return file;
}

function testRunRecord(item, runId) {
  const record = path.join(item.managed, "xcode", "test-run-records", `${runId}.json`);
  assert.equal(fs.existsSync(record), true, "run receipt retained outside simulator storage");
  return JSON.parse(fs.readFileSync(record, "utf8"));
}

const macOnly = { skip: process.platform !== "darwin" ? "Xcode simulator tests require macOS" : false };

function buildTool(item, name) {
  const capture = path.join(item.root, `${name}.json`);
  executable(path.join(item.bin, name), `#!${process.execPath}
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({
  argv: process.argv.slice(2), cwd: process.cwd(), pid: process.pid,
  target: process.env.CARGO_TARGET_DIR, udid: process.env.CLEAN_DEVELOPMENT_XCODE_SIMULATOR_UDID,
  mode: process.env.CLEAN_DEVELOPMENT_SESSION_MODE
}));
process.exitCode = Number(process.env.TEST_EXIT || 0);
`);
  return capture;
}

test("xcode test-run routes a direct Cargo command and records the real tool PID", macOnly, (t) => {
  const item = fixture(t);
  fs.writeFileSync(path.join(item.project, "Cargo.toml"), "[package]\nname='test-fixture'\nversion='0.1.0'\n");
  const toolCapture = buildTool(item, "cargo");
  const result = item.result(runArgs(item, "cargo", ["check"]), { TEST_EXIT: "37" });
  assert.equal(result.status, 37, result.stderr);
  const observed = JSON.parse(fs.readFileSync(toolCapture, "utf8"));
  assert.deepEqual(observed.argv, ["check"]);
  assert.equal(observed.cwd, item.project);
  assert.match(observed.target, /managed[/\\]builds[/\\]project-[a-f0-9]{10}[/\\]cargo[/\\]target$/);
  assert.equal(observed.udid, DEVICE_ID);
  const records = fs.readdirSync(path.join(item.managed, "xcode", "test-run-records"));
  assert.equal(records.length, 1);
  const record = testRunRecord(item, records[0].slice(0, -5));
  assert.equal(record.childPid, observed.pid);
  assert.equal(record.childExitCode, 37);
  assert.equal(record.cleanup.status, "removed");
});

for (const mode of ["session-only", "skip"]) {
  test(`xcode test-run ${mode} applies its routing choice to nested Cargo`, macOnly, (t) => {
    const item = fixture(t);
    fs.writeFileSync(path.join(item.project, "Cargo.toml"), "[package]\nname='test-fixture'\nversion='0.1.0'\n");
    const toolCapture = buildTool(item, "cargo");
    const child = writeChild(item, childScript(`
const { spawnSync } = await import("node:child_process");
const built = spawnSync("cargo", ["check"], { env: process.env, stdio: "inherit" });
if (built.status !== 0) throw new Error("Nested build failed");
`));
    const result = item.result(runArgs(item, process.execPath, [child], mode));
    assert.equal(result.status, 0, result.stderr);
    const observed = JSON.parse(fs.readFileSync(toolCapture, "utf8"));
    assert.deepEqual(observed.argv, ["check"]);
    assert.equal(observed.mode, mode);
    assert.equal(observed.udid, DEVICE_ID);
    if (mode === "session-only") assert.match(observed.target, /managed[/\\]builds[/\\]project-[a-f0-9]{10}[/\\]cargo[/\\]target$/);
    else {
      assert.equal(observed.target, undefined);
      assert.equal(fs.existsSync(path.join(item.data, "state", "runtime.json")), false);
      assert.equal(fs.existsSync(path.join(item.managed, "builds")), false);
    }
    const capture = JSON.parse(fs.readFileSync(item.env.CAPTURE_PATH, "utf8"));
    assert.equal(testRunRecord(item, capture.runId).childPid, capture.pid);
  });
}

test("xcode test-run makes opt-in SwiftPM flags available to nested build commands", macOnly, (t) => {
  const item = fixture(t);
  fs.writeFileSync(path.join(item.project, "Package.swift"), "// fixture; never evaluated\n");
  fs.writeFileSync(path.join(item.project, ".clean-development.json"), JSON.stringify({ schemaVersion: 1, tools: { swift: true } }));
  const toolCapture = buildTool(item, "swift");
  const child = writeChild(item, childScript(`
const { spawnSync } = await import("node:child_process");
const built = spawnSync("swift", ["build"], { env: process.env, stdio: "inherit" });
if (built.status !== 0) throw new Error("Nested build failed");
`));
  const result = item.result(runArgs(item, process.execPath, [child]));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(toolCapture, "utf8")).argv,
    ["build", "--cache-path", path.join(item.managed, "caches", "swiftpm")]);
});

test("xcode test-run preserves independent Cargo overrides and child command arguments", macOnly, (t) => {
  const item = fixture(t);
  fs.writeFileSync(path.join(item.project, "Cargo.toml"), "[package]\nname='test-fixture'\nversion='0.1.0'\n");
  const toolCapture = buildTool(item, "cargo");
  const target = path.join(item.root, "user-products");
  const result = item.result(runArgs(item, "cargo", ["check"]), { CARGO_TARGET_DIR: target });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(toolCapture, "utf8")).target, target);
  const commandCapture = buildTool(item, "codex");
  const argv = ["exec", "literal prompt", "--", "kept"];
  const codex = item.result(runArgs(item, "codex", argv));
  assert.equal(codex.status, 0, codex.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(commandCapture, "utf8")).argv, argv);
});

test("xcode test-run respects disabled project routing while retaining its requested simulator lifecycle", macOnly, (t) => {
  const item = fixture(t);
  fs.writeFileSync(path.join(item.project, "package.json"), "{}\n");
  fs.writeFileSync(path.join(item.project, ".clean-development.json"), JSON.stringify({ schemaVersion: 1, enabled: false }));
  const child = writeChild(item, childScript(`
if (process.env.npm_config_cache !== undefined) throw new Error("Disabled project inherited managed cache");
`));
  const result = item.result(runArgs(item, process.execPath, [child]));
  assert.equal(result.status, 0, result.stderr);
  const capture = JSON.parse(fs.readFileSync(item.env.CAPTURE_PATH, "utf8"));
  assert.equal(capture.mode, "skip");
  assert.equal(fs.existsSync(path.join(item.managed, "caches")), false);
  assert.equal(testRunRecord(item, capture.runId).cleanup.status, "removed");
});

test("xcode test-run uses project cache selection without relocating user-level simulator receipts", macOnly, (t) => {
  const item = fixture(t);
  const cacheRoot = path.join(item.root, "project-cache");
  fs.writeFileSync(path.join(item.project, "package.json"), "{}\n");
  fs.writeFileSync(path.join(item.project, ".clean-development.json"), JSON.stringify({ schemaVersion: 1, cacheRoot }));
  const child = writeChild(item, childScript(`
if (process.env.npm_config_cache !== ${JSON.stringify(path.join(cacheRoot, "node", "npm"))}) throw new Error("Project cache was ignored");
`));
  const result = item.result(runArgs(item, process.execPath, [child]));
  assert.equal(result.status, 0, result.stderr);
  const capture = JSON.parse(fs.readFileSync(item.env.CAPTURE_PATH, "utf8"));
  assert.equal(testRunRecord(item, capture.runId).cleanup.status, "removed");
  assert.equal(fs.existsSync(path.join(cacheRoot, "xcode")), false);
});

test("xcode test-run rejects unsafe direct-tool target storage before provisioning a simulator", macOnly, (t) => {
  const item = fixture(t);
  const selected = path.join(item.root, "selected-project");
  fs.mkdirSync(selected);
  fs.writeFileSync(path.join(selected, "package.json"), "{}\n");
  fs.writeFileSync(path.join(selected, ".clean-development.json"), JSON.stringify({
    schemaVersion: 1, cacheRoot: path.join(selected, "cache")
  }));
  const result = item.result(runArgs(item, "npm", ["--prefix", selected, "test"]));
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Managed storage must be outside the project/);
  assert.equal(item.calls().some((call) => call.includes("create")), false);
  assert.equal(fs.existsSync(path.join(item.managed, "xcode")), false);
  assert.equal(fs.existsSync(path.join(item.managed, "caches")), false);
  assert.equal(fs.existsSync(path.join(selected, "cache")), false);
});

test("xcode test-run owns one fresh UDID, preserves argv/cwd/stdio/status, and keeps results outside simulator data", macOnly, (t) => {
  const item = fixture(t);
  const passed = ["argument with spaces", "semi;colon", "quote'and\"double"];
  const child = writeChild(item);
  const result = item.result(runArgs(item, process.execPath, [child, ...passed]), { TEST_EXIT: "37" });
  assert.equal(result.status, 37, result.stderr);
  assert.equal(result.stdout, "test stdout\n");
  assert.match(result.stderr, /test stderr\n/);
  assert.match(result.stderr, new RegExp(`removed disposable simulator ${DEVICE_ID}`));
  const capture = JSON.parse(fs.readFileSync(item.env.CAPTURE_PATH, "utf8"));
  assert.deepEqual(capture.argv, passed);
  assert.equal(capture.cwd, item.project);
  assert.equal(capture.udid, DEVICE_ID);
  assert.equal(capture.deviceType, DEVICE_TYPE);
  assert.equal(capture.runtime, RUNTIME);
  assert.equal(capture.mode, "session-only");
  assert.match(capture.runId, /^[0-9a-f-]{36}$/);
  assert.ok(capture.results.startsWith(path.join(item.managed, "xcode", "test-results")));
  assert.equal(capture.results.includes(path.join("CoreSimulator", "Devices")), false);
  assert.deepEqual(item.devicesNow().map((device) => device.udid), [PERSONAL_ID], "the pre-existing simulator remains untouched");

  const record = testRunRecord(item, capture.runId);
  assert.equal(record.status, "cleanup-complete");
  assert.equal(record.childExitCode, 37);
  assert.equal(record.cleanup.status, "removed");
  assert.equal("args" in record, false, "command arguments are not recorded");
  const operations = item.calls();
  const create = operations.find((call) => call.includes("create"));
  assert.deepEqual(create.slice(-3), [record.device.name, DEVICE_TYPE, RUNTIME]);
  const deletes = operations.filter((call) => call.includes("delete"));
  assert.equal(deletes.length, 1);
  assert.deepEqual(deletes[0].slice(-2), ["delete", DEVICE_ID]);
  assert.equal(operations.some((call) => call.includes("all") || call.includes("unavailable") || call.includes("erase")), false);
});

test("xcode test-run refuses simulator mutation while Xcode/test activity is active", macOnly, (t) => {
  const item = fixture(t);
  fs.writeFileSync(path.join(item.running, "xcodebuild"), "active");
  const result = item.result(runArgs(item, process.execPath, ["-e", "process.exit(0)"]));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Xcode\/test activity is already running/);
  assert.equal(item.calls().some((call) => call.includes("create")), false);
  assert.deepEqual(item.devicesNow().map((device) => device.udid), [PERSONAL_ID]);
  assert.equal(fs.existsSync(path.join(item.managed, "xcode", "test-run-records")), false);
});

test("explicit test-cleanup retries only the receipted UDID after an ordinary cleanup failure", macOnly, (t) => {
  const item = fixture(t);
  fs.writeFileSync(item.env.FAKE_DELETE_FAIL_PATH, "fail once");
  const child = writeChild(item);
  const result = item.result(runArgs(item, process.execPath, [child]), { TEST_EXIT: "0" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /cleanup is pending/);
  assert.equal(item.devicesNow().length, 2);
  const capture = JSON.parse(fs.readFileSync(item.env.CAPTURE_PATH, "utf8"));
  const record = testRunRecord(item, capture.runId);
  assert.equal(record.cleanup.status, "retained");
  fs.rmSync(item.env.FAKE_DELETE_FAIL_PATH);

  const cleanup = item.result(["xcode", "test-cleanup", capture.runId, "--json"]);
  assert.equal(cleanup.status, 0, cleanup.stderr);
  assert.equal(JSON.parse(cleanup.stdout).cleaned, true);
  assert.deepEqual(item.devicesNow().map((device) => device.udid), [PERSONAL_ID]);
  assert.equal(item.calls().filter((call) => call.includes("delete")).every((call) => call.slice(-2).join(" ") === `delete ${DEVICE_ID}`), true);
});

test("cleanup shuts down a booted owned simulator, then deletes only its UUID", macOnly, (t) => {
  const item = fixture(t);
  const child = writeChild(item, childScript(`
const file = process.env.FAKE_SIMCTL_DIR + "/state.json";
const state = JSON.parse(fs.readFileSync(file, "utf8"));
state.devices.find((device) => device.udid === process.env.CLEAN_DEVELOPMENT_XCODE_SIMULATOR_UDID).state = "Booted";
fs.writeFileSync(file, JSON.stringify(state));
`));
  const result = item.result(runArgs(item, process.execPath, [child]));
  assert.equal(result.status, 0, result.stderr);
  const shutdowns = item.calls().filter((call) => call.includes("shutdown"));
  assert.equal(shutdowns.length, 1);
  assert.deepEqual(shutdowns[0].slice(-2), ["shutdown", DEVICE_ID]);
  assert.deepEqual(item.devicesNow().map((device) => device.udid), [PERSONAL_ID]);
});

for (const [label, member] of [
  ["null", null], ["missing UDID", {}], ["non-string UDID", { udid: 7 }],
  ["invalid UDID", { udid: "invalid" }], ["array", []]
]) {
  test(`cleanup retains malformed ${label} device metadata and permits exact retry`, macOnly, (t) => {
    const item = fixture(t);
    const response = JSON.stringify({ devices: { [RUNTIME]: [member] } });
    const child = writeChild(item, childScript(`
fs.writeFileSync(process.env.FAKE_DEVICE_LIST_PATH, ${JSON.stringify(response)});
`));
    const result = item.result(runArgs(item, process.execPath, [child]), { TEST_EXIT: "23" });
    assert.equal(result.status, 23, result.stderr);
    assert.match(result.stderr, /simulator cleanup is pending/);
    const capture = JSON.parse(fs.readFileSync(item.env.CAPTURE_PATH, "utf8"));
    const record = testRunRecord(item, capture.runId);
    assert.equal(record.cleanup.status, "retained");
    assert.match(record.cleanup.reason, /unreadable simulator device data/);
    assert.deepEqual(item.devicesNow().map((device) => device.udid), [PERSONAL_ID, DEVICE_ID]);
    assert.equal(item.calls().some((call) => call.includes("delete")), false);

    const unknown = item.result(["xcode", "test-cleanup", capture.runId, "--json"]);
    assert.equal(unknown.status, 1, unknown.stderr);
    assert.equal(JSON.parse(unknown.stdout).cleaned, false);
    assert.equal(item.calls().some((call) => call.includes("delete")), false);

    fs.rmSync(item.env.FAKE_DEVICE_LIST_PATH);
    const cleanup = item.result(["xcode", "test-cleanup", capture.runId, "--json"]);
    assert.equal(cleanup.status, 0, cleanup.stderr);
    assert.equal(JSON.parse(cleanup.stdout).cleaned, true);
    assert.equal(testRunRecord(item, capture.runId).cleanup.status, "removed");
    assert.deepEqual(item.devicesNow().map((device) => device.udid), [PERSONAL_ID]);
    assert.deepEqual(item.calls().filter((call) => call.includes("delete")).map((call) => call.slice(-2)),
      [["delete", DEVICE_ID]]);
  });
}

test("cleanup retains the run when device identity changed after the test", macOnly, (t) => {
  const item = fixture(t);
  const child = writeChild(item, childScript(`
const file = process.env.FAKE_SIMCTL_DIR + "/state.json";
const state = JSON.parse(fs.readFileSync(file, "utf8"));
state.devices.find((device) => device.udid === process.env.CLEAN_DEVELOPMENT_XCODE_SIMULATOR_UDID).name = "Changed by another owner";
fs.writeFileSync(file, JSON.stringify(state));
`));
  const result = item.result(runArgs(item, process.execPath, [child]));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /identity no longer matches/);
  const capture = JSON.parse(fs.readFileSync(item.env.CAPTURE_PATH, "utf8"));
  const retry = item.result(["xcode", "test-cleanup", capture.runId, "--json"]);
  assert.equal(retry.status, 1);
  assert.match(JSON.parse(retry.stdout).reason, /identity no longer matches/);
  assert.equal(item.calls().some((call) => call.includes("delete")), false);
  assert.equal(item.devicesNow().length, 2);
});

test("cleanup waits for active Xcode/test processes and one-run recovery is exact", macOnly, (t) => {
  const item = fixture(t);
  const child = writeChild(item, childScript(`fs.writeFileSync(process.env.FAKE_RUNNING_DIR + "/xcodebuild", "active");`));
  const result = item.result(runArgs(item, process.execPath, [child]));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Xcode\/test activity is still running/);
  const capture = JSON.parse(fs.readFileSync(item.env.CAPTURE_PATH, "utf8"));
  const held = item.result(["xcode", "test-cleanup", capture.runId, "--json"]);
  assert.equal(held.status, 1);
  assert.equal(item.calls().some((call) => call.includes("delete")), false);
  fs.rmSync(path.join(item.running, "xcodebuild"));
  const recovered = item.result(["xcode", "test-cleanup", capture.runId, "--json"]);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.deepEqual(item.devicesNow().map((device) => device.udid), [PERSONAL_ID]);
  assert.equal(item.calls().filter((call) => call.includes("delete")).length, 1);
});

test("SIGINT is forwarded to the test child, then the owned simulator is cleaned", { ...macOnly, skip: process.platform !== "darwin" ? "Xcode simulator tests require macOS" : false }, async (t) => {
  const item = fixture(t);
  const ready = path.join(item.root, "child.ready");
  const signalCapture = path.join(item.root, "child.signal");
  const child = writeChild(item, `
import fs from "node:fs";
const timer = setInterval(() => {}, 1000);
fs.writeFileSync(${JSON.stringify(ready)}, "ready");
process.on("SIGINT", () => {
  clearInterval(timer);
  fs.writeFileSync(${JSON.stringify(signalCapture)}, "SIGINT");
  process.exitCode = 130;
});
`);
  const processChild = spawn(process.execPath, [cli, ...runArgs(item, process.execPath, [child])], {
    cwd: item.project, env: item.env, stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => { try { processChild.kill("SIGKILL"); } catch {} });
  let stdout = "", stderr = "";
  processChild.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  processChild.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const exit = new Promise((resolve, reject) => {
    processChild.once("error", reject);
    processChild.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fs.existsSync(ready), true, `child started; stderr=${stderr}`);
  processChild.kill("SIGINT");
  let timeout;
  let actual;
  try {
    actual = await Promise.race([exit, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`interrupt timed out; stdout=${stdout}; stderr=${stderr}`)), 5000);
    })]);
  } finally { clearTimeout(timeout); }
  assert.deepEqual(actual, { code: 130, signal: null }, stderr);
  assert.equal(fs.readFileSync(signalCapture, "utf8"), "SIGINT");
  assert.match(stderr, /removed disposable simulator/);
  assert.deepEqual(item.devicesNow().map((device) => device.udid), [PERSONAL_ID]);
});

test("cleanup leaves other device IDs alone even when they appear beside the owned simulator", macOnly, (t) => {
  const item = fixture(t);
  const child = writeChild(item, childScript(`fs.writeFileSync(process.env.FAKE_ADD_EXTRA_PATH, "add");`));
  const result = item.result(runArgs(item, process.execPath, [child]));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(item.devicesNow().map((device) => device.udid), [PERSONAL_ID], "the pre-existing simulator remains untouched");
  const deletes = item.calls().filter((call) => call.includes("delete"));
  assert.equal(deletes.length, 1);
  assert.deepEqual(deletes[0].slice(-2), ["delete", DEVICE_ID]);
  assert.equal(deletes.some((call) => call.includes(FOREIGN_ID)), false);
});

test("simctl returning a pre-existing UDID never grants cleanup authority", macOnly, (t) => {
  const item = fixture(t);
  const result = item.result(runArgs(item, process.execPath, ["-e", "process.exit(99)"]), { FAKE_CREATE_ID: PERSONAL_ID });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /pre-existing simulator UDID/);
  assert.equal(item.devicesNow().length, 1);
  assert.equal(item.devicesNow()[0].udid, PERSONAL_ID);
  assert.equal(item.calls().some((call) => call.some((argument) => argument === "delete")), false);
  const receiptFiles = fs.readdirSync(path.join(item.managed, "xcode", "test-run-records"));
  assert.equal(receiptFiles.length, 1);
  const receipt = JSON.parse(fs.readFileSync(path.join(item.managed, "xcode", "test-run-records", receiptFiles[0]), "utf8"));
  assert.equal(receipt.device.udid, null);
  assert.equal(receipt.cleanup.status, "retained");
});

test("SIGTERM is forwarded to the test child, then the owned simulator is cleaned", macOnly, async (t) => {
  const item = fixture(t);
  const ready = path.join(item.root, "child.ready");
  const signalCapture = path.join(item.root, "child.signal");
  const child = writeChild(item, `
import fs from "node:fs";
const timer = setInterval(() => {}, 1000);
fs.writeFileSync(${JSON.stringify(ready)}, "ready");
process.on("SIGTERM", () => {
  clearInterval(timer);
  fs.writeFileSync(${JSON.stringify(signalCapture)}, "SIGTERM");
  process.exitCode = 143;
});
`);
  const processChild = spawn(process.execPath, [cli, ...runArgs(item, process.execPath, [child])], {
    cwd: item.project, env: item.env, stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => { try { processChild.kill("SIGKILL"); } catch {} });
  let stderr = "";
  processChild.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const exit = new Promise((resolve, reject) => {
    processChild.once("error", reject);
    processChild.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fs.existsSync(ready), true, `child started; stderr=${stderr}`);
  processChild.kill("SIGTERM");
  const actual = await Promise.race([exit, new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`terminate timed out; stderr=${stderr}`)), 5000);
  })]);
  assert.deepEqual(actual, { code: 143, signal: null }, stderr);
  assert.equal(fs.readFileSync(signalCapture, "utf8"), "SIGTERM");
  assert.match(stderr, /removed disposable simulator/);
  assert.deepEqual(item.devicesNow().map((device) => device.udid), [PERSONAL_ID]);
});

test("a signal delivered during synchronous provisioning is handled before the test child starts", macOnly, (t) => {
  const item = fixture(t);
  const child = writeChild(item);
  const result = item.result(runArgs(item, process.execPath, [child]), { FAKE_INTERRUPT_DURING_CREATE: "1" });
  assert.equal(result.status, 130, result.stderr);
  assert.equal(fs.existsSync(item.env.CAPTURE_PATH), false, "the test command did not start");
  assert.match(result.stderr, /removed disposable simulator/);
  assert.deepEqual(item.devicesNow().map((device) => device.udid), [PERSONAL_ID]);
});

test("a concurrent cleanup request does not replace the active run receipt", macOnly, async (t) => {
  const item = fixture(t);
  const stop = path.join(item.root, "child.stop");
  const child = writeChild(item, childScript(`
const timer = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(stop)})) return;
  clearInterval(timer);
  process.exit(37);
}, 20);
`));
  const processChild = spawn(process.execPath, [cli, ...runArgs(item, process.execPath, [child])], {
    cwd: item.project, env: item.env, stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => { try { processChild.kill("SIGKILL"); } catch {} });
  let stderr = "";
  processChild.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const exit = new Promise((resolve, reject) => {
    processChild.once("error", reject);
    processChild.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(item.env.CAPTURE_PATH) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fs.existsSync(item.env.CAPTURE_PATH), true, `child started; stderr=${stderr}`);
  const capture = JSON.parse(fs.readFileSync(item.env.CAPTURE_PATH, "utf8"));
  const recordPath = path.join(item.managed, "xcode", "test-run-records", `${capture.runId}.json`);
  const before = fs.statSync(recordPath);
  const cleanup = item.result(["xcode", "test-cleanup", capture.runId, "--json"]);
  assert.equal(cleanup.status, 1);
  assert.match(JSON.parse(cleanup.stdout).reason, /test process .* is still active/);
  const after = fs.statSync(recordPath);
  assert.equal(after.ino, before.ino, "busy cleanup leaves the active receipt inode unchanged");
  assert.equal(JSON.parse(fs.readFileSync(recordPath, "utf8")).childExitCode, null);

  fs.writeFileSync(stop, "stop");
  assert.deepEqual(await exit, { code: 37, signal: null }, stderr);
  const completed = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  assert.equal(completed.childExitCode, 37);
  assert.equal(completed.cleanup.status, "removed");
  assert.deepEqual(item.devicesNow().map((device) => device.udid), [PERSONAL_ID]);
});

test("cleanup waits for the active run owner even after its child process has exited", macOnly, (t) => {
  const item = fixture(t);
  const runId = "12345678-1234-4234-8234-123456789abc";
  const token = "87654321-4321-4234-8234-cba987654321";
  const recordDirectory = path.join(item.managed, "xcode", "test-run-records");
  const resultsPath = path.join(item.managed, "xcode", "test-results", runId);
  fs.mkdirSync(recordDirectory, { recursive: true });
  fs.mkdirSync(resultsPath, { recursive: true });
  const dataPath = path.join(item.devices, DEVICE_ID, "data");
  fs.mkdirSync(dataPath, { recursive: true });
  const state = JSON.parse(fs.readFileSync(item.state, "utf8"));
  state.devices.push({ udid: DEVICE_ID, name: `Clean Development Test ${runId}`, deviceTypeIdentifier: DEVICE_TYPE,
    runtime: RUNTIME, state: "Shutdown", isAvailable: true, dataPath, deviceSet: item.devices });
  fs.writeFileSync(item.state, JSON.stringify(state));
  const receiptPath = path.join(recordDirectory, `${runId}.json`);
  fs.writeFileSync(receiptPath, JSON.stringify({ schemaVersion: 1, kind: "clean-development.xcode-test-run", runId, token,
    status: "finished", createdAt: new Date().toISOString(), deviceSetPath: item.devices, resultsPath,
    ownerPid: process.pid, device: { name: `Clean Development Test ${runId}`, udid: DEVICE_ID, type: DEVICE_TYPE, runtime: RUNTIME },
    childPid: null, childExitCode: 37, cleanup: { status: "pending", reason: null } }, null, 2));
  const before = fs.statSync(receiptPath);

  const cleanup = item.result(["xcode", "test-cleanup", runId, "--json"]);
  assert.equal(cleanup.status, 1);
  assert.match(JSON.parse(cleanup.stdout).reason, /lifecycle process .* is still active/);
  assert.equal(fs.statSync(receiptPath).ino, before.ino, "the active owner's receipt is unchanged");
  assert.equal(item.calls().some((call) => call.some((argument) => argument === "delete")), false);
  assert.equal(item.devicesNow().some((device) => device.udid === DEVICE_ID), true);
});

test("cleanup cannot rewrite a provisioning receipt while its owner is still creating a simulator", macOnly, (t) => {
  const item = fixture(t);
  const runId = "abcdefab-cdef-4abc-8def-abcdefabcdef";
  const token = "fedcbafe-dcba-4fed-8cba-fedcbafedcba";
  const recordDirectory = path.join(item.managed, "xcode", "test-run-records");
  const resultsPath = path.join(item.managed, "xcode", "test-results", runId);
  fs.mkdirSync(recordDirectory, { recursive: true });
  fs.mkdirSync(resultsPath, { recursive: true });
  const receiptPath = path.join(recordDirectory, `${runId}.json`);
  fs.writeFileSync(receiptPath, JSON.stringify({ schemaVersion: 1, kind: "clean-development.xcode-test-run", runId, token,
    status: "provisioning", createdAt: new Date().toISOString(), deviceSetPath: item.devices, resultsPath,
    ownerPid: process.pid, device: { name: `Clean Development Test ${runId}`, udid: null, type: DEVICE_TYPE, runtime: RUNTIME },
    childPid: null, childExitCode: null, cleanup: { status: "pending", reason: null } }, null, 2));
  const before = fs.statSync(receiptPath);

  const cleanup = item.result(["xcode", "test-cleanup", runId, "--json"]);
  assert.equal(cleanup.status, 1);
  assert.match(JSON.parse(cleanup.stdout).reason, /lifecycle process .* is still active/);
  assert.equal(fs.statSync(receiptPath).ino, before.ino, "the provisioning owner's receipt is unchanged");
  assert.equal(JSON.parse(fs.readFileSync(receiptPath, "utf8")).device.udid, null);
  assert.deepEqual(item.calls(), [], "provisioning cleanup does not inspect or mutate simulator state");
});

test("xcode test-run rejects missing explicit simulator identity and home-directory managed roots", macOnly, (t) => {
  const item = fixture(t);
  const missing = item.result(["xcode", "test-run", "--session", "session-only", "--", process.execPath, "-e", ""]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /requires --device-type/);
  assert.equal(item.calls().some((call) => call.includes("create")), false);

  const homeRoot = path.join(item.home, "managed");
  fs.mkdirSync(homeRoot);
  const homeManaged = item.result(runArgs(item, process.execPath, ["-e", ""]), { CLEAN_DEVELOPMENT_ROOT: homeRoot });
  assert.equal(homeManaged.status, 1);
  assert.match(homeManaged.stderr, /outside the home directory/);
  assert.equal(item.calls().some((call) => call.includes("create")), false);
});

test("xcode test-run rejects project-local storage even when session routing is skipped", macOnly, (t) => {
  const item = fixture(t);
  const projectRoot = path.join(item.project, "managed");
  const result = item.result(runArgs(item, process.execPath, ["-e", ""], "skip"), {
    CLEAN_DEVELOPMENT_SESSION_MODE: "skip",
    CLEAN_DEVELOPMENT_ROOT: projectRoot
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /managed storage outside the project/);
  assert.equal(fs.existsSync(projectRoot), false);
  assert.equal(item.calls().some((call) => call.includes("create")), false);
});
