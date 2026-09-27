import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { resolveConfig } from "../src/config.js";
import { activeWorkspaceIds, applyPrune, prunePlan, workspaceRecord } from "../src/state.js";
import { OWNERSHIP_MARKER } from "../src/adapters.js";
import { writeJsonAtomic } from "../src/io.js";
import { isolatedEnvironment } from "../scripts/harness-utils.mjs";

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "clean-development-bounded-lease-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = resolveConfig({ cwd: root, env: isolatedEnvironment(root), includeProject: false });
  const id = "bounded-deadbeef", workspace = path.join(root, "source");
  const build = path.join(config.buildRoot, id);
  const record = { schemaVersion: 1, workspaceId: id, workspace, ownershipId: "fixture-owner", buildRoot: config.buildRoot,
    path: build, lastUsedAt: "2020-01-01T00:00:00.000Z", pinned: false };
  writeJsonAtomic(path.join(build, OWNERSHIP_MARKER), { ...record, owner: "clean-development" });
  writeJsonAtomic(workspaceRecord(config, id).file, record);
  const file = path.join(config.locations.stateDir, "leases", `${process.pid}-${id}-00000000-0000-4000-8000-000000000000.json`);
  const value = { schemaVersion: 1, wrapperPid: process.pid, pid: process.pid, tool: "cargo", workspaceId: id, workspace,
    startedAt: "2020-01-01T00:00:00.000Z" };
  writeJsonAtomic(file, value);
  return { root, config, id, build, file, value };
}
const absent = () => { throw Object.assign(new Error("missing process"), { code: "ESRCH" }); };

test("oversized valid JSON remains protected without reading its payload", (t) => {
  const item = fixture(t);
  fs.writeFileSync(item.file, JSON.stringify({ ...item.value, padding: "x".repeat(65536) }));
  const open = fs.openSync;
  t.mock.method(fs, "openSync", (file, ...args) => {
    // Other bounded metadata readers may legitimately read workspace records.
    // The oversized lease itself must not even be opened, on either path.
    assert.notEqual(file, item.file, "oversized lease must not be opened");
    return open(file, ...args);
  });
  assert.ok(activeWorkspaceIds(item.config).has(item.id));
  assert.equal(prunePlan(item.config)[0].reason, "active");
});

test("valid short reads and exact size limit do not lose or corrupt lease evidence", (t) => {
  const item = fixture(t);
  const value = JSON.stringify(item.value);
  fs.writeFileSync(item.file, value + " ".repeat(65536 - Buffer.byteLength(value)));
  const read = fs.readSync;
  t.mock.method(fs, "readSync", (fd, buffer, offset, length, position) => read(fd, buffer, offset, Math.min(length, 113), position));
  t.mock.method(process, "kill", absent);
  assert.equal(activeWorkspaceIds(item.config).size, 0);
  assert.equal(fs.statSync(item.file).size, 65536);
});

test("a file growing after open cannot exceed the bounded buffer", (t) => {
  const item = fixture(t);
  const read = fs.readSync;
  let grew = false, total = 0;
  t.mock.method(fs, "readSync", (fd, buffer, offset, length, position) => {
    if (!grew) { grew = true; fs.appendFileSync(item.file, " ".repeat(100000)); }
    const count = read(fd, buffer, offset, length, position); total += count; return count;
  });
  assert.ok(activeWorkspaceIds(item.config).has(item.id));
  assert.equal(total, 65537);
});

test("a regular file replaced between stat and open is not accepted as lease evidence", (t) => {
  const item = fixture(t);
  const open = fs.openSync;
  let replaced = false;
  t.mock.method(fs, "openSync", (file, ...args) => {
    if (file === item.file && !replaced) { replaced = true; writeJsonAtomic(item.file, { ...item.value, pid: 2147483647 }); }
    return open(file, ...args);
  });
  t.mock.method(process, "kill", absent);
  assert.ok(activeWorkspaceIds(item.config).has(item.id));
  assert.equal(replaced, true);
});

test("a path replaced after reading remains protected rather than trusting the old inode", (t) => {
  const item = fixture(t);
  const read = fs.readSync;
  let replaced = false;
  t.mock.method(fs, "readSync", (...args) => {
    const count = read(...args);
    if (!replaced) { replaced = true; writeJsonAtomic(item.file, item.value); }
    return count;
  });
  t.mock.method(process, "kill", absent);
  assert.ok(activeWorkspaceIds(item.config).has(item.id));
});

test("a replaced lease after ESRCH prevents apply-time deletion of an old eligible plan", async (t) => {
  const item = fixture(t);
  const probe = t.mock.method(process, "kill", absent);
  const plan = prunePlan(item.config); assert.equal(plan[0].eligible, true);
  probe.mock.restore();
  t.mock.method(process, "kill", () => { writeJsonAtomic(item.file, item.value); absent(); });
  assert.ok(activeWorkspaceIds(item.config).has(item.id));
  assert.deepEqual(await applyPrune(item.config, plan), []);
  assert.ok(fs.existsSync(item.build));
});

test("a read error closes the opened descriptor and retains the workspace", (t) => {
  const item = fixture(t);
  const open = fs.openSync, close = fs.closeSync;
  let descriptor = null, closed = false;
  t.mock.method(fs, "openSync", (file, ...args) => { const fd = open(file, ...args); if (file === item.file) descriptor = fd; return fd; });
  t.mock.method(fs, "readSync", () => { throw Object.assign(new Error("private message"), { code: "EIO" }); });
  t.mock.method(fs, "closeSync", (fd) => { if (fd === descriptor) closed = true; return close(fd); });
  assert.ok(activeWorkspaceIds(item.config).has(item.id));
  assert.equal(closed, true);
});

test("unsafe integer PID metadata cannot reach process probing", (t) => {
  const item = fixture(t);
  writeJsonAtomic(item.file, { ...item.value, pid: Number.MAX_SAFE_INTEGER + 1 });
  const probe = t.mock.method(process, "kill", () => assert.fail("invalid PID must not be probed"));
  assert.ok(activeWorkspaceIds(item.config).has(item.id));
  assert.equal(probe.mock.callCount(), 0);
});

test("a FIFO substituted before open does not block lease inspection", { skip: process.platform === "win32" }, (t) => {
  const item = fixture(t);
  const fifo = path.join(item.root, "fifo");
  const result = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
  if (result.error?.code === "ENOENT") return t.skip("mkfifo unavailable");
  assert.equal(result.status, 0, result.stderr);
  const open = fs.openSync; let replaced = false;
  t.mock.method(fs, "openSync", (file, ...args) => {
    if (file === item.file && !replaced) { replaced = true; fs.renameSync(fifo, item.file); }
    return open(file, ...args);
  });
  assert.ok(activeWorkspaceIds(item.config).has(item.id));
  assert.equal(replaced, true);
});
