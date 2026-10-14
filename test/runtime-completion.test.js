import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runTool } from "../src/runtime.js";
import { resolveConfig } from "../src/config.js";
import { isolatedNativeEnvironment } from "../scripts/harness-utils.mjs";

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cd-completion-")));
  t.after(() => {
    t.mock.restoreAll();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const project = path.join(root, "project"), tools = path.join(root, "tools");
  fs.mkdirSync(project); fs.mkdirSync(tools);
  fs.writeFileSync(path.join(project, "Cargo.toml"), '[package]\nname="completion"\nversion="0.0.0"\n');
  const env = isolatedNativeEnvironment(root, {}, { overrides: { PATH: tools } });
  const config = resolveConfig({ cwd: project, env });
  fs.mkdirSync(config.buildRoot, { recursive: true }); fs.mkdirSync(config.cacheRoot, { recursive: true });
  const script = `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');\nif(process.argv.includes('locate-project'))process.stdout.write(JSON.stringify({root:path.join(process.cwd(),'Cargo.toml')}));\nelse {fs.writeFileSync(path.join(process.env.CARGO_TARGET_DIR,'child-evidence'),'complete');process.exit(23);}\n`;
  fs.writeFileSync(path.join(tools, "cargo"), script, { mode: 0o700 });
  return { root, project, env, config };
}

test("completed child status survives lease removal failure with bounded uncertainty", { skip: process.platform === "win32" }, async (t) => {
  const item = fixture(t), unlink = fs.unlinkSync, messages = [];
  t.mock.method(fs, "unlinkSync", (file) => {
    const filename = Buffer.isBuffer(file) ? file.toString() : file;
    if (typeof filename === "string" && filename.startsWith(path.join(item.config.locations.stateDir, "leases") + path.sep)) throw Object.assign(new Error("private-cleanup-details"), { code: "EACCES" });
    return unlink(file);
  });
  t.mock.method(process.stderr, "write", (message) => { messages.push(message); return true; });
  const status = await runTool("cargo", ["build"], { ...item, cwd: item.project });
  assert.equal(status, 23);
  assert.match(messages.join(""), /lease:EACCES/);
  assert.doesNotMatch(messages.join(""), /private-cleanup-details/);
  assert.equal(fs.readdirSync(path.join(item.config.locations.stateDir, "leases")).length, 1);
});

test("asynchronous spawn callback failure remains primary after failed lease cleanup", { skip: process.platform === "win32" }, async (t) => {
  const item = fixture(t), unlink = fs.unlinkSync;
  const primary = Object.assign(new Error("spawn-callback-failed"), { code: "SPAWN_CALLBACK" });
  t.mock.method(fs, "unlinkSync", (file) => {
    const filename = Buffer.isBuffer(file) ? file.toString() : file;
    if (typeof filename === "string" && filename.startsWith(path.join(item.config.locations.stateDir, "leases") + path.sep)) throw Object.assign(new Error("ignored cleanup details"), { code: "EACCES" });
    return unlink(file);
  });
  await assert.rejects(runTool("cargo", ["build"], { ...item, cwd: item.project, onSpawn: () => { throw primary; } }), (error) => {
    assert.equal(error, primary); assert.equal(error.code, "SPAWN_CALLBACK");
    assert.ok(error.cleanupFailures.some((entry) => entry.stage === "lease" && entry.code === "EACCES"));
    return true;
  });
});
