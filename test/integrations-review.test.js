import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = path.resolve(".");
const cli = path.join(root, "bin", "clean-development.js");

function fixture() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "clean-development-integrations-review-"));
  const home = path.join(temporary, "home");
  const claude = path.join(temporary, "claude");
  fs.mkdirSync(home, { recursive: true });
  return {
    temporary,
    claude,
    env: {
      ...process.env,
      CLEAN_DEVELOPMENT_HOME: home,
      CLEAN_DEVELOPMENT_DATA_HOME: path.join(temporary, "data"),
      CLEAN_DEVELOPMENT_CONFIG_HOME: path.join(temporary, "config"),
      CLAUDE_CONFIG_DIR: claude
    }
  };
}

function run(args, env) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: "utf8" });
}

test("Claude native setup covers forked sessions without altering unrelated hooks", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.temporary, { recursive: true, force: true }));
  fs.mkdirSync(item.claude, { recursive: true });
  const settingsFile = path.join(item.claude, "settings.json");
  const original = {
    hooks: {
      SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "/usr/local/bin/keep" }] }],
      Stop: [{ hooks: [{ type: "command", command: "/usr/local/bin/also-keep" }] }]
    }
  };
  fs.writeFileSync(settingsFile, `${JSON.stringify(original, null, 2)}\n`);

  const setup = run(["setup", "--root", path.join(item.temporary, "managed"), "--agents", "claude", "--json"], item.env);
  assert.equal(setup.status, 0, setup.stderr);
  const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  assert.deepEqual(settings.hooks.SessionStart[0], original.hooks.SessionStart[0]);
  const installed = settings.hooks.SessionStart[1];
  assert.equal(installed.matcher, "startup|resume|clear|compact|fork");
  assert.equal(installed.hooks.length, 1);

  const removed = run(["uninstall", "--json"], item.env);
  assert.equal(removed.status, 0, removed.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, "utf8")), original);
});
