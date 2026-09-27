import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { captureProbeCommand } from "../src/probe-process.js";
import { probeTool } from "../src/probe.js";
import { resolveExecutable, ensureRuntime, runtimeHealth, removeRuntime } from "../src/runtime.js";
import { resolveConfig } from "../src/config.js";
import { setEnvironmentValue, canonicalizePotentialPath } from "../src/platform.js";
import { ensureOwnedBuildRoot } from "../src/adapters.js";
import { recordWorkspace, createLease, prunePlan, applyPrune, workspaceRecord } from "../src/state.js";
import { writeJsonAtomic } from "../src/io.js";
import { VERSION } from "../src/constants.js";
import { isolatedEnvironment } from "../scripts/harness-utils.mjs";

const onlyWindows = { skip: process.platform !== "win32" };
const cli = fileURLToPath(new URL("../bin/clean-development.js", import.meta.url));
function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cd Windows & contract ")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "source project"); fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, "package.json"), '{"name":"windows-contract","private":true}\n');
  const env = isolatedEnvironment(root);
  setEnvironmentValue(env, "CODEX_HOME", path.join(root, "codex"));
  for (const name of ["HOME", "USERPROFILE"]) setEnvironmentValue(env, name, path.join(root, "tool-home"));
  for (const name of ["APPDATA", "LOCALAPPDATA"]) setEnvironmentValue(env, name, path.join(root, name));
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith("NPM_CONFIG_")) delete env[key];
  env.npm_config_userconfig = path.join(root, "npm-user.config");
  env.npm_config_globalconfig = path.join(root, "npm-global.config");
  fs.writeFileSync(env.npm_config_userconfig, ""); fs.writeFileSync(env.npm_config_globalconfig, "");
  env.npm_config_offline = "true"; env.npm_config_audit = "false"; env.npm_config_fund = "false";
  const config = resolveConfig({ cwd, env });
  return { root, cwd, env, config };
}
async function command(file, args, item) {
  const result = await captureProbeCommand(file, args, { cwd: item.cwd, env: item.env, timeoutMs: 30000, maxOutputBytes: 1024 * 1024 });
  assert.equal(result.ok, true, JSON.stringify(result)); return result.stdout;
}
const invoke = (args, item) => command(process.execPath, [cli, ...args], item);

for (const tool of ["npm", "go"]) {
  test(`native Windows requires a real ${tool} executable and a matching isolated probe`, onlyWindows, async (t) => {
    const item = fixture(t);
    assert.ok(resolveExecutable(tool, item.env), `${tool} is mandatory in the Windows contract job`);
    const result = await probeTool(tool, { ...item, execute: true, timeoutMs: 15000 });
    assert.equal(result.status, "observed-working", JSON.stringify(result));
    assert.equal(result.cleanup, "removed"); assert.ok(result.toolVersion);
    assert.equal(fs.existsSync(item.config.root), false); assert.equal(fs.existsSync(item.config.locations.dataDir), false);
    t.diagnostic(`${tool} ${result.toolVersion}`);
  });
}

test("native Windows generated .cmd launchers work in paths with spaces and ampersands", onlyWindows, async (t) => {
  const item = fixture(t);
  for (const root of [item.config.root, item.config.cacheRoot, item.config.buildRoot, item.config.scratchRoot]) fs.mkdirSync(root, { recursive: true });
  const runtime = ensureRuntime(item.config);
  const launcher = path.join(runtime.binDir, "clean-development.cmd");
  assert.equal((await command(launcher, ["--version"], item)).trim(), VERSION);
  const shim = path.join(runtime.binDir, "npm.cmd");
  const cache = (await command(shim, ["config", "get", "cache"], item)).trim();
  assert.equal(canonicalizePotentialPath(cache), path.join(item.config.cacheRoot, "node", "npm"));
  assert.equal(runtimeHealth(item.config).ok, true);
  const unrelated = path.join(runtime.binDir, "unrelated.txt"); fs.writeFileSync(unrelated, "retain");
  removeRuntime(item.config);
  assert.equal(fs.existsSync(launcher), false); assert.equal(fs.readFileSync(unrelated, "utf8"), "retain");
});

test("native Windows setup/update/uninstall retain unrelated configuration and managed data", onlyWindows, async (t) => {
  const item = fixture(t);
  const codexFile = path.join(item.root, "codex", "config.toml"); fs.mkdirSync(path.dirname(codexFile));
  const contents = '# unrelated\r\nmodel = "fixture"\r\n'; fs.writeFileSync(codexFile, contents);
  const setup = JSON.parse(await invoke(["setup", "--agents", "codex", "--json"], item));
  assert.equal(setup.runtime.version, VERSION);
  const retained = path.join(item.config.cacheRoot, "user-data"); fs.writeFileSync(retained, "retain");
  const updated = JSON.parse(await invoke(["update", "--agents", "codex", "--json"], item));
  assert.equal(updated.command, "update");
  const status = JSON.parse(await invoke(["status", "--workspaces", "--sizes", "--json"], item));
  assert.equal(status.configured, true); assert.equal(status.runtime.status, "installed");
  const uninstalled = JSON.parse(await invoke(["uninstall", "--json"], item));
  assert.equal(uninstalled.dryRun, false);
  assert.equal(fs.readFileSync(retained, "utf8"), "retain");
  assert.equal(fs.readFileSync(codexFile, "utf8"), contents);
  assert.equal(fs.existsSync(path.join(item.config.locations.binDir, "clean-development.cmd")), false);
});

test("native Windows routing honours upper-case overrides and skip without leaking PATH keys", onlyWindows, async (t) => {
  const item = fixture(t);
  const custom = path.join(item.root, "explicit cache");
  setEnvironmentValue(item.env, "NPM_CONFIG_CACHE", custom);
  const actual = (await invoke(["run", "--session", "session-only", "--", "npm", "config", "get", "cache"], item)).trim();
  assert.equal(canonicalizePotentialPath(actual), custom);
  const skipped = JSON.parse(await invoke(["run", "--session", "skip", "--", process.execPath, "-e",
    "console.log(JSON.stringify({cache:process.env.NPM_CONFIG_CACHE,active:process.env.CLEAN_DEVELOPMENT_ACTIVE||null,pathKeys:Object.keys(process.env).filter(k=>k.toLowerCase()==='path').length}))"], item));
  assert.equal(skipped.cache, custom); assert.equal(skipped.active, null); assert.equal(skipped.pathKeys, 1);
});

test("native Windows pruning revalidates leases and pins before deleting only owned builds", onlyWindows, async (t) => {
  const item = fixture(t); fs.mkdirSync(item.config.buildRoot, { recursive: true });
  const workspace = { id: "windows-deadbeef", root: item.cwd };
  const owned = ensureOwnedBuildRoot(item.config, workspace);
  recordWorkspace(item.config, workspace, owned);
  const record = workspaceRecord(item.config, workspace.id);
  writeJsonAtomic(record.file, { ...record.value, lastUsedAt: "2020-01-01T00:00:00.000Z" });
  const unrelated = path.join(item.config.buildRoot, "unregistered"); fs.mkdirSync(unrelated); fs.writeFileSync(path.join(unrelated, "keep"), "retain");
  const plan = prunePlan(item.config); assert.equal(plan[0].eligible, true);
  const lease = createLease(item.config, workspace, "cargo");
  try { assert.deepEqual(await applyPrune(item.config, plan), []); } finally { lease.release(); }
  writeJsonAtomic(record.file, { ...record.value, pinned: true, lastUsedAt: "2020-01-01T00:00:00.000Z" });
  assert.deepEqual(await applyPrune(item.config, plan), []);
  writeJsonAtomic(record.file, { ...record.value, lastUsedAt: "2020-01-01T00:00:00.000Z" });
  assert.deepEqual(await applyPrune(item.config, prunePlan(item.config)), [owned.path]);
  assert.equal(fs.readFileSync(path.join(unrelated, "keep"), "utf8"), "retain");
});

test("native Windows probe timeout terminates an ordinary descendant process tree", onlyWindows, async (t) => {
  const item = fixture(t), heartbeat = path.join(item.root, "heartbeat");
  const child = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(heartbeat)},'start');setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'.'),30)`;
  const wrapper = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'inherit'});setInterval(()=>{},1000)`;
  const result = await captureProbeCommand(process.execPath, ["-e", wrapper], { cwd: item.cwd, env: item.env, timeoutMs: 2500 });
  assert.equal(result.failure, "timeout"); assert.equal(result.cleanupComplete, true, JSON.stringify(result));
  assert.ok(fs.existsSync(heartbeat), "descendant started");
  await new Promise((resolve) => setTimeout(resolve, 100)); const stopped = fs.readFileSync(heartbeat, "utf8");
  await new Promise((resolve) => setTimeout(resolve, 200)); assert.equal(fs.readFileSync(heartbeat, "utf8"), stopped);
});
