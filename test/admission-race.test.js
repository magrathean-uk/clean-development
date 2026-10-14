import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveConfig } from "../src/config.js";
import { runTool } from "../src/runtime.js";
import { approveManagedBuildRoot } from "../src/storage-identity.js";
import { isolatedNativeEnvironment } from "../scripts/harness-utils.mjs";

test("later explicit storage approval cannot redirect an already admitted command", { skip: process.platform === "win32" }, async (t) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cd-admission-race-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project"), tools = path.join(root, "tools"), capture = path.join(root, "unexpected-child");
  fs.mkdirSync(project); fs.mkdirSync(tools);
  fs.writeFileSync(path.join(project, "Cargo.toml"), '[package]\nname="admission"\nversion="0.0.0"\n');
  fs.writeFileSync(path.join(tools, "cargo"), `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');\nif(process.argv.includes('locate-project'))process.stdout.write(JSON.stringify({root:path.join(process.cwd(),'Cargo.toml')}));\nelse {fs.mkdirSync(process.env.CARGO_TARGET_DIR,{recursive:true});fs.writeFileSync(${JSON.stringify(capture)},'bad');process.exit(23);}\n`, { mode: 0o700 });
  const env = isolatedNativeEnvironment(root, {}, { overrides: { PATH: tools } });
  const config = resolveConfig({ cwd: project, env });
  fs.mkdirSync(config.buildRoot, { recursive: true }); fs.mkdirSync(config.cacheRoot, { recursive: true });
  const write = fs.writeFileSync, retired = path.join(root, "retired-builds");
  let raced = false;
  t.mock.method(fs, "writeFileSync", (file, ...args) => {
    if (!raced && file.startsWith(path.join(config.locations.stateDir, "leases") + path.sep)) {
      raced = true;
      fs.renameSync(config.buildRoot, retired); fs.mkdirSync(config.buildRoot);
      // A later explicit preparation can approve the new root while this
      // command has no published lease yet, but cannot change its admission.
      approveManagedBuildRoot(config, { reapprove: true });
    }
    return write(file, ...args);
  });
  await assert.rejects(runTool("cargo", ["build"], { config, env, cwd: project }), (error) => {
    assert.equal(error.code, "CLEAN_DEVELOPMENT_ADMISSION_CHANGED"); return true;
  });
  assert.equal(raced, true); assert.equal(fs.existsSync(capture), false);
  assert.deepEqual(fs.readdirSync(config.buildRoot), []);
  assert.ok(fs.readdirSync(retired).length > 0);
  assert.deepEqual(fs.readdirSync(path.join(config.locations.stateDir, "leases")), []);
});
