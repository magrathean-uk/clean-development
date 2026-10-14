import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { isolatedEnvironment } from "../scripts/harness-utils.mjs";
import { assertInspectionOperation } from "../src/inspection.js";

test("inspection rejects every writing CLI surface, including skip execution", () => {
  const env = { DEV_ENV_INSPECT_ONLY: "1" };
  for (const command of ["run", "agent", "shim", "hook", "init", "pin", "unpin"]) {
    assert.throws(() => assertInspectionOperation(command, { options: { session: "skip" } }, env), /Inspection mode/);
  }
  for (const command of ["setup", "update", "prepare", "session", "uninstall", "scratch"]) {
    assert.throws(() => assertInspectionOperation(command, { options: {} }, env), /Inspection mode/);
    assert.doesNotThrow(() => assertInspectionOperation(command, { options: { "dry-run": true } }, env));
  }
  assert.throws(() => assertInspectionOperation("probe", { options: { execute: true } }, env), /Inspection mode/);
  assert.throws(() => assertInspectionOperation("prune", { options: { apply: true } }, env), /Inspection mode/);
  assert.throws(() => assertInspectionOperation("xcode", { positionals: ["test-cleanup"], options: {} }, env), /Inspection mode/);
  assert.throws(() => assertInspectionOperation("env", { options: {} }, env), /Inspection mode/);
  assert.doesNotThrow(() => assertInspectionOperation("env", { options: { tool: "npm" } }, env));
});

test("inspection diagnostics do not create unavailable roots or dispatch children", (t) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cd-inspect-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project"); fs.mkdirSync(project); fs.writeFileSync(path.join(project, "package.json"), "{}");
  const env = { ...isolatedEnvironment(root), DEV_ENV_INSPECT_ONLY: "1" };
  const cli = path.resolve("bin/clean-development.js"), output = path.join(root, "unexpected-child");
  const run = (args) => spawnSync(process.execPath, [cli, ...args], { env, cwd: project, encoding: "utf8" });
  const plan = run(["session", "--dry-run", "--json"]);
  assert.equal(plan.status, 0, plan.stderr); assert.equal(JSON.parse(plan.stdout).dryRun, true);
  const blocked = run(["run", "--session", "skip", "--", process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(output)},'bad')`]);
  assert.equal(blocked.status, 1); assert.match(blocked.stderr, /Inspection mode/);
  assert.equal(fs.existsSync(output), false); assert.equal(fs.existsSync(env.CLEAN_DEVELOPMENT_ROOT), false);
  assert.equal(fs.existsSync(env.CLEAN_DEVELOPMENT_DATA_HOME), false);
});
