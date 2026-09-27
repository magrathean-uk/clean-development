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
import { activeWorkspaceIds, applyPrune, prunePlan, workspaceRecord } from "../src/state.js";
import { isolatedEnvironment } from "../scripts/harness-utils.mjs";

const cli = fileURLToPath(new URL("../bin/clean-development.js", import.meta.url));
function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "clean-development-inspection-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = isolatedEnvironment(root);
  const config = resolveConfig({ cwd: root, env, includeProject: false });
  const workspaceId = "inspection-deadbeef00";
  const build = path.join(config.buildRoot, workspaceId);
  const workspace = path.join(root, "source");
  fs.mkdirSync(build, { recursive: true });
  const marker = path.join(build, OWNERSHIP_MARKER);
  const value = { schemaVersion: 1, workspaceId, workspace, ownershipId: "inspection-owner", buildRoot: config.buildRoot,
    path: build, lastUsedAt: "2020-01-01T00:00:00.000Z", pinned: false };
  writeJsonAtomic(marker, { ...value, owner: "clean-development" });
  writeJsonAtomic(workspaceRecord(config, workspaceId).file, value);
  const leaseFile = path.join(config.locations.stateDir, "leases", `${process.pid}-${workspaceId}-00000000-0000-4000-8000-000000000000.json`);
  const lease = { schemaVersion: 1, wrapperPid: process.pid, pid: 2147483647, tool: "cargo", workspaceId, workspace, startedAt: "2020-01-01T00:00:00.000Z" };
  writeJsonAtomic(leaseFile, lease);
  return { root, env, config, workspaceId, build, marker, leaseFile, lease };
}

function snapshot(root) {
  return Object.fromEntries(fs.readdirSync(root, { withFileTypes: true }).map((entry) => {
    const file = path.join(root, entry.name);
    return [entry.name, entry.isSymbolicLink() ? { link: fs.readlinkSync(file) } : entry.isDirectory() ? snapshot(file) : fs.readFileSync(file).toString("base64")];
  }));
}

test("lease inspection and prune planning retain stale files byte-for-byte", (t) => {
  const item = fixture(t);
  const before = snapshot(item.root);
  t.mock.method(process, "kill", () => { throw Object.assign(new Error("absent"), { code: "ESRCH" }); });
  assert.equal(activeWorkspaceIds(item.config).size, 0);
  assert.equal(prunePlan(item.config)[0].reason, "eligible");
  assert.deepEqual(snapshot(item.root), before);
});

test("status and prune CLI previews do not delete stale leases", (t) => {
  const item = fixture(t);
  const before = snapshot(item.root);
  for (const args of [["status", "--json"], ["status", "--sizes", "--json"], ["prune", "--json"]]) {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: item.root, env: item.env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    JSON.parse(result.stdout);
    assert.deepEqual(snapshot(item.root), before);
  }
});

test("permission and unexpected process lookup errors keep a lease protected", async (t) => {
  const item = fixture(t);
  for (const code of ["EPERM", "EACCES", "EINVAL", "UNKNOWN"]) {
    const mocked = t.mock.method(process, "kill", () => { throw Object.assign(new Error("lookup failed"), { code }); });
    assert.ok(activeWorkspaceIds(item.config).has(item.workspaceId), code);
    assert.equal(prunePlan(item.config)[0].reason, "active");
    // Even a previously eligible plan must not bypass apply-time protection.
    const forged = { ...prunePlan(item.config)[0], eligible: true, reason: "eligible" };
    assert.deepEqual(await applyPrune(item.config, [forged]), []);
    mocked.mock.restore();
  }
  assert.ok(fs.existsSync(item.build));
});

test("a matching lease directory is uncertain, not proof that the workspace is idle", (t) => {
  const item = fixture(t);
  fs.unlinkSync(item.leaseFile);
  fs.mkdirSync(item.leaseFile);
  assert.ok(activeWorkspaceIds(item.config).has(item.workspaceId));
  assert.equal(prunePlan(item.config)[0].reason, "active");
});

test("a matching lease symlink is retained and blocks pruning without reading its target", (t) => {
  const item = fixture(t);
  fs.unlinkSync(item.leaseFile);
  const outside = path.join(item.root, "outside");
  fs.writeFileSync(outside, "do not read");
  try { fs.symlinkSync(outside, item.leaseFile); }
  catch (error) { if (error.code === "EPERM" && process.platform === "win32") return t.skip("symlink privilege required"); throw error; }
  const read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (file, ...args) => {
    assert.notEqual(String(file), item.leaseFile);
    return read(file, ...args);
  });
  assert.ok(activeWorkspaceIds(item.config).has(item.workspaceId));
  assert.equal(prunePlan(item.config)[0].reason, "active");
  assert.ok(fs.lstatSync(item.leaseFile).isSymbolicLink());
});

test("unreadable lease metadata is protected, but a concurrently removed lease is absent", (t) => {
  const item = fixture(t);
  const lstat = fs.lstatSync;
  for (const code of ["EACCES", "ENOENT"]) {
    const mocked = t.mock.method(fs, "lstatSync", (file, ...args) => {
      if (String(file) === item.leaseFile) throw Object.assign(new Error("fixture"), { code });
      return lstat(file, ...args);
    });
    assert.equal(activeWorkspaceIds(item.config).has(item.workspaceId), code !== "ENOENT");
    mocked.mock.restore();
  }
});

test("ownership inspection errors retain builds and allow the rest of a preview", async (t) => {
  const item = fixture(t);
  fs.unlinkSync(item.leaseFile);
  const lstat = fs.lstatSync;
  for (const code of ["EIO", "EACCES", "ENOENT"]) {
    const mocked = t.mock.method(fs, "lstatSync", (file, ...args) => {
      if (String(file) === item.marker) throw Object.assign(new Error("fixture"), { code });
      return lstat(file, ...args);
    });
    const plan = prunePlan(item.config);
    assert.equal(plan[0].reason, code === "ENOENT" ? "missing" : "unreadable");
    assert.equal(plan[0].eligible, false);
    assert.deepEqual(await applyPrune(item.config, plan), []);
    mocked.mock.restore();
  }
  assert.ok(fs.existsSync(item.build));
});

test("inspection cannot unlink a lease replaced during process lookup", (t) => {
  const item = fixture(t);
  t.mock.method(process, "kill", () => {
    writeJsonAtomic(item.leaseFile, { ...item.lease, pid: process.pid });
    throw Object.assign(new Error("old process is absent"), { code: "ESRCH" });
  });
  activeWorkspaceIds(item.config);
  assert.equal(JSON.parse(fs.readFileSync(item.leaseFile, "utf8")).pid, process.pid);
});
