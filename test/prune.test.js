import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveConfig } from "../src/config.js";
import { OWNERSHIP_MARKER } from "../src/adapters.js";
import { writeJsonAtomic } from "../src/io.js";
import { applyPrune, prunePlan, workspaceRecord } from "../src/state.js";
import { isolatedEnvironment } from "../scripts/harness-utils.mjs";

function fixture(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = resolveConfig({ cwd: root, env: isolatedEnvironment(root), includeProject: false });
  assert.equal(config.buildRoot, path.join(fs.realpathSync(root), "managed", "builds"));
  return { root, config };
}

test("prune removes only an old registered direct child of its recorded build root", async (t) => {
  const { root, config } = fixture(t, "clean-development-prune-");
  const workspacePath = path.join(config.buildRoot, "fixture-deadbeef00");
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.writeFileSync(path.join(workspacePath, "artifact"), "disposable");
  const ownershipId = "fixture-ownership-id";
  const workspace = path.join(root, "source");
  writeJsonAtomic(path.join(workspacePath, OWNERSHIP_MARKER), {
    schemaVersion: 1,
    owner: "clean-development",
    ownershipId,
    workspaceId: "fixture-deadbeef00",
    workspace
  });
  const recordFile = workspaceRecord(config, "fixture-deadbeef00", config.buildRoot).file;
  writeJsonAtomic(recordFile, {
    schemaVersion: 1,
    workspaceId: "fixture-deadbeef00",
    workspace,
    ownershipId,
    buildRoot: config.buildRoot,
    path: workspacePath,
    lastUsedAt: "2020-01-01T00:00:00.000Z",
    pinned: false
  });
  const external = path.join(root, "do-not-touch");
  fs.writeFileSync(external, "kept");

  const plan = prunePlan(config, { olderThanDays: 1 });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].eligible, true);
  assert.equal(fs.existsSync(workspacePath), true, "planning must not delete");
  assert.deepEqual(await applyPrune(config, [{ ...plan[0], pruneBefore: "not-a-date" }]), []);
  assert.equal(fs.existsSync(workspacePath), true, "an invalid age checkpoint must not delete");
  assert.deepEqual(await applyPrune(config, plan), [workspacePath]);
  assert.equal(fs.existsSync(workspacePath), false);
  assert.equal(fs.readFileSync(external, "utf8"), "kept");
});

test("unsafe registry paths are never eligible", (t) => {
  const { root, config } = fixture(t, "clean-development-prune-unsafe-");
  const recordFile = workspaceRecord(config, "unsafe", config.buildRoot).file;
  writeJsonAtomic(recordFile, {
    schemaVersion: 1,
    workspaceId: "unsafe",
    workspace: path.join(root, "source"),
    ownershipId: "unsafe-id",
    buildRoot: config.buildRoot,
    path: path.join(root, "outside"),
    lastUsedAt: "2020-01-01T00:00:00.000Z",
    pinned: false
  });
  const plan = prunePlan(config, { olderThanDays: 1 });
  assert.equal(plan[0].eligible, false);
  assert.equal(plan[0].reason, "unsafe-path");
});

test("a registered directory without the matching ownership marker is never eligible", async (t) => {
  const { root, config } = fixture(t, "clean-development-prune-unowned-");
  const workspacePath = path.join(config.buildRoot, "fixture-deadbeef00");
  fs.mkdirSync(workspacePath, { recursive: true });
  const recordFile = workspaceRecord(config, "fixture-deadbeef00", config.buildRoot).file;
  writeJsonAtomic(recordFile, {
    schemaVersion: 1,
    workspaceId: "fixture-deadbeef00",
    workspace: path.join(root, "source"),
    ownershipId: "not-present-on-disk",
    buildRoot: config.buildRoot,
    path: workspacePath,
    lastUsedAt: "2020-01-01T00:00:00.000Z",
    pinned: false
  });
  const plan = prunePlan(config, { olderThanDays: 1 });
  assert.equal(plan[0].reason, "unowned");
  assert.deepEqual(await applyPrune(config, plan), []);
  assert.equal(fs.existsSync(workspacePath), true);
});

test("a corrupt ownership marker is retained as unowned", async (t) => {
  const { root, config } = fixture(t, "clean-development-prune-corrupt-marker-");
  const workspaceId = "fixture-deadbeef00";
  const workspacePath = path.join(config.buildRoot, workspaceId);
  const workspace = path.join(root, "source");
  const ownershipId = "fixture-ownership-id";
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.writeFileSync(path.join(workspacePath, OWNERSHIP_MARKER), "{not valid json\n");
  writeJsonAtomic(workspaceRecord(config, workspaceId, config.buildRoot).file, {
    schemaVersion: 1,
    workspaceId,
    workspace,
    ownershipId,
    buildRoot: config.buildRoot,
    path: workspacePath,
    lastUsedAt: "2020-01-01T00:00:00.000Z",
    pinned: false
  });

  const plan = prunePlan(config, { olderThanDays: 1 });
  assert.equal(plan[0].reason, "unowned");
  assert.deepEqual(await applyPrune(config, plan), []);
  assert.equal(fs.existsSync(workspacePath), true);
});

test("a corrupt workspace receipt is ignored and retained", (t) => {
  const { root, config } = fixture(t, "clean-development-prune-corrupt-record-");
  const workspaceId = "fixture-deadbeef00";
  const workspacePath = path.join(config.buildRoot, workspaceId);
  const workspace = path.join(root, "source");
  fs.mkdirSync(workspacePath, { recursive: true });
  writeJsonAtomic(path.join(workspacePath, OWNERSHIP_MARKER), {
    schemaVersion: 1,
    owner: "clean-development",
    ownershipId: "fixture-ownership-id",
    workspaceId,
    workspace
  });
  const receipt = workspaceRecord(config, workspaceId, config.buildRoot).file;
  fs.mkdirSync(path.dirname(receipt), { recursive: true });
  fs.writeFileSync(receipt, "{not valid json\n");

  assert.deepEqual(prunePlan(config, { olderThanDays: 1 }), []);
  assert.equal(fs.existsSync(workspacePath), true);
});

test("a corrupt matching lease blocks pruning its workspace", async (t) => {
  const { root, config } = fixture(t, "clean-development-prune-corrupt-lease-");
  const workspaceId = "fixture-deadbeef00";
  const workspacePath = path.join(config.buildRoot, workspaceId);
  const workspace = path.join(root, "source");
  const ownershipId = "fixture-ownership-id";
  fs.mkdirSync(workspacePath, { recursive: true });
  writeJsonAtomic(path.join(workspacePath, OWNERSHIP_MARKER), {
    schemaVersion: 1,
    owner: "clean-development",
    ownershipId,
    workspaceId,
    workspace
  });
  writeJsonAtomic(workspaceRecord(config, workspaceId, config.buildRoot).file, {
    schemaVersion: 1,
    workspaceId,
    workspace,
    ownershipId,
    buildRoot: config.buildRoot,
    path: workspacePath,
    lastUsedAt: "2020-01-01T00:00:00.000Z",
    pinned: false
  });
  const leases = path.join(config.locations.stateDir, "leases");
  fs.mkdirSync(leases, { recursive: true });
  fs.writeFileSync(path.join(leases, `${process.pid}-${workspaceId}-00000000-0000-4000-8000-000000000000.json`), "{not valid json\n");

  const plan = prunePlan(config, { olderThanDays: 1 });
  assert.equal(plan[0].reason, "active");
  assert.deepEqual(await applyPrune(config, plan), []);
  assert.equal(fs.existsSync(workspacePath), true);
});
