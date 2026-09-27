import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveConfig } from "../src/config.js";
import { activeWorkspaceIds, inspectWorkspaceLeases, prunePlan } from "../src/state.js";
import { isolatedEnvironment } from "../scripts/harness-utils.mjs";

const cli = fileURLToPath(new URL("../bin/clean-development.js", import.meta.url));
function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "clean-development-leases-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = isolatedEnvironment(root);
  const config = resolveConfig({ cwd: root, env, includeProject: false });
  const directory = path.join(config.locations.stateDir, "leases");
  fs.mkdirSync(directory, { recursive: true });
  function lease(id = "fixture-abcdef", pid = process.pid, value = {}) {
    const file = path.join(directory, `${process.pid}-${id}-${crypto.randomUUID()}.json`);
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, pid, wrapperPid: process.pid,
      tool: "cargo", workspaceId: id, workspace: path.join(root, "source"),
      startedAt: new Date().toISOString(), ...value }));
    return file;
  }
  return { root, config, env, directory, lease };
}
function stateSnapshot(directory) {
  return fs.readdirSync(directory).sort().map((name) => {
    const file = path.join(directory, name);
    const stat = fs.lstatSync(file);
    return [name, stat.mode, stat.mtimeMs, stat.isFile() ? fs.readFileSync(file).toString("base64")
      : stat.isSymbolicLink() ? fs.readlinkSync(file) : "directory"];
  });
}

test("lease inspection and dry-run planning retain stale leases byte-for-byte", (t) => {
  const item = fixture(t);
  item.lease();
  t.mock.method(process, "kill", (pid, signal) => {
    assert.equal(signal, 0);
    throw Object.assign(new Error("absent"), { code: "ESRCH" });
  });
  const before = stateSnapshot(item.directory);
  assert.equal(inspectWorkspaceLeases(item.config)[0].status, "stale");
  assert.deepEqual([...activeWorkspaceIds(item.config)], []);
  assert.deepEqual(prunePlan(item.config), []);
  assert.deepEqual(stateSnapshot(item.directory), before);
});

test("live leases protect their workspace; unrecognised files are retained and ignored", (t) => {
  const item = fixture(t);
  item.lease();
  fs.writeFileSync(path.join(item.directory, "unrelated.json"), "not a lease");
  assert.equal(inspectWorkspaceLeases(item.config).length, 1);
  assert.equal(inspectWorkspaceLeases(item.config)[0].status, "active");
  assert.deepEqual([...activeWorkspaceIds(item.config)], ["fixture-abcdef"]);
  assert.equal(fs.readFileSync(path.join(item.directory, "unrelated.json"), "utf8"), "not a lease");
});

test("permission errors and unexpected PID-probe failures never prove inactivity", (t) => {
  const item = fixture(t);
  item.lease();
  for (const code of ["EPERM", "EINVAL", "EIO", "ERR_OUT_OF_RANGE"]) {
    const probe = t.mock.method(process, "kill", () => { throw Object.assign(new Error("unknown"), { code }); });
    assert.equal(inspectWorkspaceLeases(item.config)[0].status, "unknown", code);
    assert.deepEqual([...activeWorkspaceIds(item.config)], ["fixture-abcdef"], code);
    probe.mock.restore();
  }
});

test("malformed, oversized and non-regular matching leases protect without being followed", (t) => {
  const item = fixture(t);
  fs.writeFileSync(item.lease("broken"), "{broken");
  fs.writeFileSync(item.lease("oversized"), " ".repeat(65537));
  const directoryLease = item.lease("directory");
  fs.unlinkSync(directoryLease); fs.mkdirSync(directoryLease);
  const target = path.join(item.root, "outside"); fs.writeFileSync(target, "do not read");
  const linked = item.lease("linked"); fs.unlinkSync(linked); fs.symlinkSync(target, linked);
  const before = stateSnapshot(item.directory);
  const reads = t.mock.method(fs, "readSync", () => { throw new Error("should not reach outside file"); });
  assert.deepEqual([...activeWorkspaceIds(item.config)].sort(), ["broken", "directory", "linked", "oversized"]);
  reads.mock.restore();
  assert.deepEqual(stateSnapshot(item.directory), before);
  assert.equal(fs.readFileSync(target, "utf8"), "do not read");
});

test("lease replacement after lstat is rejected by opened-file identity", (t) => {
  const item = fixture(t); const file = item.lease();
  const replacement = path.join(item.root, "replacement"); fs.writeFileSync(replacement, fs.readFileSync(file));
  const original = fs.openSync;
  let swapped = false;
  t.mock.method(fs, "openSync", (target, ...args) => {
    if (target === file && !swapped) { swapped = true; fs.renameSync(replacement, file); }
    return original(target, ...args);
  });
  const observations = inspectWorkspaceLeases(item.config);
  assert.equal(swapped, true);
  assert.equal(observations[0].status, "unknown");
});

test("invalid lease PIDs and identities remain unknown", (t) => {
  const item = fixture(t);
  for (const [index, value] of [ { pid: -1 }, { pid: 1.5 }, { pid: Number.MAX_SAFE_INTEGER + 1 },
    { wrapperPid: -1 }, { workspace: "relative" }, { startedAt: "no date" }, { tool: "npm" } ].entries()) {
    item.lease(`invalid-${index}`, process.pid, value);
  }
  const probe = t.mock.method(process, "kill", () => { throw new Error("invalid metadata must not be probed"); });
  assert.ok(inspectWorkspaceLeases(item.config).every((item) => item.status === "unknown"));
  assert.equal(probe.mock.callCount(), 0);
});

test("public status, doctor and prune previews do not reap exited-process leases", (t) => {
  const item = fixture(t);
  const child = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const deadPid = Number(child.stdout.trim()); item.lease("exited", deadPid);
  const before = stateSnapshot(item.directory);
  for (const args of [["status", "--json"], ["doctor", "--json"], ["prune", "--json"]]) {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: item.root, env: item.env, encoding: "utf8" });
    assert.equal(result.status, args[0] === "doctor" ? 1 : 0, result.stderr);
    JSON.parse(result.stdout);
    assert.deepEqual(stateSnapshot(item.directory), before, args[0]);
  }
});

test("inspection of an unconfigured state does not create a directory", (t) => {
  const item = fixture(t); fs.rmSync(item.config.locations.stateDir, { recursive: true });
  assert.deepEqual(inspectWorkspaceLeases(item.config), []);
  assert.deepEqual([...activeWorkspaceIds(item.config)], []);
  assert.equal(fs.existsSync(item.config.locations.stateDir), false);
});
