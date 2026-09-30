import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ensureRealDirectory, readJson, writeJsonAtomic, writeJsonExclusive } from "./io.js";
import { resolveExecutable } from "./executable.js";
import { environmentValue, isPathInside } from "./platform.js";
import { runWithShims } from "./runtime.js";
import { repositoryManagedPaths } from "./routing-context.js";
import { detectStack } from "./workspace.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIMULATOR_IDENTIFIER = /^com\.apple\.CoreSimulator\.Sim(?:DeviceType|Runtime)\.[A-Za-z0-9._-]+$/;
const RECEIPT_KIND = "clean-development.xcode-test-run";
const COMMAND_TIMEOUT_MS = 60_000;
const ACTIVE_PROCESSES = ["Xcode", "xcodebuild", "xctest", "Simulator"];
const RUN_ENVIRONMENT = [
  "CLEAN_DEVELOPMENT_XCODE_TEST_RUN_ID",
  "CLEAN_DEVELOPMENT_XCODE_SIMULATOR_UDID",
  "CLEAN_DEVELOPMENT_XCODE_DEVICE_TYPE",
  "CLEAN_DEVELOPMENT_XCODE_RUNTIME",
  "CLEAN_DEVELOPMENT_XCODE_RESULTS_PATH"
];

function simulatorHome(env) {
  const value = environmentValue(env, "HOME") || os.homedir();
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error("HOME must be an absolute path to use Xcode simulators");
  return path.resolve(value);
}

function runPaths(config, env) {
  const xcodeRoot = path.join(config.root, "xcode");
  return {
    xcodeRoot,
    records: path.join(xcodeRoot, "test-run-records"),
    results: path.join(xcodeRoot, "test-results"),
    devices: path.join(simulatorHome(env), "Library", "Developer", "CoreSimulator", "Devices")
  };
}

function sameIdentity(left, right) {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

function directorySnapshot(directory, label) {
  const resolved = path.resolve(directory);
  const stat = fs.lstatSync(resolved, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(resolved) !== resolved) {
    throw new Error(`${label} is not a real canonical directory: ${resolved}`);
  }
  return stat;
}

function ensureDirectory(directory, label) {
  ensureRealDirectory(directory, { create: true, label });
  return directorySnapshot(directory, label);
}

function ensureConfiguredRoot(config, env) {
  const root = path.resolve(config.root);
  const stat = fs.lstatSync(root, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(root) !== root) {
    throw new Error(`Managed root is not a real canonical directory: ${root}`);
  }
  const homes = new Set([path.resolve(config.locations.home), simulatorHome(env)]);
  for (const home of homes) {
    if (root === home || isPathInside(home, root)) {
      throw new Error(`Xcode test runs require a configured managed root outside the home directory: ${root}`);
    }
  }
  return root;
}

function ensureOutsideProject(config, cwd) {
  const project = detectStack(path.resolve(cwd), { home: config.locations.home });
  const conflicts = repositoryManagedPaths(project.root, config);
  if (conflicts.length) {
    throw new Error(`Xcode test runs require managed storage outside the project: ${conflicts.join(", ")}`);
  }
}

function assertNoEnvironmentConflicts(env, devices) {
  const setPath = environmentValue(env, "SIMULATOR_DEVICE_SET_PATH");
  if (setPath && path.resolve(setPath) !== devices) {
    throw new Error(`SIMULATOR_DEVICE_SET_PATH selects another device set; xcode test-run requires the host's default set ${devices}`);
  }
  const conflicts = RUN_ENVIRONMENT.filter((name) => environmentValue(env, name) !== undefined);
  if (conflicts.length) throw new Error(`Clear the existing Clean Development test-run variable(s) before starting another run: ${conflicts.join(", ")}`);
}

function executable(name, config, env) {
  const file = resolveExecutable(name, env, config.locations.binDir);
  if (!file) throw new Error(`Cannot find '${name}' on PATH`);
  return file;
}

function runCaptured(name, args, config, env) {
  const file = executable(name, config, env);
  const result = spawnSync(file, args, {
    env,
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error) throw new Error(`${name} ${args.join(" ")} failed: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim().slice(0, 300);
    throw new Error(`${name} ${args.join(" ")} failed${detail ? `: ${detail}` : ` (exit ${result.status ?? result.signal ?? "unknown"})`}`);
  }
  return result.stdout || "";
}

function simctl(config, env, devices, args) {
  return runCaptured("xcrun", ["simctl", "--set", devices, ...args], config, env);
}

function parseList(output, field, label) {
  let value;
  try { value = JSON.parse(output); } catch { throw new Error(`simctl returned unreadable ${label} JSON`); }
  if (!value || !Array.isArray(value[field])) throw new Error(`simctl returned unreadable ${label} data`);
  return value[field];
}

function listDeviceRecords(config, env, devices) {
  let parsed;
  try { parsed = JSON.parse(simctl(config, env, devices, ["list", "devices", "--json"])); }
  catch (error) { throw new Error(`Cannot inspect the selected simulator device set: ${error.message}`); }
  if (!parsed || !parsed.devices || typeof parsed.devices !== "object" || Array.isArray(parsed.devices)) {
    throw new Error("simctl returned unreadable simulator device data");
  }
  return Object.entries(parsed.devices).flatMap(([runtime, entries]) => {
    if (!Array.isArray(entries)) throw new Error("simctl returned unreadable simulator device data");
    return entries.map((device) => {
      // A malformed member cannot prove that the receipt's device is absent.
      // Keep cleanup retryable until every listed identity can be inspected.
      if (!device || typeof device !== "object" || Array.isArray(device)
        || typeof device.udid !== "string" || !UUID.test(device.udid)) {
        throw new Error("simctl returned unreadable simulator device data");
      }
      return { ...device, runtime };
    });
  });
}

function assertDeviceAndRuntime(config, env, deviceType, runtime) {
  if (!SIMULATOR_IDENTIFIER.test(deviceType)) throw new Error("--device-type must be an exact CoreSimulator device type identifier");
  if (!SIMULATOR_IDENTIFIER.test(runtime)) throw new Error("--runtime must be an exact CoreSimulator runtime identifier");
  if (!deviceType.startsWith("com.apple.CoreSimulator.SimDeviceType.")) throw new Error("--device-type must be a CoreSimulator device type identifier");
  if (!runtime.startsWith("com.apple.CoreSimulator.SimRuntime.")) throw new Error("--runtime must be a CoreSimulator runtime identifier");
  const types = parseList(runCaptured("xcrun", ["simctl", "list", "devicetypes", "--json"], config, env), "devicetypes", "device type");
  const selectedType = types.find((item) => item?.identifier === deviceType);
  if (!selectedType) throw new Error(`Simulator device type is not installed: ${deviceType}`);
  const runtimes = parseList(runCaptured("xcrun", ["simctl", "list", "runtimes", "--json"], config, env), "runtimes", "runtime");
  const selectedRuntime = runtimes.find((item) => item?.identifier === runtime && item.isAvailable === true);
  if (!selectedRuntime) throw new Error(`Simulator runtime is not installed and available: ${runtime}`);
  const supportedTypes = selectedRuntime.supportedDeviceTypes;
  if (Array.isArray(supportedTypes) && !supportedTypes.some((item) => item?.identifier === deviceType)) {
    throw new Error(`Simulator runtime ${runtime} does not support device type ${deviceType}`);
  }
}

function testRunActivity(config, env) {
  let pgrep;
  try { pgrep = executable("pgrep", config, env); } catch { return { running: false, unknown: true, processes: [] }; }
  const processes = [];
  let unknown = false;
  for (const name of ACTIVE_PROCESSES) {
    const result = spawnSync(pgrep, ["-x", name], { env, encoding: "utf8", timeout: 5_000, maxBuffer: 4096 });
    if (result.error || (result.status !== 0 && result.status !== 1)) unknown = true;
    else if (result.status === 0) processes.push(name);
  }
  return { running: processes.length > 0, unknown, processes };
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

function receiptPath(paths, runId) {
  return path.join(paths.records, `${runId}.json`);
}

function readReceipt(file, runId) {
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Test-run receipt is not a regular file: ${file}`);
  const record = readJson(file, null);
  if (!record || record.schemaVersion !== 1 || record.kind !== RECEIPT_KIND || record.runId !== runId
    || typeof record.token !== "string" || !UUID.test(record.token)
    || typeof record.deviceSetPath !== "string" || !path.isAbsolute(record.deviceSetPath)
    || typeof record.resultsPath !== "string" || !path.isAbsolute(record.resultsPath)
    || typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))
    || !Number.isSafeInteger(record.ownerPid) || record.ownerPid <= 0
    || !record.device || typeof record.device !== "object") {
    throw new Error(`Invalid Xcode test-run receipt: ${file}`);
  }
  return { record, stat };
}

function saveReceipt(handle, next) {
  const parent = directorySnapshot(path.dirname(handle.file), "Test-run receipt directory");
  if (!sameIdentity(parent, handle.parentIdentity) || fs.realpathSync.native(path.dirname(handle.file)) !== path.dirname(handle.file)) {
    throw new Error(`Test-run receipt directory changed: ${path.dirname(handle.file)}`);
  }
  const current = fs.lstatSync(handle.file, { bigint: true });
  if (!current.isFile() || current.isSymbolicLink() || !sameIdentity(current, handle.fileIdentity)) {
    throw new Error(`Test-run receipt changed: ${handle.file}`);
  }
  writeJsonAtomic(handle.file, { ...next, updatedAt: new Date().toISOString() });
  const updated = fs.lstatSync(handle.file, { bigint: true });
  if (!updated.isFile() || updated.isSymbolicLink()) throw new Error(`Test-run receipt changed while saving: ${handle.file}`);
  handle.fileIdentity = updated;
  handle.record = { ...next, updatedAt: new Date().toISOString() };
  return handle.record;
}

function receiptHandle(config, env, runId, token = null) {
  const paths = runPaths(config, env);
  const recordsIdentity = directorySnapshot(paths.records, "Test-run receipt directory");
  const file = receiptPath(paths, runId);
  const { record, stat } = readReceipt(file, runId);
  if (token && record.token !== token) throw new Error(`Test-run receipt ownership changed: ${file}`);
  return { paths, file, record, parentIdentity: recordsIdentity, fileIdentity: stat };
}

function exactOwnedDevice(record, deviceRecords, deviceSetPath) {
  const matches = deviceRecords.filter((item) => typeof item.udid === "string" && item.udid.toLowerCase() === record.device.udid.toLowerCase());
  if (matches.length === 0) return null;
  if (matches.length !== 1) throw new Error("The recorded simulator UDID is ambiguous in the selected device set");
  const device = matches[0];
  const expectedData = path.join(deviceSetPath, record.device.udid.toUpperCase(), "data");
  if (device.name !== record.device.name || device.deviceTypeIdentifier !== record.device.type || device.runtime !== record.device.runtime
    || device.isAvailable !== true || typeof device.dataPath !== "string" || path.resolve(device.dataPath) !== expectedData) {
    throw new Error("The recorded simulator identity no longer matches its receipt");
  }
  return device;
}

function recordCleanup(handle, status, reason = null) {
  const record = {
    ...handle.record,
    status: status === "removed" ? "cleanup-complete" : "cleanup-pending",
    cleanup: { status, reason },
    updatedAt: new Date().toISOString()
  };
  return saveReceipt(handle, record);
}

function cleanupOwnedDevice(config, env, handle) {
  const latest = readReceipt(handle.file, handle.record.runId);
  if (!sameIdentity(latest.stat, handle.fileIdentity) || latest.record.token !== handle.record.token
    || latest.record.device?.udid !== handle.record.device?.udid) {
    throw new Error(`Test-run receipt changed before cleanup: ${handle.file}`);
  }
  handle.record = latest.record;
  const record = handle.record;
  if (record.childPid && processIsAlive(record.childPid)) {
    const reason = `the recorded test process ${record.childPid} is still active`;
    // A concurrent cleanup request must not atomically replace the receipt
    // while its owning run is still recording the child's final status.
    return { cleaned: false, reason };
  }
  if (record.ownerPid !== process.pid && processIsAlive(record.ownerPid)) {
    // The child may have exited while its owner is still processing the exit
    // event and final receipt update. Do not race that owner with manual cleanup.
    return { cleaned: false, reason: `the lifecycle process ${record.ownerPid} is still active` };
  }
  if (!record.device?.udid || !UUID.test(record.device.udid)) {
    recordCleanup(handle, "retained", "creation-incomplete; no registered simulator UDID");
    return { cleaned: false, reason: "creation-incomplete; no registered simulator UDID" };
  }
  const expectedPaths = runPaths(config, env);
  if (record.deviceSetPath !== expectedPaths.devices) {
    recordCleanup(handle, "retained", "the recorded device set differs from the current host identity");
    return { cleaned: false, reason: "the recorded device set differs from the current host identity" };
  }
  try { directorySnapshot(expectedPaths.devices, "CoreSimulator device set"); }
  catch (error) {
    recordCleanup(handle, "retained", error.message);
    return { cleaned: false, reason: error.message };
  }
  const activity = testRunActivity(config, env);
  if (activity.running || activity.unknown) {
    const reason = activity.running ? `Xcode/test activity is still running (${activity.processes.join(", ")})` : "Xcode/test activity is unknown";
    return { cleaned: false, reason };
  }
  try {
    let device = exactOwnedDevice(record, listDeviceRecords(config, env, expectedPaths.devices), expectedPaths.devices);
    if (!device) {
      recordCleanup(handle, "removed", "the recorded simulator was already absent");
      return { cleaned: true, alreadyAbsent: true };
    }
    if (device.state !== "Shutdown" && device.state !== "Booted") throw new Error(`The recorded simulator is in an unknown state: ${device.state || "missing"}`);
    if (device.state === "Booted") {
      simctl(config, env, expectedPaths.devices, ["shutdown", record.device.udid]);
      const afterShutdownActivity = testRunActivity(config, env);
      if (afterShutdownActivity.running || afterShutdownActivity.unknown) {
        throw new Error(afterShutdownActivity.running ? "Xcode/test activity started during shutdown" : "Xcode/test activity became unknown during shutdown");
      }
      device = exactOwnedDevice(record, listDeviceRecords(config, env, expectedPaths.devices), expectedPaths.devices);
      if (!device || device.state !== "Shutdown") throw new Error("The recorded simulator did not reach Shutdown");
    }
    const beforeDeleteActivity = testRunActivity(config, env);
    if (beforeDeleteActivity.running || beforeDeleteActivity.unknown) {
      throw new Error(beforeDeleteActivity.running ? "Xcode/test activity started before simulator deletion" : "Xcode/test activity became unknown before simulator deletion");
    }
    const latestReceipt = readReceipt(handle.file, record.runId);
    if (!sameIdentity(latestReceipt.stat, handle.fileIdentity) || latestReceipt.record.token !== record.token
      || latestReceipt.record.device?.udid !== record.device.udid) {
      throw new Error(`Test-run receipt changed before deleting simulator ${record.device.udid}`);
    }
    // Delete exactly the fresh UDID recorded for this run. Never use delete all,
    // unavailable, a name, an inferred age, or a device-set-wide filesystem removal.
    simctl(config, env, expectedPaths.devices, ["delete", record.device.udid]);
    const remains = exactOwnedDevice(record, listDeviceRecords(config, env, expectedPaths.devices), expectedPaths.devices);
    if (remains) throw new Error("simctl reported success but the recorded simulator is still present");
    recordCleanup(handle, "removed");
    return { cleaned: true };
  } catch (error) {
    const reason = error.message;
    recordCleanup(handle, "retained", reason);
    return { cleaned: false, reason };
  }
}

function validateRunOptions(deviceType, runtime, command) {
  if (!deviceType) throw new Error("xcode test-run requires --device-type with an exact CoreSimulator identifier");
  if (!runtime) throw new Error("xcode test-run requires --runtime with an exact CoreSimulator identifier");
  if (!command) throw new Error("xcode test-run requires a child command after --");
}

function signalExitCode(signal) {
  const number = signal === "SIGTERM" ? os.constants.signals.SIGTERM : os.constants.signals.SIGINT;
  return 128 + (number || 1);
}

/** Run one explicitly requested test command against a fresh, receipt-owned simulator. */
export function validateXcodeTestRun(config, env, { deviceType, runtime, command, cwd = process.cwd(), platform = process.platform } = {}) {
  if (platform !== "darwin") throw new Error("Xcode simulator test runs are available on macOS only");
  validateRunOptions(deviceType, runtime, command);
  ensureOutsideProject(config, cwd);
  ensureConfiguredRoot(config, env);
  const paths = runPaths(config, env);
  directorySnapshot(paths.devices, "CoreSimulator device set");
  assertNoEnvironmentConflicts(env, paths.devices);
  const activity = testRunActivity(config, env);
  if (activity.running || activity.unknown) {
    throw new Error(activity.running ? `Xcode/test activity is already running (${activity.processes.join(", ")})` : "Cannot determine whether Xcode/test activity is running");
  }
  assertDeviceAndRuntime(config, env, deviceType, runtime);
}

export async function runXcodeTest(config, env, { deviceType, runtime, command, args = [], routingConfig = config, sessionEnv = env, cwd = process.cwd(), platform = process.platform } = {}) {
  validateXcodeTestRun(config, env, { deviceType, runtime, command, cwd, platform });
  const root = ensureConfiguredRoot(config, env);
  const paths = runPaths(config, env);
  assertNoEnvironmentConflicts(env, paths.devices);
  assertNoEnvironmentConflicts(sessionEnv, paths.devices);
  const before = listDeviceRecords(config, env, paths.devices);
  const beforeIds = new Set(before.map((device) => String(device.udid).toLowerCase()));

  const runId = crypto.randomUUID();
  const token = crypto.randomUUID();
  const runName = `Clean Development Test ${runId}`;
  const recordDirectory = path.join(root, "xcode", "test-run-records");
  const resultsDirectory = path.join(root, "xcode", "test-results");
  const recordsIdentity = ensureDirectory(recordDirectory, "Test-run receipt directory");
  ensureDirectory(resultsDirectory, "Test-run results directory");
  const resultsPath = path.join(resultsDirectory, runId);
  ensureDirectory(resultsPath, "Test-run results path");
  const file = receiptPath({ records: recordDirectory }, runId);
  const receipt = {
    schemaVersion: 1,
    kind: RECEIPT_KIND,
    runId,
    token,
    status: "provisioning",
    createdAt: new Date().toISOString(),
    deviceSetPath: paths.devices,
    resultsPath,
    ownerPid: process.pid,
    device: { name: runName, udid: null, type: deviceType, runtime },
    childPid: null,
    childExitCode: null,
    cleanup: { status: "pending", reason: null }
  };
  writeJsonExclusive(file, receipt, { expectedParent: recordsIdentity });
  const fileIdentity = fs.lstatSync(file, { bigint: true });
  const handle = { paths: { ...paths, records: recordDirectory, results: resultsDirectory }, file, record: receipt,
    parentIdentity: recordsIdentity, fileIdentity };

  const interruption = { signal: null };
  const onInterrupt = (signal) => { interruption.signal ||= signal; };
  const onSigint = () => onInterrupt("SIGINT");
  const onSigterm = () => onInterrupt("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  let childCode = null;
  let childError = null;
  try {
    let created;
    try {
      created = simctl(config, env, paths.devices, ["create", runName, deviceType, runtime]).trim();
    } catch (error) {
      saveReceipt(handle, { ...handle.record, status: "provisioning-failed", failure: error.message });
      throw error;
    }
    if (!UUID.test(created)) {
      saveReceipt(handle, { ...handle.record, status: "provisioning-failed", failure: "simctl create returned no single simulator UDID" });
      throw new Error("simctl create did not return one simulator UDID; the receipt was retained for review");
    }
    const udid = created.toUpperCase();
    if (beforeIds.has(udid.toLowerCase())) {
      // A returned pre-existing identifier is never cleanup authority. Leave it
      // out of the receipt so recovery cannot target a device this run did not create.
      saveReceipt(handle, { ...handle.record, status: "provisioning-failed", failure: "simctl returned a pre-existing UDID" });
      throw new Error("simctl returned a pre-existing simulator UDID; no device was deleted");
    }
    saveReceipt(handle, { ...handle.record, status: "created", device: { ...handle.record.device, udid } });
    const device = exactOwnedDevice(handle.record, listDeviceRecords(config, env, paths.devices), paths.devices, config, env);
    if (!device || device.state !== "Shutdown") throw new Error("The newly created simulator did not match its receipt in Shutdown state");
    // Provisioning uses synchronous simctl calls. Give queued signal callbacks
    // one event-loop turn before allowing the test command to start.
    await new Promise((resolve) => setImmediate(resolve));
    if (interruption.signal) throw new Error(`Interrupted by ${interruption.signal} before the test command started`);

    saveReceipt(handle, { ...handle.record, status: "running" });
    const childEnv = { ...sessionEnv,
      CLEAN_DEVELOPMENT_XCODE_TEST_RUN_ID: runId,
      CLEAN_DEVELOPMENT_XCODE_SIMULATOR_UDID: udid,
      CLEAN_DEVELOPMENT_XCODE_DEVICE_TYPE: deviceType,
      CLEAN_DEVELOPMENT_XCODE_RUNTIME: runtime,
      CLEAN_DEVELOPMENT_XCODE_RESULTS_PATH: resultsPath
    };
    process.stderr.write(`clean-development: run ${runId} uses disposable simulator ${udid}; results: ${resultsPath}\n`);
    try {
      childCode = await runWithShims(command, args, {
        config: routingConfig,
        cwd,
        env: childEnv,
        configureAgent: false,
        onSpawn: (child) => {
          saveReceipt(handle, { ...handle.record, childPid: child.pid });
        }
      });
      saveReceipt(handle, { ...handle.record, status: "finished", childExitCode: childCode, finishedAt: new Date().toISOString() });
    } catch (error) {
      childError = error;
      saveReceipt(handle, { ...handle.record, status: "launch-failed", finishedAt: new Date().toISOString(), failure: error.message });
    }
  } catch (error) {
    childError ||= error;
  }

  if (handle.record.device?.udid && UUID.test(handle.record.device.udid)) {
    try {
      const cleanup = cleanupOwnedDevice(config, env, handle);
      if (!cleanup.cleaned) {
        process.stderr.write(`clean-development: simulator cleanup is pending (${cleanup.reason}); run 'clean-development xcode test-cleanup ${runId}' after Xcode/test activity stops; receipt: ${handle.file}\n`);
      } else {
        process.stderr.write(`clean-development: removed disposable simulator ${handle.record.device.udid}; receipt: ${handle.file}\n`);
      }
    } catch (error) {
      try { recordCleanup(handle, "retained", error.message); } catch { /* preserve the original child outcome */ }
      process.stderr.write(`clean-development: simulator cleanup is pending (${error.message}); receipt: ${handle.file}\n`);
    }
  } else {
    try { recordCleanup(handle, "retained", "creation did not register a simulator UDID"); } catch { /* receipt from creation remains */ }
  }
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);

  if (childError) {
    if (childCode !== null) return childCode;
    if (interruption.signal) return signalExitCode(interruption.signal);
    throw childError;
  }
  if (childCode !== null) return childCode;
  return interruption.signal ? signalExitCode(interruption.signal) : 1;
}

/** Explicitly retry cleanup for one previously receipted run; never sweep other devices. */
export function cleanupXcodeTestRun(config, env, runId, { platform = process.platform } = {}) {
  if (platform !== "darwin") throw new Error("Xcode simulator test runs are available on macOS only");
  if (typeof runId !== "string" || !UUID.test(runId)) throw new Error("xcode test-cleanup requires one test-run UUID");
  const normalizedId = runId.toLowerCase();
  ensureOutsideProject(config, process.cwd());
  const root = ensureConfiguredRoot(config, env);
  const recordDirectory = path.join(root, "xcode", "test-run-records");
  directorySnapshot(recordDirectory, "Test-run receipt directory");
  const handle = receiptHandle(config, env, normalizedId);
  if (handle.record.cleanup?.status === "removed") return { runId: normalizedId, cleaned: true, alreadyClean: true, receipt: handle.file };
  const outcome = cleanupOwnedDevice(config, env, handle);
  return { runId: normalizedId, ...outcome, receipt: handle.file, simulator: handle.record.device?.udid ?? null };
}
