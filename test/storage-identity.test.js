import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ensureOwnedBuildRoot, environmentForTool, OWNERSHIP_MARKER } from "../src/adapters.js";
import { resolveConfig } from "../src/config.js";
import { directoryIdentities, revalidateDirectoryIdentities, writeJsonAtomic } from "../src/io.js";
import { applySessionPlan, planSession } from "../src/session.js";
import { approveManagedBuildRoot, validateManagedBuildRoot } from "../src/storage-identity.js";
import { applyPrune, createLease, prunePlan, recordWorkspace, workspaceRecord } from "../src/state.js";
import { isolatedEnvironment } from "../scripts/harness-utils.mjs";
import { runTool } from "../src/runtime.js";

const CLI = fileURLToPath(new URL("../bin/clean-development.js", import.meta.url));

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "clean-development-storage-identity-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = isolatedEnvironment(root);
  const source = path.join(root, "source");
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "Cargo.toml"), '[package]\nname="identity"\nversion="0.0.0"\n');
  const config = resolveConfig({ cwd: source, env });
  for (const directory of [config.cacheRoot, config.buildRoot, config.scratchRoot]) fs.mkdirSync(directory, { recursive: true });
  const workspace = { id: "fixture-1234567890", root: source };
  return { root, env, source, config, workspace };
}

function receiptFile(item) {
  const directory = path.join(item.config.locations.stateDir, "storage-identities");
  return path.join(directory, fs.readdirSync(directory).find((name) => name.endsWith(".json")));
}

function replaceRoot(item) {
  fs.renameSync(item.config.buildRoot, path.join(item.root, "retired-builds"));
  fs.mkdirSync(item.config.buildRoot);
  fs.writeFileSync(path.join(item.config.buildRoot, "unregistered-sentinel"), "retained");
}

function seed(item) {
  const owned = ensureOwnedBuildRoot(item.config, item.workspace);
  const { record } = recordWorkspace(item.config, item.workspace, owned);
  return { owned, record };
}

test("first Cargo use binds storage outside disposable roots and unchanged builds retain approval", (t) => {
  const item = fixture(t);
  const { owned, record } = seed(item);
  const file = receiptFile(item);
  assert.ok(file.startsWith(`${item.config.locations.stateDir}${path.sep}`));
  const bytes = fs.readFileSync(file, "utf8");
  const receipt = JSON.parse(bytes);
  assert.equal(receipt.identity.path, item.config.buildRoot);
  assert.deepEqual(record.storageIdentity, receipt.identity);
  assert.deepEqual(ensureOwnedBuildRoot(item.config, item.workspace, record), owned);
  approveManagedBuildRoot(item.config, { reapprove: true });
  assert.equal(fs.readFileSync(file, "utf8"), bytes, "unchanged inspection/preparation keeps initial approval");
});

test("a replacement root stays refused across inspection, dispatch and ordinary session preparation", (t) => {
  const item = fixture(t);
  seed(item);
  const file = receiptFile(item), before = fs.readFileSync(file, "utf8");
  replaceRoot(item);
  assert.throws(() => validateManagedBuildRoot(item.config), { code: "CLEAN_DEVELOPMENT_STORAGE_CHANGED" });
  assert.throws(() => ensureOwnedBuildRoot(item.config, item.workspace), /identity changed/);
  const plan = planSession({ cwd: item.source, env: item.env, config: item.config });
  assert.throws(() => applySessionPlan(plan, "session-only", item.env), /identity changed/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.deepEqual(fs.readdirSync(item.config.buildRoot), ["unregistered-sentinel"]);
});

test("explicit preparation reapproves a replacement without claiming old builds or pruning siblings", async (t) => {
  const item = fixture(t);
  const { record } = seed(item);
  record.lastUsedAt = "2000-01-01T00:00:00.000Z";
  writeJsonAtomic(workspaceRecord(item.config, item.workspace.id).file, record);
  replaceRoot(item);
  const oldIdentity = record.storageIdentity;
  const approved = approveManagedBuildRoot(item.config, { reapprove: true });
  assert.notEqual(approved.identity.ino, oldIdentity.ino);
  const plan = prunePlan(item.config, { olderThanDays: 1 });
  assert.equal(plan[0].reason, "storage-changed");
  assert.deepEqual(await applyPrune(item.config, plan), []);
  const replacement = ensureOwnedBuildRoot(item.config, { id: "another-1234567890", root: item.source });
  assert.ok(fs.existsSync(replacement.path));
  assert.equal(fs.readFileSync(path.join(item.config.buildRoot, "unregistered-sentinel"), "utf8"), "retained");
  assert.ok(fs.existsSync(path.join(item.root, "retired-builds", item.workspace.id, OWNERSHIP_MARKER)));
});

test("active or uncertain Cargo leases block changed-storage reapproval", (t) => {
  const item = fixture(t);
  seed(item);
  const file = receiptFile(item), before = fs.readFileSync(file, "utf8");
  const lease = createLease(item.config, item.workspace, "cargo");
  replaceRoot(item);
  assert.throws(() => approveManagedBuildRoot(item.config, { reapprove: true }), /leases are active or uncertain/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  lease.release();
  approveManagedBuildRoot(item.config, { reapprove: true });
  assert.ok(validateManagedBuildRoot(item.config));
});

test("missing approved storage is not recreated by dispatch or ordinary session preparation", (t) => {
  const item = fixture(t);
  seed(item);
  fs.renameSync(item.config.buildRoot, path.join(item.root, "retired-builds"));
  assert.throws(() => ensureOwnedBuildRoot(item.config, item.workspace), /unavailable/);
  const plan = planSession({ cwd: item.source, env: item.env, config: item.config });
  assert.throws(() => applySessionPlan(plan, "session-only", item.env), /ENOENT/);
  assert.equal(fs.existsSync(item.config.buildRoot), false);
});

test("a remount identity change requires explicit preparation and preserves the configured path", (t) => {
  const item = fixture(t);
  const { record } = seed(item);
  const file = receiptFile(item), receipt = JSON.parse(fs.readFileSync(file));
  // Models a changed device ID without mounting anything on a contributor host.
  receipt.identity.dev = `${BigInt(receipt.identity.dev) + 1n}`;
  fs.writeFileSync(file, JSON.stringify(receipt));
  assert.throws(() => validateManagedBuildRoot(item.config), /identity changed/);
  const current = approveManagedBuildRoot(item.config, { reapprove: true });
  assert.equal(current.buildRoot, item.config.buildRoot);
  assert.notEqual(current.identity.dev, receipt.identity.dev);
  const approvedRemountRecord = { ...record, storageIdentity: receipt.identity };
  approvedRemountRecord.lastUsedAt = "2000-01-01T00:00:00.000Z";
  writeJsonAtomic(workspaceRecord(item.config, item.workspace.id).file, approvedRemountRecord);
  assert.equal(prunePlan(item.config, { olderThanDays: 1 })[0].reason, "storage-changed", "preparation alone cannot extend prior deletion authority");
  const owned = ensureOwnedBuildRoot(item.config, item.workspace, approvedRemountRecord);
  const refreshed = recordWorkspace(item.config, item.workspace, owned).record;
  assert.deepEqual(refreshed.storageIdentity, current.identity, "actual resumed routing binds only the exact marker/state pair");
});

test("matching legacy marker and workspace receipts migrate without broad directory adoption", (t) => {
  const item = fixture(t);
  const build = path.join(item.config.buildRoot, item.workspace.id), ownershipId = "legacy-owned";
  fs.mkdirSync(build);
  writeJsonAtomic(path.join(build, OWNERSHIP_MARKER), { schemaVersion: 1, owner: "clean-development",
    ownershipId, workspaceId: item.workspace.id, workspace: item.workspace.root });
  const record = { schemaVersion: 1, workspaceId: item.workspace.id, workspace: item.workspace.root,
    ownershipId, buildRoot: item.config.buildRoot, path: build, pinned: false, lastUsedAt: new Date().toISOString() };
  writeJsonAtomic(workspaceRecord(item.config, item.workspace.id).file, record);
  const sibling = path.join(item.config.buildRoot, "unregistered");
  fs.mkdirSync(sibling); fs.writeFileSync(path.join(sibling, "keep"), "retained");
  assert.deepEqual(ensureOwnedBuildRoot(item.config, item.workspace, record), { path: build, ownershipId });
  assert.ok(validateManagedBuildRoot(item.config));
  assert.equal(fs.readFileSync(path.join(sibling, "keep"), "utf8"), "retained");
});

test("legacy records without surviving ownership cannot silently bind replacement storage", (t) => {
  const item = fixture(t);
  const record = { schemaVersion: 1, workspaceId: item.workspace.id, workspace: item.workspace.root,
    ownershipId: "legacy-owned", buildRoot: item.config.buildRoot, path: path.join(item.config.buildRoot, item.workspace.id),
    pinned: false, lastUsedAt: new Date().toISOString() };
  writeJsonAtomic(workspaceRecord(item.config, item.workspace.id).file, record);
  assert.throws(() => ensureOwnedBuildRoot(item.config, { id: "new-1234567890", root: item.source }), /explicit preparation/);
  assert.deepEqual(fs.readdirSync(item.config.buildRoot), []);
  approveManagedBuildRoot(item.config, { reapprove: true });
  assert.ok(ensureOwnedBuildRoot(item.config, { id: "new-1234567890", root: item.source }));
});

test("a removed global receipt cannot adopt a changed root using a newer workspace record", (t) => {
  const item = fixture(t), { record } = seed(item), file = receiptFile(item);
  replaceRoot(item);
  const build = path.join(item.config.buildRoot, item.workspace.id);
  fs.cpSync(path.join(item.root, "retired-builds", item.workspace.id), build, { recursive: true });
  fs.unlinkSync(file);
  assert.throws(() => ensureOwnedBuildRoot(item.config, item.workspace, record), /without a matching state receipt/);
  assert.equal(validateManagedBuildRoot(item.config), null);
});

test("unregistered existing workspace directories are never adopted", (t) => {
  const item = fixture(t), build = path.join(item.config.buildRoot, item.workspace.id);
  fs.mkdirSync(build); fs.writeFileSync(path.join(build, "keep"), "retained");
  assert.throws(() => ensureOwnedBuildRoot(item.config, item.workspace));
  assert.equal(validateManagedBuildRoot(item.config), null);
  assert.equal(fs.readFileSync(path.join(build, "keep"), "utf8"), "retained");
});

test("corrupt identity receipts refuse dispatch and explicit prepare without being overwritten", (t) => {
  const item = fixture(t); seed(item);
  const file = receiptFile(item), bytes = '{"schemaVersion":2,"owner":"someone-else"}';
  fs.writeFileSync(file, bytes);
  assert.throws(() => ensureOwnedBuildRoot(item.config, item.workspace), /Invalid storage identity receipt/);
  assert.throws(() => approveManagedBuildRoot(item.config, { reapprove: true }), /Invalid storage identity receipt/);
  assert.equal(fs.readFileSync(file, "utf8"), bytes);
});

test("identity state inside managed storage is refused before creating metadata", (t) => {
  const item = fixture(t);
  item.config.locations = { ...item.config.locations, stateDir: path.join(item.config.buildRoot, "state") };
  assert.throws(() => ensureOwnedBuildRoot(item.config, item.workspace), /state must be outside managed storage/);
  assert.deepEqual(fs.readdirSync(item.config.buildRoot), []);
});

test("an independent Cargo target bypasses managed root ownership checks", (t) => {
  const item = fixture(t); seed(item); replaceRoot(item);
  const custom = path.join(item.root, "independent-target");
  const routed = environmentForTool("cargo", [], { config: item.config, cwd: item.source, env: { ...item.env, CARGO_TARGET_DIR: custom } });
  assert.equal(routed.env.CARGO_TARGET_DIR, custom);
  assert.equal(routed.ownedBuild, null);
});

test("publication snapshots reject a replaced ancestor even when the leaf inode survives", (t) => {
  const item = fixture(t);
  const snapshots = directoryIdentities(item.config.buildRoot);
  fs.renameSync(item.config.root, path.join(item.root, "retired-managed"));
  fs.mkdirSync(item.config.root);
  fs.renameSync(path.join(item.root, "retired-managed", "builds"), item.config.buildRoot);
  assert.throws(() => revalidateDirectoryIdentities(snapshots), /changed during publication/);
});

test("storage replaced while a workspace receipt publishes is rejected before returning routing authority", (t) => {
  const item = fixture(t), owned = ensureOwnedBuildRoot(item.config, item.workspace);
  const file = workspaceRecord(item.config, item.workspace.id).file;
  const rename = fs.renameSync;
  let fired = false;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (!fired && to === file) {
      fired = true;
      replaceRoot(item);
    }
    return rename(from, to);
  });
  assert.throws(() => recordWorkspace(item.config, item.workspace, owned), /changed during publication/);
  assert.equal(fired, true);
  assert.deepEqual(fs.readdirSync(item.config.buildRoot), ["unregistered-sentinel"]);
  assert.equal(prunePlan(item.config, { olderThanDays: 0 })[0].reason, "storage-changed");
});

test("a build directory replaced during marker publication cannot acquire a workspace record", (t) => {
  const item = fixture(t);
  const markerRename = fs.renameSync;
  let fired = false, temporary;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (!fired && to.endsWith(`${path.sep}${OWNERSHIP_MARKER}`)) {
      fired = true;
      temporary = path.dirname(to);
      markerRename(temporary, path.join(item.root, "retired-stage"));
      fs.mkdirSync(temporary);
    }
    return markerRename(from, to);
  });
  assert.throws(() => ensureOwnedBuildRoot(item.config, item.workspace), /ENOENT/);
  assert.equal(fired, true);
  assert.equal(workspaceRecord(item.config, item.workspace.id).value, null);
  assert.equal(fs.existsSync(path.join(item.config.buildRoot, item.workspace.id)), false);
  assert.ok(fs.existsSync(path.join(item.root, "retired-stage")));
  assert.deepEqual(fs.readdirSync(temporary), []);
});

test("CLI prepare previews without reapproval and explicitly repairs changed storage", (t) => {
  const item = fixture(t); seed(item);
  const file = receiptFile(item), before = fs.readFileSync(file, "utf8");
  replaceRoot(item);
  const preview = spawnSync(process.execPath, [CLI, "prepare", "--dry-run", "--json"], { cwd: item.source, env: item.env, encoding: "utf8" });
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).dryRun, true);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.throws(() => validateManagedBuildRoot(item.config), /identity changed/);
  const prepare = spawnSync(process.execPath, [CLI, "prepare", "--json"], { cwd: item.source, env: item.env, encoding: "utf8" });
  assert.equal(prepare.status, 0, prepare.stderr);
  assert.ok(validateManagedBuildRoot(item.config));
  assert.equal(fs.readFileSync(path.join(item.config.buildRoot, "unregistered-sentinel"), "utf8"), "retained");
});

test("storage replaced during a lease write prevents Cargo child execution and releases the lease", { skip: process.platform === "win32" ? "POSIX executable fixture; identity unit checks are portable" : false }, async (t) => {
  const item = fixture(t), tools = path.join(item.root, "tools"), capture = path.join(item.root, "child-ran");
  fs.mkdirSync(tools);
  fs.writeFileSync(path.join(tools, "cargo"), `#!${process.execPath}\nconst fs = require('node:fs');\nconst path = require('node:path');\nif (process.argv.includes('locate-project')) process.stdout.write(JSON.stringify({root:path.join(process.cwd(),'Cargo.toml')}));\nelse fs.writeFileSync(process.env.IDENTITY_CAPTURE, 'must not run');\n`, { mode: 0o700 });
  const rename = fs.renameSync;
  const leaseDirectory = path.join(item.config.locations.stateDir, "leases");
  let fired = false;
  t.mock.method(fs, "renameSync", (from, to) => {
    const result = rename(from, to);
    if (!fired && path.dirname(to) === leaseDirectory && to.endsWith(".json")) {
      fired = true;
      replaceRoot(item);
    }
    return result;
  });
  await assert.rejects(runTool("cargo", ["build"], { config: item.config, cwd: item.source,
    env: { ...item.env, PATH: tools, IDENTITY_CAPTURE: capture } }), { code: "CLEAN_DEVELOPMENT_STORAGE_CHANGED" });
  assert.equal(fired, true);
  assert.equal(fs.existsSync(capture), false);
  assert.deepEqual(fs.readdirSync(leaseDirectory), []);
  assert.deepEqual(fs.readdirSync(item.config.buildRoot), ["unregistered-sentinel"]);
});
