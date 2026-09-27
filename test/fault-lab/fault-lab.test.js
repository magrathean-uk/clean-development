import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SCENARIOS, isolatedEnvironment } from "./case.mjs";
import { removeCompletedLab, runLab, sanitise } from "./lab.mjs";

// These remain real failing assertions, not assertions that unsafe behaviour is
// correct. The standalone lab exits 1 for them. Unexpected failures fail npm test.
const KNOWN = new Map([
  ["missing-during-marker/storage-identity", "FL-01: ordinary ownership publication recreates a disappeared base"],
  ["replaced-managed-root/storage-identity", "FL-02: no persistent physical identity for a replaced managed base"],
  ["publication-cleanup-error/original-error", "FL-03: cleanup EACCES masks publication ENOSPC"]
]);

test("fault lab uses no inherited homes, routes, preloads or tool search paths", () => {
  const root = path.resolve(os.tmpdir(), "not-created-fault-lab");
  const env = isolatedEnvironment(root);
  assert.equal(env.HOME, path.join(root, "home"));
  assert.equal(env.PATH, path.join(root, "tools"));
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.CARGO_TARGET_DIR, undefined);
  assert.equal(env.CLEAN_DEVELOPMENT_SESSION_MODE, "session-only");
  assert.equal(env.CLEAN_DEVELOPMENT_ROOT, path.join(root, "managed"));
  assert.equal(env.CLEAN_DEVELOPMENT_DATA_HOME, path.join(root, "data"));
});

test("fault evidence normalises fixture paths and random ownership IDs", () => {
  assert.deepEqual(sanitise({ path: "/private/tmp/lab/source", id: "00000000-0000-4000-8000-000000000000" }, "/private/tmp/lab"),
    { path: "<lab>/source", id: "<uuid-1>" });
});

test("evidence preserves identity changes and handles quoted temporary paths", () => {
  const root = '/tmp/lab"quote';
  const old = "00000000-0000-4000-8000-000000000000";
  const next = "11111111-1111-4111-8111-111111111111";
  assert.deepEqual(sanitise([`${root}/source`, old, old, next], root),
    ["<lab>/source", "<uuid-1>", "<uuid-1>", "<uuid-2>"]);
});

test("lab teardown retains incomplete, unowned and replaced evidence roots", (t) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "fault-lab-guard-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sentinel = path.join(root, "keep");
  fs.writeFileSync(sentinel, "guard evidence");
  const stat = fs.lstatSync(root, { bigint: true });
  const result = { root, token: "test-token", identity: { dev: String(stat.dev), ino: String(stat.ino) },
    report: { infrastructureErrors: [] } };
  assert.throws(() => removeCompletedLab(result), /ENOENT/);
  fs.writeFileSync(path.join(root, ".fault-lab-owner.json"), JSON.stringify({ owner: "clean-development-fault-lab", root, token: result.token }));
  assert.throws(() => removeCompletedLab({ ...result, token: "other-token" }), /ownership changed/);
  assert.throws(() => removeCompletedLab({ ...result, identity: { dev: "different", ino: "different" } }), /identity changed/);
  assert.throws(() => removeCompletedLab({ ...result, report: { infrastructureErrors: [{ message: "worker incomplete" }] } }), /retain incomplete lab/);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "guard evidence");
});

test("disposable storage fault lab", { skip: process.platform === "win32" ? "POSIX executable fixture; no native Windows claim" : false, timeout: 240_000 }, async (t) => {
  const result = runLab();
  const { report } = result;
  assert.deepEqual(report.infrastructureErrors, [], `Incomplete evidence retained at ${result.root}`);
  assert.equal(report.scenarios, SCENARIOS.length);
  assert.deepEqual(report.cases.map((item) => item.scenario), SCENARIOS);
  assert.equal(report.productSource.before, report.productSource.after);
  assert.ok(fs.statSync(`${result.root}/report.json`).size <= 256 * 1024);
  let unexpected = false;
  for (const item of report.cases) {
    for (const check of item.checks) {
      const name = `${item.scenario}/${check.id}`;
      unexpected ||= !check.passed && !KNOWN.has(name);
      await t.test(name, { todo: KNOWN.get(name) || false }, () => {
        assert.equal(check.passed, true, JSON.stringify({ expected: check.expected, actual: check.actual }));
      });
    }
  }
  if (unexpected) t.diagnostic(`Unexpected failure; retained disposable evidence: ${result.root}`);
  else removeCompletedLab(result);
});
