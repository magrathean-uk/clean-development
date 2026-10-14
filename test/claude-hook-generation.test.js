import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { installAgentIntegrations, validateClaudeHookOwner } from "../src/integrations.js";
import { withoutCleanDevelopmentEnvironment } from "../scripts/harness-utils.mjs";
import { platformPaths } from "../src/platform.js";

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clean-development-claude-generation-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = {
    ...withoutCleanDevelopmentEnvironment(),
    HOME: path.join(root, "home"),
    USERPROFILE: path.join(root, "home"),
    CLEAN_DEVELOPMENT_HOME: path.join(root, "home"),
    CLEAN_DEVELOPMENT_DATA_HOME: path.join(root, "data"),
    CLEAN_DEVELOPMENT_CONFIG_HOME: path.join(root, "config"),
    CLAUDE_CONFIG_DIR: path.join(root, "claude")
  };
  const locations = platformPaths(env);
  fs.mkdirSync(locations.home, { recursive: true });
  fs.mkdirSync(locations.stateDir, { recursive: true });
  fs.mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  const config = { locations };
  const runtime = (version) => ({
    cli: path.join(locations.runtimeDir, version, "bin", "clean-development.js"),
    binDir: locations.binDir
  });
  return { env, config, runtime, settingsFile: path.join(env.CLAUDE_CONFIG_DIR, "settings.json"), receiptFile: path.join(locations.stateDir, "integrations.json") };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

test("Claude hook owner is stable within a generation and rotates when the runtime CLI changes", (t) => {
  const item = fixture(t);
  const unrelated = { matcher: "startup", hooks: [{ type: "command", command: "/usr/local/bin/keep" }] };
  fs.writeFileSync(item.settingsFile, `${JSON.stringify({ hooks: { SessionStart: [unrelated] } }, null, 2)}\n`);

  const original = installAgentIntegrations(item.config, item.runtime("0.4.1"), ["claude"], item.env);
  const originalEntry = original.find((entry) => entry.agent === "claude");
  assert.ok(originalEntry);
  const repeat = installAgentIntegrations(item.config, item.runtime("0.4.1"), ["claude"], item.env);
  const repeatedEntry = repeat.find((entry) => entry.agent === "claude");
  assert.equal(repeatedEntry.ownershipId, originalEntry.ownershipId);
  assert.equal(repeatedEntry.command, originalEntry.command);

  const updated = installAgentIntegrations(item.config, item.runtime("0.4.2"), ["claude"], item.env);
  const updatedEntry = updated.find((entry) => entry.agent === "claude");
  assert.notEqual(updatedEntry.ownershipId, originalEntry.ownershipId);
  assert.notEqual(updatedEntry.command, originalEntry.command);
  const settings = readJson(item.settingsFile);
  const commands = settings.hooks.SessionStart.flatMap((entry) => entry.hooks || [])
    .filter((hook) => hook.type === "command").map((hook) => hook.command);
  assert.deepEqual(commands, [unrelated.hooks[0].command, updatedEntry.command]);
  assert.deepEqual(readJson(item.receiptFile).integrations, [updatedEntry]);

  const settingsBeforeOldInvocation = fs.readFileSync(item.settingsFile);
  const receiptBeforeOldInvocation = fs.readFileSync(item.receiptFile);
  assert.throws(
    () => validateClaudeHookOwner(item.config, item.env, originalEntry.ownershipId),
    /owner does not match the installation receipt/
  );
  assert.deepEqual(fs.readFileSync(item.settingsFile), settingsBeforeOldInvocation);
  assert.deepEqual(fs.readFileSync(item.receiptFile), receiptBeforeOldInvocation);

  const cli = path.resolve("bin/clean-development.js");
  const oldInvocation = spawnSync(process.execPath, [cli, "hook", "session-start", "--owner", originalEntry.ownershipId], {
    cwd: item.config.locations.home,
    env: item.env,
    encoding: "utf8"
  });
  assert.equal(oldInvocation.status, 1);
  assert.match(oldInvocation.stderr, /owner does not match the installation receipt/);
  assert.equal(fs.existsSync(item.config.locations.runtimeDir), false, "a retired hook must reject before automatic runtime publication");
  assert.deepEqual(fs.readFileSync(item.settingsFile), settingsBeforeOldInvocation);
  assert.deepEqual(fs.readFileSync(item.receiptFile), receiptBeforeOldInvocation);
});
