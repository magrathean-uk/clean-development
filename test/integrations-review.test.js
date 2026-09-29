import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { withoutCleanDevelopmentEnvironment } from "../scripts/harness-utils.mjs";

const root = path.resolve(".");
const cli = path.join(root, "bin", "clean-development.js");

function fixture() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "clean-development-integrations-review-"));
  const home = path.join(temporary, "home");
  const claude = path.join(temporary, "claude");
  const codex = path.join(temporary, "codex");
  const grok = path.join(temporary, "grok");
  fs.mkdirSync(home, { recursive: true });
  const env = {
    ...withoutCleanDevelopmentEnvironment(),
    HOME: home,
    USERPROFILE: home,
    CLEAN_DEVELOPMENT_HOME: home,
    CLEAN_DEVELOPMENT_DATA_HOME: path.join(temporary, "data"),
    CLEAN_DEVELOPMENT_CONFIG_HOME: path.join(temporary, "config"),
    CLAUDE_CONFIG_DIR: claude,
    CODEX_HOME: codex,
    GROK_HOME: grok
  };
  for (const name of ["npm_execpath", "NPM_EXECPATH", "npm_lifecycle_event", "npm_command"]) delete env[name];
  return { temporary, claude, codex, grok, env };
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

const tomlAgents = [
  { agent: "codex", header: "[shell_environment_policy.set]", assignment: 'KEEP = "user-value"' },
  { agent: "grok", header: "[toolset.bash]", assignment: "timeout_secs = 30" }
];

function tomlFixture(t, specification, { newline = "\n", priorTable = true } = {}) {
  const { agent, header, assignment } = specification;
  const item = fixture();
  t.after(() => fs.rmSync(item.temporary, { recursive: true, force: true }));
  const file = path.join(item[agent], "config.toml");
  fs.mkdirSync(item[agent], { recursive: true });
  const original = priorTable
    ? `${agent === "codex" ? `allow_login_shell = false${newline}` : ""}[mcp_servers.keep]${newline}command = "user-server"${newline}`
    : 'model = "user-model"';
  fs.writeFileSync(file, original);
  const setup = run(["setup", "--root", path.join(item.temporary, "managed"), "--agents", agent, "--json"], item.env);
  assert.equal(setup.status, 0, setup.stderr);
  const entry = JSON.parse(setup.stdout).integrations[0];
  assert.equal(entry.mode, "native-shell-environment");
  const installed = fs.readFileSync(file, "utf8");
  const headerLine = installed.split(/(?<=\n)/).find((line) => line.trim() === header);
  assert.ok(headerLine);
  const suffix = ["", "# User-owned settings, outside the markers", "# [not.a.table]", assignment, "", '[profiles."keep[me]"]', 'model = "user-profile"', ""].join(newline);
  fs.appendFileSync(file, suffix);
  return {
    ...item,
    file,
    original,
    expected: `${original}${entry.leadingSeparator}${headerLine}${suffix}`
  };
}

function assertUserTable(item, { header, assignment }) {
  const content = fs.readFileSync(item.file, "utf8");
  const parts = content.split(assignment);
  assert.equal(parts.length, 2, "the user setting must occur exactly once");
  // These fixtures use single-line table headers; assert the setting's scope,
  // not just its continued presence somewhere in the file.
  const precedingHeader = parts[0].match(/^\[.*\]\r?$/gm)?.at(-1)?.trim();
  assert.equal(precedingHeader, header, "the user setting must remain in its original TOML table");
  assert.ok(content.startsWith(item.original));
  assert.match(content, /\[profiles\."keep\[me\]"\]\r?\nmodel = "user-profile"/);
}

for (const specification of tomlAgents) {
  const { agent } = specification;
  const options = { skip: agent === "grok" && process.platform === "win32" };

  test(`${agent} uninstall preserves an owned table header needed by following user settings`, options, (t) => {
    for (const newline of ["\n", "\r\n"]) {
      for (const priorTable of [false, true]) {
        const item = tomlFixture(t, specification, { newline, priorTable });
        assertUserTable(item, specification);
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const removed = run(["uninstall", "--json"], item.env);
          assert.equal(removed.status, 0, removed.stderr);
          assert.equal(JSON.parse(removed.stdout).integrationsRemoved.retained, 0);
          assert.equal(fs.readFileSync(item.file, "utf8"), item.expected);
        }
      }
    }
  });

  test(`${agent} repeated setup and update preserve user settings in their original table`, options, (t) => {
    for (const newline of ["\n", "\r\n"]) {
      const item = tomlFixture(t, specification, { newline });
      for (const command of ["setup", "setup", "update", "update"]) {
        const args = command === "setup" ? [command, "--agents", agent, "--json"] : [command, "--json"];
        const repeated = run(args, item.env);
        assert.equal(repeated.status, 0, repeated.stderr);
        const entries = JSON.parse(repeated.stdout).integrations;
        assert.equal(entries.length, 1);
        assert.equal(entries[0].mode, "native-shell-environment");
        assertUserTable(item, specification);
      }
      const removed = run(["uninstall", "--json"], item.env);
      assert.equal(removed.status, 0, removed.stderr);
      assert.equal(fs.readFileSync(item.file, "utf8"), item.expected);
    }
  });
}

test("Grok table scope survives a later setup failure and an update retry", { skip: process.platform === "win32" }, (t) => {
  const specification = tomlAgents.find(({ agent }) => agent === "grok");
  const item = tomlFixture(t, specification);
  const blockedFile = path.join(item.codex, "config.toml");
  fs.mkdirSync(blockedFile, { recursive: true });
  const failed = run(["setup", "--agents", "grok,codex", "--json"], item.env);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /EISDIR|illegal operation on a directory|Metadata must be a regular file/i);
  const receiptFile = path.join(item.temporary, "data", "state", "integrations.json");
  const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
  assert.deepEqual(receipt.integrations.map(({ agent }) => agent), ["grok"]);
  assertUserTable(item, specification);

  fs.rmdirSync(blockedFile);
  const retried = run(["update", "--json"], item.env);
  assert.equal(retried.status, 0, retried.stderr);
  assertUserTable(item, specification);
  assert.deepEqual(JSON.parse(retried.stdout).integrations.map(({ agent }) => agent), ["codex", "grok"]);
  const removed = run(["uninstall", "--json"], item.env);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(fs.readFileSync(item.file, "utf8"), item.expected);
});
