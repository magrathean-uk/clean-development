import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ensureOwnedBuildRoot } from "../src/adapters.js";
import { resolveConfig } from "../src/config.js";
import { acquireDirectoryLock } from "../src/io.js";
import { recordWorkspace, workspaceRecord } from "../src/state.js";
import { isolatedEnvironment } from "../scripts/harness-utils.mjs";

const CLI = fileURLToPath(new URL("../bin/clean-development.js", import.meta.url));

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "clean-development-doctor-health-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = isolatedEnvironment(root);
  const source = path.join(root, "source");
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "Cargo.toml"), '[package]\nname="doctor-health"\nversion="0.0.0"\n');
  const installed = spawnSync(process.execPath, [CLI, "setup", "--root", path.join(root, "managed"), "--agents", "claude"], {
    cwd: source, env, encoding: "utf8"
  });
  assert.equal(installed.status, 0, installed.stderr);
  return { root, source, env, config: resolveConfig({ cwd: source, env }) };
}

function doctor(item) {
  const result = spawnSync(process.execPath, [CLI, "doctor", "--json"], { cwd: item.source, env: item.env, encoding: "utf8" });
  return { status: result.status, report: JSON.parse(result.stdout), stderr: result.stderr };
}

function snapshot(root) {
  const rows = [];
  const visit = (directory) => {
    const entries = fs.readdirSync(directory).sort();
    for (const name of entries) {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file, { bigint: true });
      const row = { path: path.relative(root, file), mode: String(stat.mode), dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size), mtimeNs: String(stat.mtimeNs) };
      if (stat.isSymbolicLink()) row.link = fs.readlinkSync(file);
      else if (stat.isFile()) row.sha256 = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      rows.push(row);
      if (stat.isDirectory() && !stat.isSymbolicLink()) visit(file);
    }
  };
  visit(root);
  return rows;
}

function identityReceipt(config) {
  const directory = path.join(config.locations.stateDir, "storage-identities");
  return fs.readdirSync(directory).filter((name) => name.endsWith(".json")).map((name) => path.join(directory, name))
    .find((file) => JSON.parse(fs.readFileSync(file, "utf8")).buildRoot === path.resolve(config.buildRoot));
}

test("doctor flags a missing global identity receipt while workspace records remain bound and writes nothing", (t) => {
  const item = fixture(t);
  const workspace = { id: "doctor-bound-1234567890", root: item.source };
  const owned = ensureOwnedBuildRoot(item.config, workspace);
  const { record } = recordWorkspace(item.config, workspace, owned);
  assert.ok(record.storageIdentity);
  const receipt = identityReceipt(item.config);
  assert.ok(receipt);
  fs.unlinkSync(receipt);

  const before = snapshot(item.root);
  const result = doctor(item);
  const after = snapshot(item.root);
  const check = result.report.checks.find((entry) => entry.name === "storage-identity");
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.report.ok, false);
  assert.equal(check.status, "missing");
  assert.equal(check.ok, false);
  assert.match(check.detail, /workspace record\(s\) remain bound/);
  assert.deepEqual(after, before, "doctor must not recreate the missing receipt or write elsewhere in the fixture");
  assert.equal(fs.existsSync(receipt), false);
});

test("doctor rejects a corrupt global receipt while same-root workspace records remain bound", (t) => {
  const item = fixture(t);
  const workspace = { id: "doctor-corrupt-1234567890", root: item.source };
  const owned = ensureOwnedBuildRoot(item.config, workspace);
  recordWorkspace(item.config, workspace, owned);
  const receipt = identityReceipt(item.config);
  assert.ok(receipt);
  const bytes = '{"receiptSecret":"DO_NOT_ECHO"}\n';
  fs.writeFileSync(receipt, bytes);
  const before = snapshot(item.root);
  const result = doctor(item);
  const check = result.report.checks.find((entry) => entry.name === "storage-identity");
  assert.equal(result.status, 1, result.stderr);
  assert.equal(check.status, "invalid");
  assert.equal(check.ok, false);
  assert.ok(!JSON.stringify(result.report).includes("DO_NOT_ECHO"));
  assert.deepEqual(snapshot(item.root), before);
  assert.equal(fs.readFileSync(receipt, "utf8"), bytes);
});

test("doctor keeps legitimate unbound legacy storage healthy when no workspace record has an identity", (t) => {
  const item = fixture(t);
  const receipt = identityReceipt(item.config);
  if (receipt) fs.unlinkSync(receipt);
  const result = doctor(item);
  const check = result.report.checks.find((entry) => entry.name === "storage-identity");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(check.status, "unbound");
  assert.equal(check.ok, true);
});

test("doctor treats an unreadable workspace collection as uncertain instead of certifying it unbound", (t) => {
  const item = fixture(t);
  const directory = path.join(item.config.locations.stateDir, "workspaces");
  fs.mkdirSync(directory, { recursive: true });
  const corrupt = path.join(directory, "unreadable.json");
  fs.writeFileSync(corrupt, `${JSON.stringify({ schemaVersion: 1, buildRoot: item.config.buildRoot })}\n`);
  const receipt = identityReceipt(item.config);
  if (receipt) fs.unlinkSync(receipt);
  const before = snapshot(item.root);
  const result = doctor(item);
  const check = result.report.checks.find((entry) => entry.name === "storage-identity");
  assert.equal(result.status, 1, result.stderr);
  assert.equal(check.status, "uncertain");
  assert.equal(check.ok, false);
  assert.match(check.detail, /cannot be verified/);
  assert.deepEqual(snapshot(item.root), before);
});

test("doctor sanitizes malformed workspace receipt details and preserves the corrupt bytes", (t) => {
  const item = fixture(t);
  const directory = path.join(item.config.locations.stateDir, "workspaces");
  fs.mkdirSync(directory, { recursive: true });
  const corrupt = path.join(directory, "corrupt.json");
  const bytes = '{"privateMarker":"DO_NOT_ECHO",';
  fs.writeFileSync(corrupt, bytes);
  const identity = identityReceipt(item.config);
  if (identity) fs.unlinkSync(identity);
  const before = snapshot(item.root);
  const result = doctor(item);
  const check = result.report.checks.find((entry) => entry.name === "storage-identity");
  assert.equal(result.status, 1, result.stderr);
  assert.equal(check.status, "uncertain");
  assert.ok(!JSON.stringify(result.report).includes("DO_NOT_ECHO"));
  assert.deepEqual(snapshot(item.root), before);
  assert.equal(fs.readFileSync(corrupt, "utf8"), bytes);
});

test("doctor stops at its workspace collection entry bound", (t) => {
  const item = fixture(t);
  const directory = path.join(item.config.locations.stateDir, "workspaces");
  fs.mkdirSync(directory, { recursive: true });
  const legacy = `${JSON.stringify({ schemaVersion: 1, workspaceId: "legacy", workspace: item.source,
    ownershipId: "legacy", buildRoot: item.config.buildRoot, path: path.join(item.config.buildRoot, "legacy"),
    lastUsedAt: new Date().toISOString(), pinned: false })}\n`;
  for (let index = 0; index < 4097; index += 1) fs.writeFileSync(path.join(directory, `entry-${index}.json`), legacy);
  const identity = identityReceipt(item.config);
  if (identity) fs.unlinkSync(identity);
  const result = doctor(item);
  const check = result.report.checks.find((entry) => entry.name === "storage-identity");
  assert.equal(result.status, 1, result.stderr);
  assert.equal(check.status, "uncertain");
  assert.match(check.detail, /4096-entry diagnostic limit/);
  assert.equal(fs.readdirSync(directory).length, 4097, "doctor must not change the collection");
});

test("doctor reports a live setup lock as active and healthy", async (t) => {
  const item = fixture(t);
  const lock = path.join(item.config.locations.stateDir, "setup.lock");
  const release = await acquireDirectoryLock(lock);
  try {
    const result = doctor(item);
    const check = result.report.checks.find((entry) => entry.name === "lifecycle-locks");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(check.ok, true);
    assert.equal(check.locks.find((entry) => entry.name === "setup.lock").status, "active");
  } finally { release(); }
});

test("doctor exposes a present removal guard as uncertain without treating a live lock as unhealthy", async (t) => {
  const item = fixture(t);
  const lock = path.join(item.config.locations.stateDir, "setup.lock");
  const release = await acquireDirectoryLock(lock);
  const guard = `${lock}.removal-guard`;
  fs.mkdirSync(guard);
  try {
    const result = doctor(item);
    const check = result.report.checks.find((entry) => entry.name === "lifecycle-locks");
    const lockState = check.locks.find((entry) => entry.name === "setup.lock");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(check.ok, true);
    assert.equal(lockState.status, "uncertain");
    assert.match(lockState.detail, /valid live lock/);
    assert.equal(fs.existsSync(guard), true);
  } finally {
    fs.rmdirSync(guard);
    release();
  }
});

test("doctor reports retained removal guards without changing their path or contents", (t) => {
  const item = fixture(t);
  const guard = path.join(item.config.locations.stateDir, "runtime.lock.removal-guard");
  fs.mkdirSync(guard);
  fs.writeFileSync(path.join(guard, "keep.txt"), "retained evidence\n");
  const before = snapshot(item.root);
  const result = doctor(item);
  const check = result.report.checks.find((entry) => entry.name === "lifecycle-locks");
  const guardState = check.locks.find((entry) => entry.name === "runtime.lock");
  assert.equal(result.status, 1, result.stderr);
  assert.equal(check.ok, false);
  assert.equal(guardState.status, "uncertain");
  assert.match(guardState.detail, /Removal guard/);
  assert.deepEqual(snapshot(item.root), before);
  assert.equal(fs.readFileSync(path.join(guard, "keep.txt"), "utf8"), "retained evidence\n");
});

test("doctor reports an empty guard beside a dead lock as uncertain and retains both paths", (t) => {
  const item = fixture(t);
  const lock = path.join(item.config.locations.stateDir, "setup.lock");
  const guard = `${lock}.removal-guard`;
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "owner.json"), `${JSON.stringify({ schemaVersion: 1, token: "stale", pid: 2_147_483_647, acquiredAt: "2020-01-01T00:00:00.000Z" })}\n`);
  fs.mkdirSync(guard);
  const before = snapshot(item.root);
  const result = doctor(item);
  const check = result.report.checks.find((entry) => entry.name === "lifecycle-locks");
  const state = check.locks.find((entry) => entry.name === "setup.lock");
  assert.equal(result.status, 1, result.stderr);
  assert.equal(state.status, "uncertain");
  assert.match(state.detail, /retained evidence or an interrupted removal/);
  assert.deepEqual(snapshot(item.root), before);
});

test("doctor reports malformed lock state as uncertain without repairing it", (t) => {
  const item = fixture(t);
  const directory = path.join(item.config.locations.stateDir, "runtime.lock");
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "owner.json"), "not json\n");
  const before = snapshot(item.root);
  const result = doctor(item);
  const check = result.report.checks.find((entry) => entry.name === "lifecycle-locks");
  assert.equal(result.status, 1, result.stderr);
  assert.equal(check.locks.find((entry) => entry.name === "runtime.lock").status, "uncertain");
  assert.deepEqual(snapshot(item.root), before);
  assert.equal(fs.readFileSync(path.join(directory, "owner.json"), "utf8"), "not json\n");
});

test("doctor bounds lock owner reads and preserves oversized owner data", (t) => {
  const item = fixture(t);
  const directory = path.join(item.config.locations.stateDir, "runtime.lock");
  fs.mkdirSync(directory);
  const owner = path.join(directory, "owner.json");
  const bytes = `DO_NOT_ECHO${"x".repeat(20 * 1024)}`;
  fs.writeFileSync(owner, bytes);
  const before = snapshot(item.root);
  const result = doctor(item);
  const check = result.report.checks.find((entry) => entry.name === "lifecycle-locks");
  assert.equal(result.status, 1, result.stderr);
  assert.equal(check.locks.find((entry) => entry.name === "runtime.lock").status, "uncertain");
  assert.ok(!JSON.stringify(result.report).includes("DO_NOT_ECHO"));
  assert.deepEqual(snapshot(item.root), before);
  assert.equal(fs.readFileSync(owner, "utf8"), bytes);
});

test("doctor reports a symlinked lock owner without following or changing its target", { skip: process.platform === "win32" }, (t) => {
  const item = fixture(t);
  const directory = path.join(item.config.locations.stateDir, "runtime.lock");
  fs.mkdirSync(directory);
  const target = path.join(item.root, "owner-target.json");
  const targetBytes = `${JSON.stringify({ schemaVersion: 1, token: "target", pid: process.pid, acquiredAt: new Date().toISOString() })}\n`;
  fs.writeFileSync(target, targetBytes);
  fs.symlinkSync(target, path.join(directory, "owner.json"));
  const before = snapshot(item.root);
  const result = doctor(item);
  const check = result.report.checks.find((entry) => entry.name === "lifecycle-locks");
  assert.equal(result.status, 1, result.stderr);
  assert.equal(check.locks.find((entry) => entry.name === "runtime.lock").status, "uncertain");
  assert.deepEqual(snapshot(item.root), before);
  assert.equal(fs.readFileSync(target, "utf8"), targetBytes);
});
