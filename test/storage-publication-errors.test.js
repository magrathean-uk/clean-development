import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveConfig } from "../src/config.js";
import { identifyWorkspace } from "../src/workspace.js";
import { runTool } from "../src/runtime.js";
import { workspaceRecord } from "../src/state.js";
import { isolatedNativeEnvironment } from "../scripts/harness-utils.mjs";
import { OWNERSHIP_MARKER } from "../src/adapters.js";

test("post-rename storage failure retains publication and successor paths without admitting a child", { skip: process.platform === "win32" }, async (t) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cd-publication-error-")));
  t.after(() => {
    t.mock.restoreAll();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const project = path.join(root, "project"), tools = path.join(root, "tools");
  const capture = path.join(root, "unexpected-child");
  fs.mkdirSync(project); fs.mkdirSync(tools);
  fs.writeFileSync(path.join(project, "Cargo.toml"), '[package]\nname="publication-error"\nversion="0.0.0"\n');
  fs.writeFileSync(path.join(tools, "cargo"), `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');\nif(process.argv.includes('locate-project'))process.stdout.write(JSON.stringify({root:path.join(process.cwd(),'Cargo.toml')}));\nelse fs.writeFileSync(${JSON.stringify(capture)},'unexpected child');\n`, { mode: 0o700 });

  const env = isolatedNativeEnvironment(root, {}, { overrides: { PATH: tools } });
  const config = resolveConfig({ cwd: project, env });
  for (const directory of [config.buildRoot, config.cacheRoot, config.scratchRoot]) fs.mkdirSync(directory, { recursive: true });
  const workspace = identifyWorkspace("cargo", ["build"], project);
  const buildPath = path.join(config.buildRoot, workspace.id);
  const originalRename = fs.renameSync, originalLstat = fs.lstatSync;
  let temporarySuccessor, renameCompleted = false, failedObservation = false;

  t.mock.method(fs, "renameSync", (from, to) => {
    const result = originalRename(from, to);
    if (!renameCompleted && to === buildPath) {
      renameCompleted = true;
      temporarySuccessor = from;
      fs.mkdirSync(temporarySuccessor);
      fs.writeFileSync(path.join(temporarySuccessor, "unregistered-sentinel"), "retain successor");
    }
    return result;
  });
  t.mock.method(fs, "lstatSync", (file, options) => {
    const details = originalLstat(file, options);
    if (renameCompleted && !failedObservation && options?.bigint === true && path.resolve(String(file)) === config.buildRoot) {
      failedObservation = true;
      throw Object.assign(new Error("injected post-rename observation failure"), { code: "EIO" });
    }
    return details;
  });

  await assert.rejects(runTool("cargo", ["build"], { config, cwd: project, env }), (error) => {
    assert.equal(error.code, "EIO");
    assert.match(error.message, /^injected post-rename observation failure;/);
    assert.deepEqual(error.publication, {
      code: "EIO", path: buildPath, phase: "post-rename-revalidation", retained: true
    });
    assert.equal(error.cleanup, undefined);
    return true;
  });

  assert.equal(renameCompleted, true);
  assert.equal(failedObservation, true);
  assert.equal(fs.existsSync(path.join(buildPath, OWNERSHIP_MARKER)), true);
  assert.equal(fs.readFileSync(path.join(temporarySuccessor, "unregistered-sentinel"), "utf8"), "retain successor");
  assert.equal(fs.existsSync(capture), false);
  assert.equal(workspaceRecord(config, workspace.id).value, null);
});
