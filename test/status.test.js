import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "../src/config.js";
import { OWNERSHIP_MARKER } from "../src/adapters.js";
import { writeJsonAtomic } from "../src/io.js";
import { measureDirectory } from "../src/measurement.js";
import { storageStatus, formatStorageStatus, parseByteSize } from "../src/status.js";
import { createLease, prunePlan, workspaceRecord } from "../src/state.js";
import { isolatedEnvironment } from "../scripts/harness-utils.mjs";

const cli = fileURLToPath(new URL("../bin/clean-development.js", import.meta.url));
function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "clean-development-status-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = isolatedEnvironment(root);
  const config = resolveConfig({ cwd: root, env, includeProject: false });
  for (const key of ["cacheRoot", "buildRoot", "scratchRoot"]) fs.mkdirSync(config[key], { recursive: true });
  return { root, env, config };
}
function owned(item, id, overrides = {}, config = item.config) {
  const build = path.join(config.buildRoot, id);
  fs.mkdirSync(build, { recursive: true });
  const value = { schemaVersion: 1, workspaceId: id, workspace: path.join(item.root, `source-${id}`), ownershipId: `owner-${id}`,
    buildRoot: config.buildRoot, path: build, lastUsedAt: "2020-01-01T00:00:00.000Z", pinned: false, ...overrides };
  writeJsonAtomic(path.join(build, OWNERSHIP_MARKER), { ...value, owner: "clean-development" });
  writeJsonAtomic(workspaceRecord(config, id).file, value);
  fs.writeFileSync(path.join(build, "artifact"), "x".repeat(50));
  return value;
}
function snapshot(root) {
  return Object.fromEntries(fs.readdirSync(root, { withFileTypes: true }).map((entry) => {
    const file = path.join(root, entry.name);
    return [entry.name, entry.isDirectory() ? snapshot(file) : fs.readFileSync(file).toString("base64")];
  }));
}

test("workspace report uses pruning eligibility while retaining pin and activity details", (t) => {
  const item = fixture(t);
  owned(item, "old-a"); owned(item, "pinned-a", { pinned: true });
  owned(item, "recent-a", { lastUsedAt: new Date().toISOString() });
  const live = owned(item, "live-a");
  const lease = createLease(item.config, { id: live.workspaceId, root: live.workspace }, "cargo");
  t.after(() => lease.release());
  // Register cleanup after lease release, rather than deleting its directory first.
  const report = storageStatus(item.config, { workspaces: true, env: item.env });
  const reasons = Object.fromEntries(report.workspaceDetails.map((entry) => [entry.workspaceId, entry.reason]));
  assert.deepEqual(reasons, Object.fromEntries(prunePlan(item.config).map((entry) => [entry.workspaceId, entry.reason])));
  assert.equal(reasons["old-a"], "eligible"); assert.equal(reasons["pinned-a"], "pinned");
  assert.equal(reasons["live-a"], "active"); assert.equal(reasons["recent-a"], "recent");
  assert.equal(report.workspaceDetails.find((entry) => entry.workspaceId === "live-a").activeOrUncertain, true);
  assert.ok(report.workspaceDetails.every((entry) => entry.size.status === "not-measured"));
  lease.release();
});

test("default status retains legacy fields and never traverses artifact directories", (t) => {
  const item = fixture(t); owned(item, "old-a");
  t.mock.method(fs, "opendirSync", () => assert.fail("sizes were not requested"));
  const report = storageStatus(item.config, { env: item.env });
  assert.equal(report.workspaces, 1); assert.equal(report.schemaVersion, 1);
  assert.equal(report.bytes, undefined); assert.equal(report.workspaceDetails, undefined);
  assert.equal(report.root, item.config.root); assert.ok(Array.isArray(report.activeWorkspaces));
});

test("advisory budgets measure registered builds without changing pins, age or files", (t) => {
  const item = fixture(t);
  const a = owned(item, "old-a"); const b = owned(item, "pinned-b", { pinned: true });
  fs.writeFileSync(path.join(item.config.buildRoot, "unregistered"), "x".repeat(4096));
  const before = snapshot(item.root);
  const report = storageStatus(item.config, { buildBudgetBytes: 1, env: item.env });
  const expected = measureDirectory(a.path).logicalBytes + measureDirectory(b.path).logicalBytes;
  assert.equal(report.registeredBuilds.observedLogicalBytes, expected);
  assert.equal(report.eligibleBuilds.observedLogicalBytes, measureDirectory(a.path).logicalBytes);
  assert.equal(report.buildBudget.status, "over"); assert.equal(report.buildBudget.overByBytes, expected - 1);
  assert.equal(report.buildBudget.advisoryOnly, true); assert.equal(report.buildBudget.retentionUnchanged, true);
  assert.equal(report.eligibleBuilds.reclaimableBytes, null);
  assert.equal(report.bytes.builds, expected + 4096);
  assert.deepEqual(snapshot(item.root), before);
  assert.equal(storageStatus(item.config, { buildBudgetBytes: expected, env: item.env }).buildBudget.status, "within");
});

test("unsafe, unowned, malformed-age and different-root records are not scanned", (t) => {
  const item = fixture(t);
  const outside = path.join(item.root, "outside"); fs.mkdirSync(outside);
  const unsafe = owned(item, "unsafe", { path: outside });
  const unowned = owned(item, "unowned"); fs.unlinkSync(path.join(unowned.path, OWNERSHIP_MARKER));
  owned(item, "bad-date", { lastUsedAt: "invalid-date" });
  const otherConfig = { ...item.config, buildRoot: path.join(item.root, "other-builds") };
  owned(item, "elsewhere", {}, otherConfig);
  const open = fs.opendirSync;
  t.mock.method(fs, "opendirSync", (file, ...args) => {
    assert.notEqual(String(file), outside);
    assert.ok(!String(file).startsWith(otherConfig.buildRoot));
    return open(file, ...args);
  });
  const report = storageStatus(item.config, { workspaces: true, buildBudgetBytes: 1000, env: item.env });
  assert.equal(report.workspaces, 4);
  assert.equal(report.workspaceDetails.find((row) => row.workspaceId === unsafe.workspaceId).reason, "unsafe-path");
  assert.ok(report.workspaceDetails.every((row) => row.size.status === "not-measured"));
  assert.equal(report.registeredBuilds.entries, 3);
  assert.equal(report.registeredBuilds.status, "partial");
  assert.equal(report.buildBudget.status, "unknown");
  assert.equal(report.buildBudget.overByBytes, null);
});

test("incomplete scans expose observed bytes but legacy totals and budget verdict stay unknown", (t) => {
  const item = fixture(t); owned(item, "old-a");
  const report = storageStatus(item.config, { buildBudgetBytes: 10, maxEntries: 0, env: item.env });
  assert.equal(report.buildBudget.status, "unknown");
  assert.equal(report.workspaceDetails[0].size.status, "partial");
  assert.equal(report.registeredBuilds.observedLogicalBytes, 0);
  assert.deepEqual(report.bytes, { caches: null, builds: null, scratch: null });
  assert.equal(report.sizeMeasurements.builds.status, "partial");
});

test("missing storage is unknown rather than zero and remains missing", (t) => {
  const item = fixture(t);
  fs.rmSync(item.config.cacheRoot, { recursive: true });
  const report = storageStatus(item.config, { sizes: true, env: item.env });
  assert.equal(report.bytes.caches, null); assert.equal(report.sizeMeasurements.caches.status, "missing");
  assert.equal(report.bytes.builds, 0); assert.equal(fs.existsSync(item.config.cacheRoot), false);
});

test("empty registered scope has a zero budget total without counting unregistered storage", (t) => {
  const item = fixture(t);
  fs.writeFileSync(path.join(item.config.buildRoot, "not-owned"), "data");
  const report = storageStatus(item.config, { buildBudgetBytes: 0, env: item.env });
  assert.equal(report.registeredBuilds.observedLogicalBytes, 0);
  assert.equal(report.buildBudget.status, "within"); assert.equal(report.bytes.builds, 4);
  assert.match(report.workspaceScope, /valid registered/);
});

test("human output escapes terminal control characters in stored paths and names", (t) => {
  const item = fixture(t); owned(item, "old-a");
  const report = storageStatus(item.config, { workspaces: true, env: item.env });
  report.workspaceDetails[0].workspace = "hostile\n\u001b[2J\u202eabc";
  report.workspaceDetails[0].workspaceId = "bad\tname";
  const text = formatStorageStatus(report);
  assert.doesNotMatch(text, /\u001b|\u202e/);
  assert.match(text, /hostile\\n\\u001b\[2J\\u202eabc/);
  assert.match(text, /bad\\tname/);
  assert.match(text, /Nothing changed/);
});

test("budget parsing distinguishes decimal and binary units with exact integer checks", () => {
  for (const [input, expected] of [["0", 0], ["2", 2], ["1KB", 1000], ["1KiB", 1024], ["20GB", 20e9], ["20GiB", 20 * 1024 ** 3], ["1tb", 1e12]]) {
    assert.equal(parseByteSize(input), expected);
  }
  for (const input of ["-1", "1.5GB", "1e3", "1 GB", "Infinity", "1G", "9007199254740992", "999999999999999TiB"]) assert.throws(() => parseByteSize(input), /budget/i);
});

test("invalid API options fail before scanning", (t) => {
  const item = fixture(t);
  t.mock.method(fs, "opendirSync", () => assert.fail("invalid options must not scan"));
  for (const value of [-1, Infinity, NaN, "2", 0.5]) assert.throws(() => storageStatus(item.config, { buildBudgetBytes: value }), /safe integer/);
  assert.throws(() => storageStatus(item.config, { maxEntries: 1 }), /require --sizes/);
  assert.throws(() => storageStatus(item.config, { sizes: true, maxDurationMs: -1 }), /safe integer/);
});

test("CLI provides additive JSON and opt-in readable workspace output with no writes", (t) => {
  const item = fixture(t); owned(item, "old-a"); const before = snapshot(item.root);
  const invoke = (args) => spawnSync(process.execPath, [cli, "status", ...args], { cwd: item.root, env: item.env, encoding: "utf8" });
  for (const args of [[], ["--sizes"], ["--workspaces", "--json"], ["--build-budget", "1KiB", "--json"]]) {
    const result = invoke(args); assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).schemaVersion, 1);
  }
  const text = invoke(["--workspaces", "--sizes"]);
  assert.equal(text.status, 0, text.stderr); assert.match(text.stdout, /old-a/); assert.match(text.stdout, /actual reclaimable space unknown/);
  const limited = invoke(["--build-budget", "1", "--max-scan-entries", "0", "--max-scan-ms", "10", "--json"]);
  assert.equal(limited.status, 0, limited.stderr); assert.equal(JSON.parse(limited.stdout).buildBudget.status, "unknown");
  for (const args of [["--build-budget", "-1"], ["--max-scan-ms", "1"], ["--sizes", "--max-scan-entries", "1.5"], ["--apply"], ["--sizes=false"]]) {
    assert.notEqual(invoke(args).status, 0, args.join(" "));
  }
  assert.deepEqual(snapshot(item.root), before);
});
