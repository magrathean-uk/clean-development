import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureOwnedBuildRoot } from "../src/adapters.js";
import { resolveConfig } from "../src/config.js";
import { recordWorkspace, workspaceRecord } from "../src/state.js";
import { isolatedNativeEnvironment } from "../scripts/harness-utils.mjs";
import { runTool } from "../src/runtime.js";

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "clean-development-receipt-loss-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "caller");
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "Cargo.toml"), '[package]\nname="caller"\nversion="0.0.0"\n');
  const env = isolatedNativeEnvironment(root);
  const config = resolveConfig({ cwd: source, env });
  for (const directory of [config.buildRoot, config.cacheRoot, config.scratchRoot]) fs.mkdirSync(directory, { recursive: true });
  return { root, source, env, config };
}

function storageReceipt(config) {
  const directory = path.join(config.locations.stateDir, "storage-identities");
  if (!fs.existsSync(directory)) return null;
  for (const name of fs.readdirSync(directory)) {
    const file = path.join(directory, name);
    if (JSON.parse(fs.readFileSync(file, "utf8")).buildRoot === path.resolve(config.buildRoot)) return file;
  }
  return null;
}

test("recordWorkspace refuses to drop a prior storage binding when its global receipt is missing", (t) => {
  const item = fixture(t);
  const workspace = { id: "bound-workspace-1234567890", root: item.source };
  const owned = ensureOwnedBuildRoot(item.config, workspace);
  recordWorkspace(item.config, workspace, owned);
  const recordFile = workspaceRecord(item.config, workspace.id).file;
  const originalRecord = fs.readFileSync(recordFile, "utf8");
  const receipt = storageReceipt(item.config);
  assert.ok(receipt);
  fs.unlinkSync(receipt);

  assert.throws(() => recordWorkspace(item.config, workspace, owned), /Cannot record build directory \(storage-changed\)/);
  assert.equal(fs.readFileSync(recordFile, "utf8"), originalRecord, "record remains byte-for-byte bound to the approved root");
  assert.equal(storageReceipt(item.config), null, "recording does not recreate a missing global receipt");
});

test("target-owner dispatch refuses a copied marker after its storage receipt is lost", { skip: process.platform === "win32" }, async (t) => {
  const item = fixture(t);
  const ownerSource = path.join(item.root, "owner");
  fs.mkdirSync(ownerSource);
  fs.writeFileSync(path.join(ownerSource, "Cargo.toml"), '[package]\nname="target-owner"\nversion="0.0.0"\n');
  const ownerWorkspace = { id: "target-owner-1234567890", root: ownerSource };
  const ownerConfig = { ...item.config, buildRoot: path.join(item.root, "owner-storage", "builds") };
  fs.mkdirSync(ownerConfig.buildRoot, { recursive: true });
  const owned = ensureOwnedBuildRoot(ownerConfig, ownerWorkspace);
  recordWorkspace(ownerConfig, ownerWorkspace, owned);
  const recordFile = workspaceRecord(ownerConfig, ownerWorkspace.id).file;
  const originalRecord = fs.readFileSync(recordFile, "utf8");
  const originalIdentity = JSON.parse(originalRecord).storageIdentity;
  const receipt = storageReceipt(ownerConfig);
  assert.ok(receipt);

  const retiredRoot = path.join(item.root, "retired-owner-storage");
  fs.renameSync(ownerConfig.buildRoot, retiredRoot);
  fs.mkdirSync(ownerConfig.buildRoot, { recursive: true });
  fs.cpSync(path.join(retiredRoot, ownerWorkspace.id), path.join(ownerConfig.buildRoot, ownerWorkspace.id), { recursive: true });
  fs.unlinkSync(receipt);

  const tools = path.join(item.root, "tools"), childCapture = path.join(item.root, "child-ran");
  fs.mkdirSync(tools);
  fs.writeFileSync(path.join(tools, "cargo"), `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');\nif(process.argv.includes('locate-project'))process.stdout.write(JSON.stringify({root:path.join(process.cwd(),'Cargo.toml')}));\nelse fs.writeFileSync(${JSON.stringify(childCapture)},'unexpected');\n`, { mode: 0o700 });

  await assert.rejects(runTool("cargo", ["build", "--target-dir", path.join(owned.path, "cargo", "target")], {
    config: item.config, cwd: item.source, env: { ...item.env, PATH: tools }
  }), /Cannot record build directory \(storage-changed\)/);

  assert.equal(fs.existsSync(childCapture), false, "target-owner Cargo child must not launch");
  assert.equal(fs.readFileSync(recordFile, "utf8"), originalRecord, "prior owner identity remains byte-for-byte unchanged");
  assert.deepEqual(JSON.parse(fs.readFileSync(recordFile, "utf8")).storageIdentity, originalIdentity);
  assert.equal(storageReceipt(ownerConfig), null, "ordinary target-owner dispatch must not recreate the receipt");
  const leases = path.join(item.config.locations.stateDir, "leases");
  assert.equal(fs.existsSync(leases) ? fs.readdirSync(leases).length : 0, 0, "refusal occurs before lease publication");
});
