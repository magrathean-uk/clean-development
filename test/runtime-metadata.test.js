import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveConfig } from "../src/config.js";
import { ensureRuntime, runTool, runtimeHealth } from "../src/runtime.js";
import { isolatedEnvironment } from "../scripts/harness-utils.mjs";

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "clean-development-metadata-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = resolveConfig({ cwd: root, env: isolatedEnvironment(root, {}), includeProject: false });
  const runtime = ensureRuntime(config);
  const receiptFile = path.join(config.locations.stateDir, "runtime.json");
  return { root, config, runtime, receiptFile, receipt: JSON.parse(fs.readFileSync(receiptFile, "utf8")) };
}

test("unchanged runtime verification preserves receipt identity, initial time, bytes and mtime", (t) => {
  const item = fixture(t), original = fs.readFileSync(item.receiptFile, "utf8");
  const earlier = new Date("2025-01-02T03:04:05.000Z");
  fs.utimesSync(item.receiptFile, earlier, earlier);
  const before = fs.statSync(item.receiptFile);
  const write = t.mock.method(fs, "renameSync");
  for (const options of [{}, { automatic: true }]) ensureRuntime(item.config, options);
  assert.equal(fs.readFileSync(item.receiptFile, "utf8"), original);
  assert.equal(fs.statSync(item.receiptFile).mtimeMs, before.mtimeMs);
  assert.equal(write.mock.calls.some((call) => call.arguments[1] === item.receiptFile), false);
  assert.equal(runtimeHealth(item.config).ok, true);
});

test("an unchanged legacy receipt is not rewritten just to add an update date or normalize key order", (t) => {
  const item = fixture(t);
  const legacy = Object.fromEntries(Object.entries(item.receipt).filter(([key]) => key !== "updatedAt").reverse());
  const original = JSON.stringify(legacy);
  fs.writeFileSync(item.receiptFile, original);
  ensureRuntime(item.config);
  assert.equal(fs.readFileSync(item.receiptFile, "utf8"), original);
});

test("receipt content refresh preserves initial installation time and records a separate update time", (t) => {
  const item = fixture(t), installedAt = "2025-01-02T03:04:05.000Z";
  fs.writeFileSync(item.receiptFile, JSON.stringify({ ...item.receipt, installedAt, updatedAt: installedAt, source: path.join(item.root, "previous-package") }));
  ensureRuntime(item.config);
  const updated = JSON.parse(fs.readFileSync(item.receiptFile, "utf8"));
  assert.equal(updated.installationId, item.receipt.installationId);
  assert.equal(updated.installedAt, installedAt);
  assert.notEqual(updated.updatedAt, installedAt);
  assert.equal(Number.isNaN(Date.parse(updated.updatedAt)), false);
  const original = fs.readFileSync(item.receiptFile, "utf8");
  ensureRuntime(item.config);
  assert.equal(fs.readFileSync(item.receiptFile, "utf8"), original);
});

test("missing legacy install time is recovered from the owned runtime marker", (t) => {
  const item = fixture(t), receipt = { ...item.receipt };
  delete receipt.installedAt; delete receipt.updatedAt;
  fs.writeFileSync(item.receiptFile, JSON.stringify(receipt));
  const marker = JSON.parse(fs.readFileSync(path.join(item.runtime.versionRoot, ".clean-development-runtime.json"), "utf8"));
  ensureRuntime(item.config);
  const recovered = JSON.parse(fs.readFileSync(item.receiptFile, "utf8"));
  assert.equal(recovered.installationId, receipt.installationId);
  assert.equal(recovered.installedAt, marker.createdAt);
});

test("failed dispatch retains its storage error when lease and lock cleanup also fail", { skip: process.platform === "win32" }, async (t) => {
  const item = fixture(t), project = path.join(item.root, "project"), tools = path.join(item.root, "tools"), capture = path.join(item.root, "child-ran");
  fs.mkdirSync(project); fs.mkdirSync(tools);
  fs.writeFileSync(path.join(project, "Cargo.toml"), '[package]\nname="metadata"\nversion="0.0.0"\n');
  fs.writeFileSync(path.join(tools, "cargo"), `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');\nif(process.argv.includes('locate-project'))process.stdout.write(JSON.stringify({root:path.join(process.cwd(),'Cargo.toml')}));\nelse fs.writeFileSync(process.env.CAPTURE,'must not run');\n`, { mode: 0o700 });
  const env = { ...isolatedEnvironment(item.root), PATH: tools, CAPTURE: capture };
  const config = resolveConfig({ cwd: project, env });
  for (const directory of [config.cacheRoot, config.buildRoot, config.scratchRoot]) fs.mkdirSync(directory, { recursive: true });
  const leaseDirectory = path.join(config.locations.stateDir, "leases"), rename = fs.renameSync, unlink = fs.unlinkSync, rmdir = fs.rmdirSync;
  let replaced = false;
  const mocks = [
    t.mock.method(fs, "renameSync", (from, to) => {
      const result = rename(from, to);
      if (!replaced && path.dirname(to) === leaseDirectory && to.endsWith(".json")) {
        replaced = true; rename(config.buildRoot, path.join(item.root, "retired-builds")); fs.mkdirSync(config.buildRoot);
      }
      return result;
    }),
    t.mock.method(fs, "unlinkSync", (file) => {
      if (replaced && path.dirname(file) === leaseDirectory) throw Object.assign(new Error("private-cleanup-content"), { code: "EACCES" });
      return unlink(file);
    }),
    t.mock.method(fs, "rmdirSync", (file) => {
      if (replaced && file.endsWith(".lock")) throw Object.assign(new Error("private-lock-content"), { code: "invalid private code" });
      return rmdir(file);
    })
  ];
  try {
    await assert.rejects(runTool("cargo", ["build"], { config, cwd: project, env }), (error) => {
      assert.equal(error.code, "CLEAN_DEVELOPMENT_STORAGE_CHANGED");
      assert.match(error.stack, /Managed build root identity changed/);
      assert.deepEqual(error.cleanupFailures, [{ stage: "lease", code: "EACCES" }, { stage: "workspace-lock", code: "LOCK_RETAINED" }]);
      assert.equal(error.cleanupFailureCount, 2);
      assert.equal(JSON.stringify(error).includes("private-"), false);
      return true;
    });
    assert.equal(replaced, true); assert.equal(fs.existsSync(capture), false);
    assert.equal(fs.readdirSync(leaseDirectory).length, 1, "uncertain lease remains as protective recovery state");
  } finally { for (const mocked of mocks) mocked.mock.restore(); }
});
