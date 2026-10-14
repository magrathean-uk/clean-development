import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { resolveConfig } from "../src/config.js";
import { createScratch, planScratch } from "../src/scratch.js";
import { isolatedEnvironment } from "../scripts/harness-utils.mjs";

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cd-scratch-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project"); fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "package.json"), "{}\n");
  const env = isolatedEnvironment(root);
  const config = resolveConfig({ cwd: project, env });
  fs.mkdirSync(config.scratchRoot, { recursive: true });
  return { root, project, env, config };
}

test("scratch preview is read-only; explicit allocation is private and disjoint from source", (t) => {
  const item = fixture(t), before = fs.readdirSync(item.config.scratchRoot);
  assert.equal(planScratch({ config: item.config, cwd: item.project }).status, "available");
  assert.deepEqual(fs.readdirSync(item.config.scratchRoot), before);
  const a = createScratch({ config: item.config, cwd: item.project, prefix: "test-log" });
  const b = createScratch({ config: item.config, cwd: item.project, prefix: "test-log" });
  assert.notEqual(a.path, b.path);
  assert.equal(path.dirname(a.path), item.config.scratchRoot);
  assert.deepEqual(fs.readdirSync(item.project), ["package.json"]);
  if (process.platform !== "win32") assert.equal(fs.statSync(a.path).mode & 0o777, 0o700);
  assert.match(a.ownership, /no pruning authority/);
});

test("scratch refuses unavailable, disabled, source-local and unsafe destinations before allocation", (t) => {
  const item = fixture(t);
  assert.throws(() => createScratch({ config: item.config, prefix: "../escape" }), /Invalid scratch prefix/);
  assert.throws(() => createScratch({ config: { ...item.config, enabled: false }, cwd: item.project }), /disabled/);
  assert.throws(() => createScratch({ config: { ...item.config, scratchRoot: path.join(item.project, "scratch") }, cwd: item.project }), /outside the project/);
  fs.rmdirSync(item.config.scratchRoot);
  assert.throws(() => createScratch({ config: item.config, cwd: item.project }), /unavailable/);
  assert.equal(fs.existsSync(item.config.scratchRoot), false);
});

test("a root disappearing during allocation is not recreated by marker publication", (t) => {
  const item = fixture(t), nativeMkdir = fs.mkdirSync;
  const retired = path.join(item.root, "retired-scratch");
  t.mock.method(fs, "mkdirSync", (directory, options) => {
    const result = nativeMkdir(directory, options);
    if (path.dirname(directory) === item.config.scratchRoot) fs.renameSync(item.config.scratchRoot, retired);
    return result;
  });
  assert.throws(() => createScratch({ config: item.config, cwd: item.project }), /ENOENT/);
  assert.equal(fs.existsSync(item.config.scratchRoot), false);
  assert.equal(fs.readdirSync(retired).length, 1);
});

test("CLI scratch allocation supports status-preserving logging for a failing wrapped child", { skip: process.platform === "win32" }, (t) => {
  const item = fixture(t), cli = path.resolve("bin/clean-development.js");
  const args = [cli, "scratch", "--prefix", "failure-log", "--json"];
  const allocated = spawnSync(process.execPath, args, { cwd: item.project, env: item.env, encoding: "utf8" });
  assert.equal(allocated.status, 0, allocated.stderr);
  const log = path.join(JSON.parse(allocated.stdout).path, "child.log");
  const quote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;
  const script = `${quote(process.execPath)} ${quote(cli)} run --session session-only -- ${quote(process.execPath)} -e 'console.log("failure-evidence");process.exit(23)' > ${quote(log)} 2>&1\nchild_status=$?\n/usr/bin/tail -50 ${quote(log)}\nexit "$child_status"`;
  const result = spawnSync("/bin/sh", ["-c", script], { cwd: item.project, env: item.env, encoding: "utf8" });
  assert.equal(result.status, 23, result.stderr);
  assert.match(fs.readFileSync(log, "utf8"), /failure-evidence/);
  assert.match(result.stdout, /failure-evidence/);
  const failedViewer = spawnSync("/bin/sh", ["-c", script.replace(`/usr/bin/tail -50 ${quote(log)}`, "/usr/bin/false")], {
    cwd: item.project, env: item.env, encoding: "utf8"
  });
  assert.equal(failedViewer.status, 23, "A failed log viewer must preserve the initiating child failure");
});
