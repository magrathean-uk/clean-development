import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";

const cli = path.resolve("bin/clean-development.js");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clean-development-cli-"));
  const home = path.join(root, "home");
  const claude = path.join(root, "claude");
  const codex = path.join(root, "codex");
  const grok = path.join(root, "grok");
  fs.mkdirSync(home, { recursive: true });
  const env = {
    ...process.env,
    CLEAN_DEVELOPMENT_HOME: home,
    CLEAN_DEVELOPMENT_DATA_HOME: path.join(root, "data"),
    CLEAN_DEVELOPMENT_CONFIG_HOME: path.join(root, "config"),
    CLAUDE_CONFIG_DIR: claude,
    CODEX_HOME: codex,
    GROK_HOME: grok
  };
  for (const name of ["npm_execpath", "NPM_EXECPATH", "npm_lifecycle_event", "npm_command"]) delete env[name];
  return { root, home, claude, codex, grok, env };
}

function run(args, env, cwd = process.cwd()) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: "utf8" });
}

function seedLegacyGrok(item, { before = "", after = "", newline = "\n", leadingSeparator = "", headers = ["[shell_environment_policy]", 'inherit = "all"', "", "[shell_environment_policy.set]"] } = {}) {
  const file = path.join(item.grok, "config.toml");
  const ownershipId = "cf3b1f54-7918-4cde-8941-8495ad942cb0";
  const beginMarker = `# clean-development begin (grok) owner=${ownershipId}`;
  const endMarker = `# clean-development end (grok) owner=${ownershipId}`;
  const block = [beginMarker, ...headers, `PATH = ${JSON.stringify(path.join(item.root, "data", "bin"))}`, 'CLEAN_DEVELOPMENT_ACTIVE = "1"', endMarker].join(newline);
  fs.mkdirSync(item.grok, { recursive: true });
  fs.writeFileSync(file, `${before}${leadingSeparator}${block}${newline}${after}`);
  const entry = { agent: "grok", mode: "native-shell-environment", file, referent: fs.realpathSync(file), ownershipId, beginMarker, endMarker, leadingSeparator, ownedBlock: true };
  const receiptFile = path.join(item.root, "data", "state", "integrations.json");
  const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
  receipt.integrations = receipt.integrations.filter((value) => value.agent !== "grok");
  receipt.integrations.push(entry);
  fs.writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
  return entry;
}

function claudeOwner(item) {
  const receipt = JSON.parse(fs.readFileSync(path.join(item.root, "data", "state", "integrations.json"), "utf8"));
  return receipt.integrations.find((entry) => entry.agent === "claude" && entry.mode === "native-hook")?.ownershipId;
}

test("setup dry run performs no writes", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const managed = path.join(item.root, "managed");
  const result = run(["setup", "--root", managed, "--agents", "claude,codex", "--dry-run", "--json"], item.env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).dryRun, true);
  assert.equal(fs.existsSync(path.join(item.root, "config")), false);
  assert.equal(fs.existsSync(managed), false);
});

test("command help is read-only and does not intercept child help", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  for (const args of [["setup", "--help"], ["run", "-h"], ["agent", "--help"]]) {
    const result = run(args, item.env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:/);
    assert.match(result.stdout, /Noninteractive launches default to session-only/);
  }
  const child = run(["run", "--session", "skip", "--", process.execPath, "--help"], item.env);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /Usage: node/);
  assert.equal(fs.existsSync(path.join(item.root, "data")), false);
  assert.equal(fs.existsSync(path.join(item.root, "config")), false);
});

test("invalid environment formats and empty agent selections fail before writing", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const invalidFormat = run(["env", "--format", "typo"], item.env);
  assert.equal(invalidFormat.status, 1);
  assert.match(invalidFormat.stderr, /Unsupported environment format/);
  const invalidAgents = run(["setup", "--agents", ", ,", "--root", path.join(item.root, "managed")], item.env);
  assert.equal(invalidAgents.status, 1);
  assert.match(invalidAgents.stderr, /--agents requires/);
  assert.equal(fs.existsSync(path.join(item.root, "data")), false);
  assert.equal(fs.existsSync(path.join(item.root, "managed")), false);
});

test("doctor reports missing or invalid managed directories without recreating them", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const managed = path.join(item.root, "managed");
  const installed = run(["setup", "--root", managed, "--agents", "claude"], item.env);
  assert.equal(installed.status, 0, installed.stderr);
  const healthy = run(["doctor", "--json"], item.env);
  assert.equal(healthy.status, 0, healthy.stderr);
  for (const [name, key] of [["caches", "cacheRoot"], ["builds", "buildRoot"], ["scratch", "scratchRoot"]]) {
    const directory = path.join(managed, name);
    fs.rmdirSync(directory);
    for (const presentAsFile of [false, true]) {
      if (presentAsFile) fs.writeFileSync(directory, "not a directory");
      const result = run(["doctor", "--json"], item.env);
      assert.equal(result.status, 1, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.ok, false);
      assert.equal(report.checks.find((check) => check.name === `managed-${key}`).ok, false);
      assert.equal(fs.existsSync(directory), presentAsFile);
      if (presentAsFile) fs.unlinkSync(directory);
    }
    fs.mkdirSync(directory);
  }
  const launcher = path.join(item.root, "data", "bin", process.platform === "win32" ? "cargo.cmd" : "cargo");
  fs.unlinkSync(launcher);
  const brokenRuntime = run(["doctor", "--json"], item.env);
  assert.equal(brokenRuntime.status, 1, brokenRuntime.stderr);
  assert.equal(JSON.parse(brokenRuntime.stdout).checks.find((check) => check.name === "runtime").ok, false);
  assert.equal(fs.existsSync(launcher), false);
});

test("setup refuses to create through a missing parent that may be an unmounted volume", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const managed = path.join(item.root, "missing-volume", "clean-development");
  const result = run(["setup", "--root", managed, "--agents", "claude", "--json"], item.env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Parent directory is unavailable/);
  assert.equal(fs.existsSync(path.join(item.root, "missing-volume")), false);
});

test("mutating commands reject unknown flags, boolean values, and stray positionals", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const managed = path.join(item.root, "managed");
  const cases = [
    ["prepare", "--dryrun", "--json"],
    ["prepare", "--toString", "ignored", "--json"],
    ["setup", "dry-run", "--root", managed, "--json"],
    ["setup", "--dry-run=false", "--root", managed, "--json"],
    ["setup", "--root", managed, "--agents", "toString", "--json"],
    ["prune", "--apply=false", "--json"]
  ];
  for (const args of cases) {
    const result = run(args, item.env);
    assert.equal(result.status, 1, `${args.join(" ")} unexpectedly succeeded`);
  }
  assert.equal(fs.existsSync(managed), false);
  assert.equal(fs.existsSync(path.join(item.root, "config", "config.json")), false);
  const invalidAgent = run(["agent", "toString"], item.env);
  assert.equal(invalidAgent.status, 1);
  assert.equal(fs.existsSync(path.join(item.root, "data", "bin")), false);

  const installed = run(["setup", "--root", managed, "--agents", "claude", "--json"], item.env);
  assert.equal(installed.status, 0, installed.stderr);
  const launcher = path.join(item.root, "data", "bin", process.platform === "win32" ? "clean-development.cmd" : "clean-development");
  const misspelledUninstall = run(["uninstall", "--dryrun", "--json"], item.env);
  assert.equal(misspelledUninstall.status, 1);
  assert.equal(fs.existsSync(launcher), true);

  const project = path.join(item.root, "project");
  fs.mkdirSync(project);
  const projectConfig = path.join(project, ".clean-development.json");
  fs.writeFileSync(projectConfig, "{\"schemaVersion\":1}\n");
  const forced = run(["init", "--force=false", "--root", managed], item.env, project);
  assert.equal(forced.status, 1);
  assert.equal(fs.readFileSync(projectConfig, "utf8"), "{\"schemaVersion\":1}\n");
});

test("fresh Grok setup installs a repeatable command prefix without changing unrelated config", { skip: process.platform === "win32" }, (t) => {
  for (const original of [
    undefined,
    'model = "user-choice"\r\n[shell_environment_policy.set]\r\nPATH = "/custom/bin"',
    '[toolset.bash]\ntimeout_secs = 30\n'
  ]) {
    const item = fixture();
    t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
    const file = path.join(item.grok, "config.toml");
    if (original !== undefined) {
      fs.mkdirSync(item.grok, { recursive: true });
      fs.writeFileSync(file, original);
    }
    const args = ["setup", "--root", path.join(item.root, "managed"), "--agents", "grok", "--json"];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = run(args, item.env);
      assert.equal(result.status, 0, result.stderr);
      const integrations = JSON.parse(result.stdout).integrations;
      assert.equal(integrations.length, 1);
      assert.equal(integrations[0].agent, "grok");
      assert.equal(integrations[0].mode, "native-shell-environment");
      const contents = fs.readFileSync(file, "utf8");
      if (original !== undefined) assert.ok(contents.startsWith(original));
      assert.match(contents, /\[toolset\.bash\]/);
      assert.match(contents, /cmd_prefix = ".*clean-development-shell-env/);
      assert.equal((contents.match(/clean-development begin \(grok\)/g) || []).length, 1);
      assert.equal((contents.match(/^\[toolset\.bash\]$/gm) || []).length, 1);
    }
  }
});

test("Grok setup preserves an existing command prefix and reports launcher fallback", { skip: process.platform === "win32" }, (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const file = path.join(item.grok, "config.toml");
  const original = '[toolset.bash]\ncmd_prefix = "source ~/.custom-env"\ntimeout_secs = 30\n';
  fs.mkdirSync(item.grok, { recursive: true });
  fs.writeFileSync(file, original);
  const result = run(["setup", "--root", path.join(item.root, "managed"), "--agents", "grok", "--json"], item.env);
  assert.equal(result.status, 0, result.stderr);
  const integration = JSON.parse(result.stdout).integrations[0];
  assert.equal(integration.mode, "zero-context-launcher");
  assert.match(integration.reason, /already sets toolset\.bash\.cmd_prefix/);
  assert.equal(fs.readFileSync(file, "utf8"), original);
});

test("Grok update replaces its receipt when a user command prefix supersedes the owned block", { skip: process.platform === "win32" }, (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const file = path.join(item.grok, "config.toml");
  fs.mkdirSync(item.grok, { recursive: true });
  fs.writeFileSync(file, '[toolset.bash]\ntimeout_secs = 30\n');
  const args = ["setup", "--root", path.join(item.root, "managed"), "--agents", "grok", "--json"];
  const first = run(args, item.env);
  assert.equal(first.status, 0, first.stderr);
  fs.appendFileSync(file, 'cmd_prefix = "source ~/.custom-env"\n');

  const second = run(args, item.env);
  assert.equal(second.status, 0, second.stderr);
  const integrations = JSON.parse(second.stdout).integrations;
  assert.equal(integrations.length, 1);
  assert.equal(integrations[0].mode, "zero-context-launcher");
  const contents = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(contents, /clean-development begin \(grok\)/);
  assert.match(contents, /cmd_prefix = "source ~\/\.custom-env"/);
  const receipt = JSON.parse(fs.readFileSync(path.join(item.root, "data", "state", "integrations.json"), "utf8"));
  assert.deepEqual(receipt.integrations, integrations);
});

test("Grok setup migrates legacy owned TOML blocks to command-prefix routing byte-preservingly", { skip: process.platform === "win32" }, (t) => {
  for (const legacy of [
    { before: 'model = "keep-without-final-newline"', leadingSeparator: "\n\n" },
    { before: '[shell_environment_policy]\ninherit = "none"\n', after: '[mcp_servers.keep]\ncommand = "server"', headers: ["[shell_environment_policy.set]"] },
    { before: '[shell_environment_policy.set]\r\nKEEP = "yes"\r\n', after: '[[marketplace.sources]]\r\nname = "retained"', newline: "\r\n", headers: [] }
  ]) {
    const item = fixture();
    t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
    const args = ["setup", "--root", path.join(item.root, "managed"), "--agents", "grok", "--json"];
    const initial = run(args, item.env);
    assert.equal(initial.status, 0, initial.stderr);
    const entry = seedLegacyGrok(item, legacy);
    const expected = legacy.before + (legacy.after || "");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const migrated = run(args, item.env);
      assert.equal(migrated.status, 0, migrated.stderr);
      const integrations = JSON.parse(migrated.stdout).integrations;
      assert.equal(integrations.length, 1);
      assert.equal(integrations[0].agent, "grok");
      assert.equal(integrations[0].mode, "native-shell-environment");
      const contents = fs.readFileSync(entry.file, "utf8");
      assert.ok(contents.includes(legacy.before));
      if (legacy.after) assert.ok(contents.includes(legacy.after));
      assert.match(contents, /cmd_prefix = ".*clean-development-shell-env/);
      assert.equal((contents.match(/clean-development begin \(grok\)/g) || []).length, 1);
      const receipt = JSON.parse(fs.readFileSync(path.join(item.root, "data", "state", "integrations.json"), "utf8"));
      assert.deepEqual(receipt.integrations, integrations);
    }
    const removed = run(["uninstall", "--json"], item.env);
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(fs.readFileSync(entry.file, "utf8"), expected);
  }
});

test("Grok legacy migration refuses modified or ambiguous blocks and retains its receipt", (t) => {
  for (const alteration of ["modified", "ambiguous", "partial-marker", "marker-variants", "markers-removed", "reformatted-body"]) {
    const item = fixture();
    t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
    const args = ["setup", "--root", path.join(item.root, "managed"), "--agents", "grok", "--json"];
    const initial = run(args, item.env);
    assert.equal(initial.status, 0, initial.stderr);
    const entry = seedLegacyGrok(item);
    const installed = fs.readFileSync(entry.file, "utf8");
    const withoutMarkers = installed.replace(`${entry.beginMarker}\n`, "").replace(`${entry.endMarker}\n`, "");
    const variants = {
      modified: installed.replace('CLEAN_DEVELOPMENT_ACTIVE = "1"', 'CLEAN_DEVELOPMENT_ACTIVE = "user-value"'),
      ambiguous: `${entry.beginMarker}\n# Copied markers\n${entry.endMarker}\n${installed}`,
      "partial-marker": installed.replace(`${entry.beginMarker}\n`, ""),
      "marker-variants": installed.replaceAll(entry.ownershipId, "00000000-0000-4000-8000-000000000000"),
      "markers-removed": withoutMarkers,
      "reformatted-body": withoutMarkers.replace(/^PATH = .+$/m, `"PATH"=${JSON.stringify(JSON.parse(initial.stdout).runtime.binDir)}`).replace('CLEAN_DEVELOPMENT_ACTIVE = "1"', "'CLEAN_DEVELOPMENT_ACTIVE'='1'")
    };
    const changed = variants[alteration];
    fs.writeFileSync(entry.file, changed);
    const receiptFile = path.join(item.root, "data", "state", "integrations.json");
    const receipt = fs.readFileSync(receiptFile, "utf8");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const failed = run(args, item.env);
      assert.equal(failed.status, 1, alteration);
      assert.match(failed.stderr, /Cannot update owned grok integration safely/);
      assert.equal(fs.readFileSync(entry.file, "utf8"), changed);
      assert.equal(fs.readFileSync(receiptFile, "utf8"), receipt);
      assert.deepEqual(JSON.parse(receipt).integrations, [entry]);
    }
  }
});

test("Grok migration retries after its file or owned block was already removed", (t) => {
  for (const absent of ["file", "block"]) {
    const item = fixture();
    t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
    const args = ["setup", "--root", path.join(item.root, "managed"), "--agents", "grok", "--json"];
    assert.equal(run(args, item.env).status, 0);
    const entry = seedLegacyGrok(item);
    const preserved = 'model = "keep"\r\n[shell_environment_policy.set]\r\nPATH = "/user/bin"\r\nCLEAN_DEVELOPMENT_ACTIVE = "1"';
    if (absent === "file") fs.unlinkSync(entry.file);
    else fs.writeFileSync(entry.file, preserved);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = run(args, item.env);
      assert.equal(result.status, 0, result.stderr);
      const integrations = JSON.parse(result.stdout).integrations;
      assert.equal(integrations.length, 1);
      assert.equal(integrations[0].mode, "native-shell-environment");
      const receipt = JSON.parse(fs.readFileSync(path.join(item.root, "data", "state", "integrations.json"), "utf8"));
      assert.deepEqual(receipt.integrations, integrations);
      const contents = fs.readFileSync(entry.file, "utf8");
      if (absent === "block") assert.ok(contents.startsWith(preserved));
      assert.match(contents, /cmd_prefix = ".*clean-development-shell-env/);
    }
  }
});

test("Grok migration rejects changed or dangling config symlink referents", { skip: process.platform === "win32" }, (t) => {
  for (const dangling of [false, true]) {
    const item = fixture();
    t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
    const args = ["setup", "--root", path.join(item.root, "managed"), "--agents", "grok", "--json"];
    assert.equal(run(args, item.env).status, 0);
    const entry = seedLegacyGrok(item);
    const target = path.join(item.root, "replacement.toml");
    const preserved = 'model = "unrelated"\n';
    if (!dangling) fs.writeFileSync(target, preserved);
    fs.unlinkSync(entry.file);
    fs.symlinkSync(target, entry.file);
    const receiptFile = path.join(item.root, "data", "state", "integrations.json");
    const receipt = fs.readFileSync(receiptFile, "utf8");
    const result = run(args, item.env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Cannot update owned grok integration safely/);
    assert.equal(fs.readFileSync(receiptFile, "utf8"), receipt);
    assert.equal(fs.readlinkSync(entry.file), target);
    if (!dangling) assert.equal(fs.readFileSync(target, "utf8"), preserved);
  }
});

test("native receipts hash the exact owned block with normalized newlines", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const file = path.join(item.codex, "config.toml");
  fs.mkdirSync(item.codex, { recursive: true });
  const original = 'allow_login_shell = false\r\n[shell_environment_policy.set]\r\nKEEP = "user"';
  fs.writeFileSync(file, original);
  const args = ["setup", "--root", path.join(item.root, "managed"), "--agents", "codex", "--json"];
  const result = run(args, item.env);
  assert.equal(result.status, 0, result.stderr);
  const entry = JSON.parse(result.stdout).integrations[0];
  const installed = fs.readFileSync(file, "utf8");
  const block = installed.slice(installed.indexOf(entry.beginMarker), installed.indexOf(entry.endMarker) + entry.endMarker.length);
  assert.match(entry.blockSha256, /^[a-f0-9]{64}$/);
  assert.equal(entry.blockSha256, createHash("sha256").update(block.replaceAll("\r\n", "\n")).digest("hex"));
  fs.writeFileSync(file, installed.replace(block, block.replaceAll("\r\n", "\n")));
  const repeated = run(args, item.env);
  assert.equal(repeated.status, 0, repeated.stderr);
  const removed = run(["uninstall", "--json"], item.env);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(JSON.parse(removed.stdout).integrationsRemoved.retained, 0);
  assert.equal(fs.readFileSync(file, "utf8"), original);
});

test("new and legacy receipts reject PATH tampering during update migration and uninstall", (t) => {
  for (const agent of ["codex", "grok"]) {
    for (const integrity of ["hash", "legacy"]) {
      const item = fixture();
      t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
      const args = ["setup", "--root", path.join(item.root, "managed"), "--agents", agent, "--json"];
      const initial = run(args, item.env);
      assert.equal(initial.status, 0, initial.stderr);
      const entry = agent === "grok" ? seedLegacyGrok(item) : JSON.parse(initial.stdout).integrations[0];
      const installed = fs.readFileSync(entry.file, "utf8");
      const block = installed.slice(installed.indexOf(entry.beginMarker), installed.indexOf(entry.endMarker) + entry.endMarker.length);
      if (integrity === "hash") entry.blockSha256 = createHash("sha256").update(block.replaceAll("\r\n", "\n")).digest("hex");
      else delete entry.blockSha256;
      const receiptFile = path.join(item.root, "data", "state", "integrations.json");
      const receipt = { schemaVersion: 1, integrations: [entry] };
      fs.writeFileSync(receiptFile, `${JSON.stringify(receipt)}\n`);
      const receiptBytes = fs.readFileSync(receiptFile, "utf8");
      const changed = installed.replace(/^PATH = (.+)$/m, (_, encoded) => {
        const value = integrity === "hash" ? `${JSON.parse(encoded)}${path.delimiter}/user-added-bin` : path.join(item.root, "user-bin");
        return `PATH = ${JSON.stringify(value)}`;
      });
      fs.writeFileSync(entry.file, changed);
      const repeated = run(args, item.env);
      assert.equal(repeated.status, 1, `${agent} ${integrity}`);
      assert.match(repeated.stderr, /Cannot (?:update|migrate) owned/);
      assert.equal(fs.readFileSync(receiptFile, "utf8"), receiptBytes);
      const deactivated = run(["setup", "--agents", "antigravity", "--json"], item.env);
      assert.equal(deactivated.status, 1);
      assert.match(deactivated.stderr, /Cannot deactivate owned/);
      const removed = run(["uninstall", "--json"], item.env);
      assert.equal(removed.status, 0, removed.stderr);
      assert.equal(JSON.parse(removed.stdout).integrationsRemoved.retained, 1);
      assert.equal(fs.readFileSync(entry.file, "utf8"), changed);
      assert.deepEqual(JSON.parse(fs.readFileSync(receiptFile, "utf8")).integrations, [entry]);
    }
  }
});

test("native receipt validation rejects malformed block hashes", (t) => {
  for (const blockSha256 of [null, 42, "invalid", "A".repeat(64)]) {
    const item = fixture();
    t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
    const initial = run(["setup", "--root", path.join(item.root, "managed"), "--agents", "codex", "--json"], item.env);
    assert.equal(initial.status, 0, initial.stderr);
    const entry = { ...JSON.parse(initial.stdout).integrations[0], blockSha256 };
    const original = fs.readFileSync(entry.file, "utf8");
    const receiptFile = path.join(item.root, "data", "state", "integrations.json");
    fs.writeFileSync(receiptFile, `${JSON.stringify({ schemaVersion: 1, integrations: [entry] })}\n`);
    const result = run(["uninstall", "--json"], item.env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid integration receipt/);
    assert.equal(fs.readFileSync(entry.file, "utf8"), original);
  }
});

test("setup installs durable runtime and owned Claude, Codex, and Grok integrations", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const managed = path.join(item.root, "managed");
  const result = run(["setup", "--root", managed, "--agents", "claude,codex,grok", "--json"], item.env);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.root, fs.realpathSync(managed));
  assert.ok(fs.existsSync(path.join(item.root, "data", "bin", "clean-development")));
  const settings = JSON.parse(fs.readFileSync(path.join(item.claude, "settings.json"), "utf8"));
  assert.equal(settings.hooks.SessionStart.length, 1);
  assert.match(settings.hooks.SessionStart[0].hooks[0].command, /clean-development\.js.*hook session-start/);
  const codex = fs.readFileSync(path.join(item.codex, "config.toml"), "utf8");
  assert.match(codex, /clean-development begin \(codex\)/);
  assert.match(codex, /^allow_login_shell = false$/m);
  assert.match(codex, /\[shell_environment_policy\.set\]/);
  assert.match(codex, /^CLEAN_DEVELOPMENT_SESSION_MODE = "skip"$/m);
  assert.doesNotMatch(codex, /^CLEAN_DEVELOPMENT_ACTIVE =/m);
  assert.equal(summary.integrations.find((entry) => entry.agent === "grok").mode, "native-shell-environment");
  assert.match(fs.readFileSync(path.join(item.grok, "config.toml"), "utf8"), /cmd_prefix = ".*clean-development-shell-env/);

  const second = run(["setup", "--root", managed, "--agents", "claude,codex,grok", "--json"], item.env);
  assert.equal(second.status, 0, second.stderr);
  const repeated = JSON.parse(fs.readFileSync(path.join(item.claude, "settings.json"), "utf8"));
  assert.equal(repeated.hooks.SessionStart.length, 1);
  assert.equal((fs.readFileSync(path.join(item.codex, "config.toml"), "utf8").match(/clean-development begin/g) || []).length, 1);
  assert.equal((fs.readFileSync(path.join(item.grok, "config.toml"), "utf8").match(/clean-development begin/g) || []).length, 1);
  assert.equal(fs.existsSync(path.join(item.home, ".codex", "config.toml")), false);
  assert.equal(fs.existsSync(path.join(item.home, ".grok", "config.toml")), false);
});

test("explicit agent selection deactivates previously owned native integrations", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const managed = path.join(item.root, "managed");
  const first = run(["setup", "--root", managed, "--agents", "claude,codex,grok", "--json"], item.env);
  assert.equal(first.status, 0, first.stderr);
  fs.appendFileSync(path.join(item.codex, "config.toml"), "\nKEEP = \"yes\"\n");

  const second = run(["setup", "--agents", "claude", "--json"], item.env);
  assert.equal(second.status, 0, second.stderr);
  const codex = fs.readFileSync(path.join(item.codex, "config.toml"), "utf8");
  assert.match(codex, /KEEP = "yes"/);
  assert.doesNotMatch(codex, /clean-development begin \(codex\)/);
  assert.equal(fs.readFileSync(path.join(item.grok, "config.toml"), "utf8"), "");
  const integrations = JSON.parse(fs.readFileSync(path.join(item.root, "data", "state", "integrations.json"), "utf8"));
  assert.deepEqual(integrations.integrations.map((entry) => entry.agent), ["claude"]);
});

test("agent selection records successful removals before a later failure and can be retried", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const first = run(["setup", "--root", path.join(item.root, "managed"), "--agents", "claude,codex,grok", "--json"], item.env);
  assert.equal(first.status, 0, first.stderr);
  seedLegacyGrok(item);
  const grokFile = path.join(item.grok, "config.toml");
  const originalGrok = fs.readFileSync(grokFile, "utf8");
  const replacementGrok = 'model = "user-reset-config"\n';
  fs.writeFileSync(grokFile, replacementGrok);

  const args = ["setup", "--agents", "antigravity", "--json"];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const failed = run(args, item.env);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /Cannot deactivate owned grok integration safely/);
    const receipt = JSON.parse(fs.readFileSync(path.join(item.root, "data", "state", "integrations.json"), "utf8"));
    assert.deepEqual(receipt.integrations.map((entry) => entry.agent), ["grok"]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(item.claude, "settings.json"), "utf8")), {});
    assert.doesNotMatch(fs.readFileSync(path.join(item.codex, "config.toml"), "utf8"), /clean-development begin/);
    assert.equal(fs.readFileSync(grokFile, "utf8"), replacementGrok);
  }

  fs.writeFileSync(grokFile, originalGrok);
  const retried = run(args, item.env);
  assert.equal(retried.status, 0, retried.stderr);
  assert.deepEqual(JSON.parse(retried.stdout).integrations.map((entry) => entry.agent), ["antigravity"]);
  assert.doesNotMatch(fs.readFileSync(grokFile, "utf8"), /clean-development begin/);
});

test("update refreshes the runtime while preserving the configured agent selection", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const managed = path.join(item.root, "managed");
  const setup = run(["setup", "--root", managed, "--agents", "codex", "--json"], item.env);
  assert.equal(setup.status, 0, setup.stderr);
  const dryRun = run(["update", "--dry-run", "--json"], item.env);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.equal(JSON.parse(dryRun.stdout).command, "update");
  assert.deepEqual(JSON.parse(dryRun.stdout).agents, ["codex"]);
  const updated = run(["update", "--json"], item.env);
  assert.equal(updated.status, 0, updated.stderr);
  const summary = JSON.parse(updated.stdout);
  assert.equal(summary.command, "update");
  assert.deepEqual(summary.agents, ["codex"]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(item.root, "config", "config.json"), "utf8")).agents[0], "codex");
  assert.equal(fs.existsSync(path.join(item.claude, "settings.json")), false);
  assert.equal(fs.existsSync(path.join(item.codex, "config.toml")), true);
});

test("rerunning setup from an activated session does not grow the persisted PATH", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const managed = path.join(item.root, "managed");
  const first = run(["setup", "--root", managed, "--agents", "codex", "--json"], item.env);
  assert.equal(first.status, 0, first.stderr);
  const binDir = JSON.parse(first.stdout).runtime.binDir;
  const activated = { ...item.env, PATH: [binDir, binDir, item.env.PATH].join(path.delimiter) };
  const second = run(["setup", "--root", managed, "--agents", "codex", "--json"], activated);
  assert.equal(second.status, 0, second.stderr);
  for (const home of [item.codex]) {
    const contents = fs.readFileSync(path.join(home, "config.toml"), "utf8");
    const pathLine = contents.split("\n").find((line) => line.startsWith("PATH = "));
    assert.ok(pathLine);
    assert.equal((pathLine.match(new RegExp(binDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length, 1);
  }
});

test("npm and npx setup uses stable launchers instead of persisting a transient PATH", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const transient = path.join(item.root, ".npm", "_npx", "abc", "node_modules", ".bin");
  fs.mkdirSync(transient, { recursive: true });
  const env = {
    ...item.env,
    npm_execpath: path.join(item.root, "npm-cli.js"),
    npm_command: "exec",
    PATH: [transient, item.env.PATH].join(path.delimiter)
  };
  const result = run(["setup", "--root", path.join(item.root, "managed"), "--agents", "codex,grok", "--json"], env);
  assert.equal(result.status, 0, result.stderr);
  const integrations = JSON.parse(result.stdout).integrations;
  assert.deepEqual(integrations.map((entry) => entry.mode), ["zero-context-launcher", "native-shell-environment"]);
  assert.match(integrations.find((entry) => entry.agent === "codex").reason, /transient PATH/);
  assert.equal(fs.existsSync(path.join(item.codex, "config.toml")), false);
  assert.match(fs.readFileSync(path.join(item.grok, "config.toml"), "utf8"), /cmd_prefix = ".*clean-development-shell-env/);
});

test("direct setup excludes project and temporary package bins from persistent agent PATH", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const packageBin = path.join(item.root, "project", "node_modules", ".bin");
  fs.mkdirSync(packageBin, { recursive: true });
  const env = { ...item.env, PATH: [packageBin, os.tmpdir(), "/usr/bin", "/bin"].join(path.delimiter) };
  const result = run(["setup", "--root", path.join(item.root, "managed"), "--agents", "codex", "--json"], env);
  assert.equal(result.status, 0, result.stderr);
  const contents = fs.readFileSync(path.join(item.codex, "config.toml"), "utf8");
  assert.doesNotMatch(contents, /node_modules/);
  const pathLine = contents.split("\n").find((line) => line.startsWith("PATH = "));
  const persisted = JSON.parse(pathLine.slice("PATH = ".length)).split(path.delimiter);
  assert.equal(persisted.slice(1).some((entry) => entry === os.tmpdir() || entry.startsWith(`${os.tmpdir()}${path.sep}`)), false);
  assert.equal(persisted.includes("/usr/bin"), true);
});

test("native agent PATH persistence excludes the current project and active environments", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const project = path.join(item.root, "project");
  const projectBin = path.join(project, "bin");
  const virtualEnvironment = path.join(item.root, "python-env");
  const virtualBin = path.join(virtualEnvironment, "bin");
  fs.mkdirSync(projectBin, { recursive: true });
  fs.mkdirSync(virtualBin, { recursive: true });
  const env = {
    ...item.env,
    VIRTUAL_ENV: virtualEnvironment,
    PATH: [projectBin, virtualBin, "/usr/bin", "/bin"].join(path.delimiter)
  };
  const result = run(["setup", "--root", path.join(item.root, "managed"), "--agents", "codex", "--json"], env, project);
  assert.equal(result.status, 0, result.stderr);
  for (const home of [item.codex]) {
    const contents = fs.readFileSync(path.join(home, "config.toml"), "utf8");
    assert.doesNotMatch(contents, new RegExp(projectBin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(contents, new RegExp(virtualBin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(contents, /\/usr\/bin/);
  }
});

test("prepare creates effective project storage roots without changing user configuration", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const project = path.join(item.root, "project");
  const externalParent = path.join(item.root, "external-builds");
  const root = path.join(item.root, "project-storage");
  const buildRoot = path.join(externalParent, "this-project");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(externalParent, { recursive: true });
  fs.writeFileSync(path.join(project, ".clean-development.json"), `${JSON.stringify({ schemaVersion: 1, root, buildRoot })}\n`);
  const result = run(["prepare", "--json"], item.env, project);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(root, "caches")), true);
  assert.equal(fs.existsSync(buildRoot), true);
  assert.equal(fs.existsSync(path.join(root, "scratch")), true);
  assert.equal(fs.existsSync(path.join(item.root, "config", "config.json")), false);
});

test("session hook persists only environment exports and emits no output", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const managed = path.join(item.root, "managed");
  assert.equal(run(["setup", "--root", managed, "--agents", "claude", "--json"], item.env).status, 0);
  const owner = claudeOwner(item);
  const environmentFile = path.join(item.root, "session.env");
  const hooked = run(["hook", "session-start", "--owner", owner], { ...item.env, CLAUDE_ENV_FILE: environmentFile });
  assert.equal(hooked.status, 0, hooked.stderr);
  assert.equal(hooked.stdout, "");
  for (let index = 0; index < 2; index += 1) {
    const repeated = run(["hook", "session-start", "--owner", owner], { ...item.env, CLAUDE_ENV_FILE: environmentFile });
    assert.equal(repeated.status, 0, repeated.stderr);
  }
  const contents = fs.readFileSync(environmentFile, "utf8");
  assert.match(contents, /^export PATH$/m);
  assert.match(contents, /CLEAN_DEVELOPMENT_ACTIVE=/);
  assert.match(contents, /CLEAN_DEVELOPMENT_SESSION_MODE=skip/);
  assert.match(contents, /clean-development begin \(claude-session\) owner=/);
  assert.equal((contents.match(/# clean-development begin/g) || []).length, 1);
  assert.doesNotMatch(contents, /CLEAN_DEVELOPMENT_ROOT=/);
  assert.doesNotMatch(contents, /additionalContext|systemMessage|prompt/i);
  if (process.platform !== "win32") {
    const sourced = spawnSync("/bin/sh", ["-c", `. ${JSON.stringify(environmentFile)}; first=$PATH; . ${JSON.stringify(environmentFile)}; test "$PATH" = "$first"`], {
      env: { ...item.env, PATH: process.env.PATH || "/usr/bin:/bin" },
      encoding: "utf8"
    });
    assert.equal(sourced.status, 0, sourced.stderr);
    const defaults = spawnSync("/bin/sh", ["-c", `. ${JSON.stringify(environmentFile)}; printf "%s\\n%s" "$CLEAN_DEVELOPMENT_SESSION_MODE" "\${CLEAN_DEVELOPMENT_ACTIVE:-}"`], {
      env: { ...item.env, PATH: process.env.PATH || "/usr/bin:/bin" },
      encoding: "utf8"
    });
    assert.equal(defaults.status, 0, defaults.stderr);
    assert.equal(defaults.stdout, "skip\n");
  }
});

test("Claude session environment edits require receipt ownership and exact markers", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const managed = path.join(item.root, "managed");
  const setup = run(["setup", "--root", managed, "--agents", "claude", "--json"], item.env);
  assert.equal(setup.status, 0, setup.stderr);
  const receipt = JSON.parse(fs.readFileSync(path.join(item.root, "data", "state", "integrations.json"), "utf8"));
  const owner = receipt.integrations.find((entry) => entry.agent === "claude").ownershipId;
  const matching = path.join(item.root, "matching.env");
  const applied = run(["hook", "session-start", "--owner", owner], { ...item.env, CLAUDE_ENV_FILE: matching });
  assert.equal(applied.status, 0, applied.stderr);
  const validBlock = fs.readFileSync(matching, "utf8");
  assert.match(validBlock, new RegExp(`^# clean-development begin \\(claude-session\\) owner=${owner}$`, "m"));

  const missing = path.join(item.root, "missing-owner.env");
  const rejectedMissing = run(["hook", "session-start"], { ...item.env, CLAUDE_ENV_FILE: missing });
  assert.equal(rejectedMissing.status, 1);
  assert.match(rejectedMissing.stderr, /requires the installed --owner value/);
  assert.equal(fs.existsSync(missing), false);

  const mismatch = path.join(item.root, "mismatch.env");
  const rejectedOwner = run(["hook", "session-start", "--owner", "00000000-0000-4000-8000-000000000000"], {
    ...item.env, CLAUDE_ENV_FILE: mismatch
  });
  assert.equal(rejectedOwner.status, 1);
  assert.match(rejectedOwner.stderr, /owner does not match/);
  assert.equal(fs.existsSync(mismatch), false);

  const cases = new Map([
    ["generic", "# clean-development begin\nKEEP=1\n# clean-development end\n"],
    ["duplicate", `${validBlock}${validBlock}`],
    ["ambiguous", `${validBlock}# clean-development begin (someone-else)\n`],
    ["partial", `# clean-development begin (claude-session) owner=${owner}\nKEEP=1\n`],
    ["modified", validBlock.replace("export PATH\n", "export PATH\n# changed\n")]
  ]);
  for (const [name, contents] of cases) {
    const file = path.join(item.root, `${name}.env`);
    fs.writeFileSync(file, contents);
    const rejected = run(["hook", "session-start", "--owner", owner], { ...item.env, CLAUDE_ENV_FILE: file });
    assert.equal(rejected.status, 1, name);
    assert.match(rejected.stderr, /Refusing (?:unowned or ambiguous|malformed|modified) clean-development block/, name);
    assert.equal(fs.readFileSync(file, "utf8"), contents, name);
  }
});

test("the Claude native hook cleans a routed environment when a project becomes disabled", { skip: process.platform === "win32" }, (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const setup = run(["setup", "--root", path.join(item.root, "managed"), "--agents", "claude", "--json"], item.env);
  assert.equal(setup.status, 0, setup.stderr);
  const owner = claudeOwner(item);
  const project = path.join(item.root, "project");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "package.json"), "{}\n");
  const environmentFile = path.join(item.root, "disabled.env");
  const binDir = path.join(fs.realpathSync.native(item.root), "data", "bin");
  const cache = path.join(item.root, "managed", "caches", "node", "npm");
  const routed = {
    ...item.env,
    CLAUDE_ENV_FILE: environmentFile,
    PATH: `${binDir}${path.delimiter}${item.env.PATH}`,
    CLEAN_DEVELOPMENT_SESSION_MODE: "session-only",
    CLEAN_DEVELOPMENT_ACTIVE: "1",
    CLEAN_DEVELOPMENT_SESSION_ENV: JSON.stringify({ npm_config_cache: cache }),
    npm_config_cache: cache
  };
  const enabledHook = run(["hook", "session-start", "--owner", owner], routed, project);
  assert.equal(enabledHook.status, 0, enabledHook.stderr);
  assert.doesNotMatch(fs.readFileSync(environmentFile, "utf8"), /disabled-project pass-through/);

  fs.writeFileSync(path.join(project, ".clean-development.json"), '{"schemaVersion":1,"enabled":false}\n');
  const disabledHook = run(["hook", "session-start", "--owner", owner], routed, project);
  assert.equal(disabledHook.status, 0, disabledHook.stderr);
  const disabledBlock = fs.readFileSync(environmentFile, "utf8");
  assert.match(disabledBlock, /disabled-project pass-through sha256=[a-f0-9]{64}/);
  assert.match(disabledBlock, /^unset npm_config_cache$/m);
  const sourced = spawnSync("/bin/sh", ["-c", `. ${JSON.stringify(environmentFile)}; printf '%s\\n%s\\n%s\\n%s\\n%s' "$CLEAN_DEVELOPMENT_SESSION_MODE" "\${CLEAN_DEVELOPMENT_ACTIVE:-}" "\${npm_config_cache:-}" "\${CLEAN_DEVELOPMENT_SESSION_ENV:-}" "$PATH"`], {
    env: routed,
    encoding: "utf8"
  });
  assert.equal(sourced.status, 0, sourced.stderr);
  assert.deepEqual(sourced.stdout.split("\n").slice(0, 4), ["skip", "", "", ""]);
  assert.equal(sourced.stdout.split("\n")[4], item.env.PATH);

  fs.writeFileSync(environmentFile, disabledBlock.replace("unset npm_config_cache", "unset UV_CACHE_DIR"));
  const modifiedHook = run(["hook", "session-start", "--owner", owner], routed, project);
  assert.equal(modifiedHook.status, 1);
  assert.match(modifiedHook.stderr, /Refusing modified clean-development block/);
  fs.writeFileSync(environmentFile, disabledBlock);

  fs.rmSync(path.join(project, ".clean-development.json"));
  const reenabledHook = run(["hook", "session-start", "--owner", owner], routed, project);
  assert.equal(reenabledHook.status, 0, reenabledHook.stderr);
  assert.doesNotMatch(fs.readFileSync(environmentFile, "utf8"), /disabled-project pass-through/);
});

test("the Claude native hook defaults to pass-through with malformed project configuration", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const setup = run(["setup", "--root", path.join(item.root, "managed"), "--agents", "claude", "--json"], item.env);
  assert.equal(setup.status, 0, setup.stderr);
  const owner = claudeOwner(item);
  const project = path.join(item.root, "malformed-project");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, ".clean-development.json"), "{\n");
  const environmentFile = path.join(item.root, "malformed.env");
  const hooked = run(["hook", "session-start", "--owner", owner], { ...item.env, CLAUDE_ENV_FILE: environmentFile }, project);
  assert.equal(hooked.status, 0, hooked.stderr);
  const contents = fs.readFileSync(environmentFile, "utf8");
  assert.match(contents, /CLEAN_DEVELOPMENT_SESSION_MODE=skip/);
  assert.match(contents, /^export PATH$/m);
});

test("Claude invalid object shapes are preserved with launcher fallback", (t) => {
  for (const value of [[], { hooks: [] }, { hooks: { SessionStart: {} } }]) {
    const item = fixture();
    t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
    fs.mkdirSync(item.claude, { recursive: true });
    const file = path.join(item.claude, "settings.json");
    const original = `${JSON.stringify(value, null, 2)}\n`;
    fs.writeFileSync(file, original);
    const result = run(["setup", "--root", path.join(item.root, "managed"), "--agents", "claude", "--json"], item.env);
    assert.equal(result.status, 0, result.stderr);
    const integration = JSON.parse(result.stdout).integrations[0];
    assert.equal(integration.mode, "zero-context-launcher");
    assert.equal(fs.readFileSync(file, "utf8"), original);
  }
});

test("Codex explicit PATH policy is preserved and setup falls back to a launcher", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const codexDirectory = item.codex;
  fs.mkdirSync(codexDirectory, { recursive: true });
  const original = "model = \"example\"\n\n[shell_environment_policy.set]\nPATH = \"/custom/bin\"\nKEEP = \"yes\"\n";
  fs.writeFileSync(path.join(codexDirectory, "config.toml"), original);
  const result = run(["setup", "--root", path.join(item.root, "managed"), "--agents", "codex", "--json"], item.env);
  assert.equal(result.status, 0, result.stderr);
  const integration = JSON.parse(result.stdout).integrations[0];
  assert.equal(integration.mode, "zero-context-launcher");
  assert.match(integration.reason, /already sets/);
  assert.equal(fs.readFileSync(path.join(codexDirectory, "config.toml"), "utf8"), original);
});

test("Codex explicit login-shell choice is preserved with a managed launcher fallback", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  fs.mkdirSync(item.codex, { recursive: true });
  const file = path.join(item.codex, "config.toml");
  const original = 'model = "example"\nallow_login_shell = true\n';
  fs.writeFileSync(file, original);
  const result = run(["setup", "--root", path.join(item.root, "managed"), "--agents", "codex", "--json"], item.env);
  assert.equal(result.status, 0, result.stderr);
  const integration = JSON.parse(result.stdout).integrations[0];
  assert.equal(integration.mode, "zero-context-launcher");
  assert.match(integration.reason, /already sets allow_login_shell/);
  assert.equal(fs.readFileSync(file, "utf8"), original);
  assert.ok(fs.existsSync(integration.command));
});

test("fresh Codex policy places owned login control before existing tables", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  fs.mkdirSync(item.codex, { recursive: true });
  const file = path.join(item.codex, "config.toml");
  const original = 'model = "example"\n\n[mcp_servers.local]\ncommand = "server"\n';
  fs.writeFileSync(file, original);
  const result = run(["setup", "--root", path.join(item.root, "managed"), "--agents", "codex", "--json"], item.env);
  assert.equal(result.status, 0, result.stderr);
  const integration = JSON.parse(result.stdout).integrations[0];
  assert.equal(integration.mode, "native-shell-environment");
  const installed = fs.readFileSync(file, "utf8");
  assert.ok(installed.indexOf("allow_login_shell = false") < installed.indexOf("[mcp_servers.local]"));
  assert.ok(installed.indexOf("[shell_environment_policy.set]") < installed.indexOf("[mcp_servers.local]"));
  const removed = run(["uninstall", "--json"], item.env);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(fs.readFileSync(file, "utf8"), original);
});

test("Codex quoted or dotted TOML policy keys are preserved with launcher fallback", (t) => {
  const variants = [
    "[shell_environment_policy.set]\n\"PATH\" = \"/custom/bin\"\nKEEP = \"yes\"\n",
    "[\"shell_environment_policy\".\"set\"]\nPATH = \"/custom/bin\"\n"
  ];
  for (const original of variants) {
    const item = fixture();
    t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
    fs.mkdirSync(item.codex, { recursive: true });
    const file = path.join(item.codex, "config.toml");
    fs.writeFileSync(file, original);
    const result = run(["setup", "--root", path.join(item.root, "managed"), "--agents", "codex", "--json"], item.env);
    assert.equal(result.status, 0, result.stderr);
    const integration = JSON.parse(result.stdout).integrations[0];
    assert.equal(integration.mode, "zero-context-launcher");
    assert.equal(fs.readFileSync(file, "utf8"), original);
  }
});

test("a later integration failure leaves earlier edits receipted and uninstallable", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(item.codex, "config.toml"), { recursive: true });
  const failed = run(["setup", "--root", path.join(item.root, "managed"), "--agents", "claude,codex", "--json"], item.env);
  assert.equal(failed.status, 1);
  const receipt = JSON.parse(fs.readFileSync(path.join(item.root, "data", "state", "integrations.json"), "utf8"));
  assert.equal(receipt.integrations.some((entry) => entry.agent === "claude" && entry.mode === "native-hook"), true);
  const settingsFile = path.join(item.claude, "settings.json");
  assert.equal(JSON.parse(fs.readFileSync(settingsFile, "utf8")).hooks.SessionStart.length, 1);

  const removed = run(["uninstall", "--json"], item.env);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(JSON.parse(fs.readFileSync(settingsFile, "utf8")).hooks, undefined);
});

test("uninstall removes owned integration blocks and keeps data", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const managed = path.join(item.root, "managed");
  assert.equal(run(["setup", "--root", managed, "--agents", "claude,codex,grok", "--json"], item.env).status, 0);
  fs.writeFileSync(path.join(managed, "keep-me"), "retained");
  const removed = run(["uninstall", "--json"], item.env);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(fs.readFileSync(path.join(managed, "keep-me"), "utf8"), "retained");
  assert.doesNotMatch(fs.readFileSync(path.join(item.codex, "config.toml"), "utf8"), /clean-development begin/);
  assert.equal(fs.readFileSync(path.join(item.grok, "config.toml"), "utf8"), "");
  const settings = JSON.parse(fs.readFileSync(path.join(item.claude, "settings.json"), "utf8"));
  assert.equal(settings.hooks, undefined);
  assert.equal(fs.existsSync(path.join(item.root, "data", "bin")), false);
  const staleEnvironmentFile = path.join(item.root, "stale-session.env");
  const staleHook = run(["hook", "session-start"], { ...item.env, CLAUDE_ENV_FILE: staleEnvironmentFile });
  assert.equal(staleHook.status, 0, staleHook.stderr);
  assert.equal(fs.existsSync(staleEnvironmentFile), false);
  const runtime = JSON.parse(fs.readFileSync(path.join(item.root, "data", "state", "runtime.json"), "utf8"));
  assert.equal(runtime.status, "uninstalled");
  assert.equal(fs.existsSync(path.join(item.root, "data", "bin")), false);
});

test("Claude setup and uninstall preserve unrelated hooks in the same SessionStart entry", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  fs.mkdirSync(item.claude, { recursive: true });
  fs.writeFileSync(path.join(item.claude, "settings.json"), `${JSON.stringify({
    hooks: {
      SessionStart: [{
        matcher: "startup",
        hooks: [
          { type: "command", command: "/old/clean-development hook session-start" },
          { type: "command", command: "/usr/local/bin/keep-this-hook" }
        ]
      }],
      Stop: [{ matcher: "", hooks: [{ type: "command", command: "/usr/local/bin/also-keep" }] }]
    }
  }, null, 2)}\n`);

  const managed = path.join(item.root, "managed");
  const installed = run(["setup", "--root", managed, "--agents", "claude", "--json"], item.env);
  assert.equal(installed.status, 0, installed.stderr);
  let settings = JSON.parse(fs.readFileSync(path.join(item.claude, "settings.json"), "utf8"));
  assert.equal(settings.hooks.SessionStart.length, 2);
  assert.equal(settings.hooks.SessionStart[0].matcher, "startup");
  assert.deepEqual(settings.hooks.SessionStart[0].hooks, [
    { type: "command", command: "/old/clean-development hook session-start" },
    { type: "command", command: "/usr/local/bin/keep-this-hook" }
  ]);
  assert.equal(settings.hooks.Stop[0].hooks[0].command, "/usr/local/bin/also-keep");

  const removed = run(["uninstall", "--json"], item.env);
  assert.equal(removed.status, 0, removed.stderr);
  settings = JSON.parse(fs.readFileSync(path.join(item.claude, "settings.json"), "utf8"));
  assert.deepEqual(settings.hooks.SessionStart, [{
    matcher: "startup",
    hooks: [
      { type: "command", command: "/old/clean-development hook session-start" },
      { type: "command", command: "/usr/local/bin/keep-this-hook" }
    ]
  }]);
  assert.equal(settings.hooks.Stop[0].hooks[0].command, "/usr/local/bin/also-keep");
});

test("Claude setup and uninstall update a settings symlink referent without replacing the link", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const shared = path.join(item.root, "shared");
  const referent = path.join(shared, "claude-settings.json");
  const settingsLink = path.join(item.claude, "settings.json");
  fs.mkdirSync(shared, { recursive: true });
  fs.mkdirSync(item.claude, { recursive: true });
  fs.writeFileSync(referent, "{}\n");
  fs.symlinkSync(path.relative(item.claude, referent), settingsLink);

  const managed = path.join(item.root, "managed");
  const installed = run(["setup", "--root", managed, "--agents", "claude", "--json"], item.env);
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(fs.lstatSync(settingsLink).isSymbolicLink(), true);
  let settings = JSON.parse(fs.readFileSync(referent, "utf8"));
  assert.equal(settings.hooks.SessionStart.length, 1);

  const removed = run(["uninstall", "--json"], item.env);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(fs.lstatSync(settingsLink).isSymbolicLink(), true);
  settings = JSON.parse(fs.readFileSync(referent, "utf8"));
  assert.equal(settings.hooks, undefined);
});

test("Codex setup and uninstall atomically follow a config symlink and preserve unrelated content", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const shared = path.join(item.root, "shared-codex");
  const referent = path.join(shared, "config.toml");
  const configLink = path.join(item.codex, "config.toml");
  fs.mkdirSync(shared, { recursive: true });
  fs.mkdirSync(item.codex, { recursive: true });
  fs.writeFileSync(referent, "model = \"keep-me\"\n", { mode: 0o640 });
  fs.symlinkSync(path.relative(item.codex, referent), configLink);

  const installed = run(["setup", "--root", path.join(item.root, "managed"), "--agents", "codex", "--json"], item.env);
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(fs.lstatSync(configLink).isSymbolicLink(), true);
  assert.match(fs.readFileSync(referent, "utf8"), /model = "keep-me"/);
  assert.match(fs.readFileSync(referent, "utf8"), /clean-development begin/);
  assert.equal(fs.statSync(referent).mode & 0o777, 0o640);

  const removed = run(["uninstall", "--json"], item.env);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(fs.lstatSync(configLink).isSymbolicLink(), true);
  assert.match(fs.readFileSync(referent, "utf8"), /model = "keep-me"/);
  assert.doesNotMatch(fs.readFileSync(referent, "utf8"), /clean-development begin/);
  assert.equal(fs.statSync(referent).mode & 0o777, 0o640);
});

test("Codex setup and uninstall preserve unrelated TOML whitespace byte for byte", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  fs.mkdirSync(item.codex, { recursive: true });
  const file = path.join(item.codex, "config.toml");
  const original = "model = \"gpt-5\"\n\n\n\n# unrelated spacing\napproval_policy = \"never\"";
  fs.writeFileSync(file, original);
  const setup = run(["setup", "--root", path.join(item.root, "managed"), "--agents", "codex", "--json"], item.env);
  assert.equal(setup.status, 0, setup.stderr);
  assert.ok(fs.readFileSync(file, "utf8").startsWith(original));
  const removed = run(["uninstall", "--json"], item.env);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(fs.readFileSync(file, "utf8"), original);
});

test("uninstall fails visibly when the installation data home changed", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const setup = run(["setup", "--root", path.join(item.root, "managed"), "--agents", "claude", "--json"], item.env);
  assert.equal(setup.status, 0, setup.stderr);
  const launcher = path.join(item.root, "data", "bin", process.platform === "win32" ? "clean-development.cmd" : "clean-development");
  const changedData = path.join(item.root, "different-data-home");
  const removed = run(["uninstall", "--json"], { ...item.env, CLEAN_DEVELOPMENT_DATA_HOME: changedData });
  assert.equal(removed.status, 1);
  assert.match(removed.stderr, /No installation receipts.*same data-home settings/s);
  assert.equal(fs.existsSync(changedData), false);
  assert.equal(fs.existsSync(launcher), true);
});

test("uninstall rejects forged integration markers before editing agent files", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const setup = run(["setup", "--root", path.join(item.root, "managed"), "--agents", "codex", "--json"], item.env);
  assert.equal(setup.status, 0, setup.stderr);
  const configFile = path.join(item.codex, "config.toml");
  const original = fs.readFileSync(configFile, "utf8");
  const receiptFile = path.join(item.root, "data", "state", "integrations.json");
  const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
  receipt.integrations[0].beginMarker = "# forged begin";
  receipt.integrations[0].endMarker = "# forged end";
  fs.writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
  const removed = run(["uninstall", "--json"], item.env);
  assert.equal(removed.status, 1);
  assert.match(removed.stderr, /Invalid integration receipt/);
  assert.equal(fs.readFileSync(configFile, "utf8"), original);
  assert.equal(fs.existsSync(path.join(item.root, "data", "bin", process.platform === "win32" ? "clean-development.cmd" : "clean-development")), true);
});

test("uninstall rejects an integration receipt redirected to an arbitrary file", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const setup = run(["setup", "--root", path.join(item.root, "managed"), "--agents", "codex", "--json"], item.env);
  assert.equal(setup.status, 0, setup.stderr);

  const receiptFile = path.join(item.root, "data", "state", "integrations.json");
  const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
  const entry = receipt.integrations[0];
  const victim = path.join(item.root, "victim.toml");
  const victimContent = [
    "keep = \"this file\"",
    entry.beginMarker,
    "PATH = \"forged\"",
    entry.endMarker,
    ""
  ].join("\n");
  fs.writeFileSync(victim, victimContent);
  entry.file = victim;
  entry.referent = fs.realpathSync(victim);
  fs.writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);

  const removed = run(["uninstall", "--json"], item.env);
  assert.equal(removed.status, 1);
  assert.match(removed.stderr, /Invalid integration receipt/);
  assert.equal(fs.readFileSync(victim, "utf8"), victimContent);
  assert.equal(fs.existsSync(path.join(item.root, "data", "bin", process.platform === "win32" ? "clean-development.cmd" : "clean-development")), true);
});

test("uninstall fails visibly when agent config homes changed", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const managed = path.join(item.root, "managed");
  const installed = run(["setup", "--root", managed, "--agents", "claude,codex,grok", "--json"], item.env);
  assert.equal(installed.status, 0, installed.stderr);
  seedLegacyGrok(item);

  const originalClaudeFile = path.join(item.claude, "settings.json");
  const originalClaude = JSON.parse(fs.readFileSync(originalClaudeFile, "utf8"));
  originalClaude.hooks.SessionStart[0].hooks.unshift({
    type: "command",
    command: "/someone-else/clean-development hook session-start"
  });
  fs.writeFileSync(originalClaudeFile, `${JSON.stringify(originalClaude, null, 2)}\n`);
  const originalCodexFile = path.join(item.codex, "config.toml");
  fs.appendFileSync(originalCodexFile, "\n# clean-development begin (codex)\n# unrelated lookalike\n# clean-development end (codex)\n");
  const originalGrokFile = path.join(item.grok, "config.toml");

  const alternateClaude = path.join(item.root, "alternate-claude");
  const alternateCodex = path.join(item.root, "alternate-codex");
  const alternateGrok = path.join(item.root, "alternate-grok");
  fs.mkdirSync(alternateClaude, { recursive: true });
  fs.mkdirSync(alternateCodex, { recursive: true });
  fs.mkdirSync(alternateGrok, { recursive: true });
  const alternateSettings = {
    hooks: {
      SessionStart: [{
        matcher: "startup",
        hooks: [{ type: "command", command: "/alternate/clean-development hook session-start" }]
      }]
    }
  };
  const alternateToml = "# clean-development begin (codex)\n# not ours\n# clean-development end (codex)\n";
  fs.writeFileSync(path.join(alternateClaude, "settings.json"), `${JSON.stringify(alternateSettings, null, 2)}\n`);
  fs.writeFileSync(path.join(alternateCodex, "config.toml"), alternateToml);
  fs.writeFileSync(path.join(alternateGrok, "config.toml"), alternateToml.replaceAll("codex", "grok"));

  const originalClaudeBytes = fs.readFileSync(originalClaudeFile, "utf8");
  const originalCodexBytes = fs.readFileSync(originalCodexFile, "utf8");
  const originalGrokBytes = fs.readFileSync(originalGrokFile, "utf8");
  const alternateClaudeBytes = fs.readFileSync(path.join(alternateClaude, "settings.json"), "utf8");
  const alternateCodexBytes = fs.readFileSync(path.join(alternateCodex, "config.toml"), "utf8");
  const alternateGrokBytes = fs.readFileSync(path.join(alternateGrok, "config.toml"), "utf8");

  const changedEnv = {
    ...item.env,
    CLAUDE_CONFIG_DIR: alternateClaude,
    CODEX_HOME: alternateCodex,
    GROK_HOME: alternateGrok
  };
  const removed = run(["uninstall", "--json"], changedEnv);
  assert.equal(removed.status, 1);
  assert.match(removed.stderr, /Invalid integration receipt/);
  assert.equal(fs.readFileSync(originalClaudeFile, "utf8"), originalClaudeBytes);
  assert.equal(fs.readFileSync(originalCodexFile, "utf8"), originalCodexBytes);
  assert.equal(fs.readFileSync(originalGrokFile, "utf8"), originalGrokBytes);
  assert.equal(fs.readFileSync(path.join(alternateClaude, "settings.json"), "utf8"), alternateClaudeBytes);
  assert.equal(fs.readFileSync(path.join(alternateCodex, "config.toml"), "utf8"), alternateCodexBytes);
  assert.equal(fs.readFileSync(path.join(alternateGrok, "config.toml"), "utf8"), alternateGrokBytes);
  assert.equal(fs.existsSync(path.join(item.root, "data", "bin", process.platform === "win32" ? "clean-development.cmd" : "clean-development")), true);
});

test("Codex integration keeps injected PATH keys before following TOML array tables", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  fs.mkdirSync(item.codex, { recursive: true });
  const original = [
    "allow_login_shell = false",
    "[shell_environment_policy.set]",
    "KEEP = \"yes\"",
    "",
    "[[marketplace.sources]]",
    "name = \"community\"",
    "url = \"https://example.invalid/marketplace.json\"",
    ""
  ].join("\n");
  fs.writeFileSync(path.join(item.codex, "config.toml"), original);

  const result = run(["setup", "--root", path.join(item.root, "managed"), "--agents", "codex", "--json"], item.env);
  assert.equal(result.status, 0, result.stderr);
  const lines = fs.readFileSync(path.join(item.codex, "config.toml"), "utf8").split("\n");
  const arrayIndex = lines.indexOf("[[marketplace.sources]]");
  assert.ok(arrayIndex > 0);
  assert.ok(lines.findIndex((line) => line.startsWith("PATH = ")) < arrayIndex);
  assert.ok(lines.findIndex((line) => line.startsWith("CLEAN_DEVELOPMENT_SESSION_MODE = ")) < arrayIndex);
  assert.equal(lines.slice(arrayIndex + 1).some((line) => /^(?:PATH|CLEAN_DEVELOPMENT_SESSION_MODE)\s*=/.test(line)), false);
});

test("shell integration keeps environment keys before quoted TOML table names containing brackets", (t) => {
  for (const header of [
    '[mcp_servers."server[1]"]',
    "[mcp_servers.'server[1]']",
    '[[marketplace."source[1]"]]',
    '[[marketplace.\'source[1]\']] # retained comment',
    '[mcp_servers."server\\\"[1]"]'
  ]) {
    const item = fixture();
    t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
    const original = `allow_login_shell = false\n[shell_environment_policy.set]\nKEEP = "yes"\n\n${header}\ncommand = "server"\n`;
    for (const home of [item.codex]) {
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(path.join(home, "config.toml"), original);
    }

    const setup = run(["setup", "--root", path.join(item.root, "managed"), "--agents", "codex", "--json"], item.env);
    assert.equal(setup.status, 0, setup.stderr);
    assert.equal(JSON.parse(setup.stdout).integrations.every((entry) => entry.mode === "native-shell-environment"), true);
    for (const home of [item.codex]) {
      const contents = fs.readFileSync(path.join(home, "config.toml"), "utf8");
      const boundary = contents.indexOf(header);
      assert.match(contents.slice(0, boundary), /^PATH = /m, header);
      assert.match(contents.slice(0, boundary), /^CLEAN_DEVELOPMENT_SESSION_MODE = "skip"$/m, header);
      assert.equal(contents.slice(boundary), `${header}\ncommand = "server"\n`);
    }
    const removed = run(["uninstall", "--json"], item.env);
    assert.equal(removed.status, 0, removed.stderr);
    for (const home of [item.codex]) {
      assert.equal(fs.readFileSync(path.join(home, "config.toml"), "utf8"), original);
    }
  }
});

test("shell integration ignores table headers and policy keys inside multiline TOML strings", (t) => {
  for (const delimiter of ['"""', "'''"]) {
    for (const newline of ["\n", "\r\n"]) {
      const item = fixture();
      t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
      const prefix = [
        '# A comment containing both """ and \'\'\' is not a string',
        'model = "example"',
        "allow_login_shell = false",
        `notes = ${delimiter}`,
        "[shell_environment_policy.set]",
        'PATH = "this is preamble text"',
        delimiter,
        "[shell_environment_policy.set]",
        `KEEP = ${delimiter}`,
        '[mcp_servers."server[1]"]',
        'PATH = "this is value text"',
        'CLEAN_DEVELOPMENT_ACTIVE = "also value text"',
        ...(delimiter === '"""' ? [String.raw`Escaped delimiter: \"""`, "[another.fake.table]"] : ["Literal backslash: \\"]),
        `${delimiter}${delimiter[0].repeat(2)}`,
        ""
      ].join(newline);
      const suffix = ['[mcp_servers.real]', 'command = "server"'].join(newline);
      const original = prefix + suffix;
      for (const home of [item.codex]) {
        fs.mkdirSync(home, { recursive: true });
        fs.writeFileSync(path.join(home, "config.toml"), original);
      }

      const args = ["setup", "--root", path.join(item.root, "managed"), "--agents", "codex", "--json"];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const setup = run(args, item.env);
        assert.equal(setup.status, 0, setup.stderr);
        for (const entry of JSON.parse(setup.stdout).integrations) {
          assert.equal(entry.mode, "native-shell-environment", entry.reason);
          const contents = fs.readFileSync(entry.file, "utf8");
          assert.equal(contents.indexOf(entry.beginMarker), prefix.length);
          assert.equal(contents.slice(0, prefix.length), prefix);
          const blockEnd = contents.indexOf(entry.endMarker) + entry.endMarker.length;
          assert.equal(contents.slice(blockEnd), newline + suffix);
          assert.match(contents.slice(prefix.length, blockEnd), /^PATH = /m);
          assert.match(contents.slice(prefix.length, blockEnd), /^CLEAN_DEVELOPMENT_SESSION_MODE = "skip"$/m);
        }
      }
      const removed = run(["uninstall", "--json"], item.env);
      assert.equal(removed.status, 0, removed.stderr);
      for (const home of [item.codex]) {
        assert.equal(fs.readFileSync(path.join(home, "config.toml"), "utf8"), original);
      }
    }
  }
});

test("shell integration preserves unterminated multiline TOML with launcher fallback", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const original = '[shell_environment_policy.set]\nKEEP = """\n[mcp_servers.fake]\n';
  fs.mkdirSync(item.codex, { recursive: true });
  const file = path.join(item.codex, "config.toml");
  fs.writeFileSync(file, original);
  const setup = run(["setup", "--root", path.join(item.root, "managed"), "--agents", "codex", "--json"], item.env);
  assert.equal(setup.status, 0, setup.stderr);
  const entry = JSON.parse(setup.stdout).integrations[0];
  assert.equal(entry.mode, "zero-context-launcher");
  assert.match(entry.reason, /unterminated|unsupported TOML/i);
  assert.equal(fs.readFileSync(file, "utf8"), original);
});

test("escaped quoted TOML keys preserve native config with launcher fallback", (t) => {
  for (const original of [
    '["shell_environment\\u005fpolicy".set]\nKEEP = "yes"\n',
    '[shell_environment_policy.set]\n"P\\u0041TH" = "/custom/bin"\n',
    '[shell_environment_policy."\\U00000073et"]\nKEEP = "yes"\n',
    '[shell_environment_policy.set]\n"CLEAN_DEVELOPMENT_\\u0041CTIVE" = "user-value"\n'
  ]) {
    const item = fixture();
    t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
    for (const home of [item.codex]) {
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(path.join(home, "config.toml"), original);
    }
    const setup = run(["setup", "--root", path.join(item.root, "managed"), "--agents", "codex", "--json"], item.env);
    assert.equal(setup.status, 0, setup.stderr);
    for (const entry of JSON.parse(setup.stdout).integrations) {
      assert.equal(entry.mode, "zero-context-launcher");
      assert.match(entry.reason, /escaped quoted TOML keys/);
      assert.equal(fs.readFileSync(entry.configFile, "utf8"), original);
    }
    const removed = run(["uninstall", "--json"], item.env);
    assert.equal(removed.status, 0, removed.stderr);
    for (const home of [item.codex]) {
      assert.equal(fs.readFileSync(path.join(home, "config.toml"), "utf8"), original);
    }
  }
});

test("escaped TOML string values retain native shell integration", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const original = 'notes = "A \\u0041 and a quoted \\"PATH\\""\nallow_login_shell = false\n[shell_environment_policy.set]\nKEEP = "C:\\\\tools"\n';
  fs.mkdirSync(item.codex, { recursive: true });
  const file = path.join(item.codex, "config.toml");
  fs.writeFileSync(file, original);
  const setup = run(["setup", "--root", path.join(item.root, "managed"), "--agents", "codex", "--json"], item.env);
  assert.equal(setup.status, 0, setup.stderr);
  assert.equal(JSON.parse(setup.stdout).integrations[0].mode, "native-shell-environment");
  const removed = run(["uninstall", "--json"], item.env);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(fs.readFileSync(file, "utf8"), original);
});

test("owned TOML markers inside multiline strings survive reinstall and uninstall", (t) => {
  for (const delimiter of ['"""', "'''"]) {
    for (const newline of ["\n", "\r\n"]) {
      const item = fixture();
      t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
      const original = ['allow_login_shell = false', '[shell_environment_policy.set]', 'KEEP = "original"', '[mcp_servers.real]', 'command = "server"'].join(newline);
      for (const home of [item.codex]) {
        fs.mkdirSync(home, { recursive: true });
        fs.writeFileSync(path.join(home, "config.toml"), original);
      }
      const args = ["setup", "--root", path.join(item.root, "managed"), "--agents", "codex", "--json"];
      const setup = run(args, item.env);
      assert.equal(setup.status, 0, setup.stderr);
      const expected = new Map();
      for (const entry of JSON.parse(setup.stdout).integrations) {
        const prefix = [`notes = ${delimiter}`, entry.beginMarker, "Preserve this user text", entry.endMarker, delimiter, ""].join(newline);
        const installed = prefix + fs.readFileSync(entry.file, "utf8");
        fs.writeFileSync(entry.file, installed);
        expected.set(entry.file, { installed, uninstalled: prefix + original });
      }

      const repeated = run(args, item.env);
      assert.equal(repeated.status, 0, repeated.stderr);
      for (const entry of JSON.parse(repeated.stdout).integrations) {
        assert.equal(entry.mode, "native-shell-environment", entry.reason);
        assert.equal(fs.readFileSync(entry.file, "utf8"), expected.get(entry.file).installed);
      }
      const removed = run(["uninstall", "--json"], item.env);
      assert.equal(removed.status, 0, removed.stderr);
      assert.equal(JSON.parse(removed.stdout).integrationsRemoved.retained, 0);
      for (const [file, value] of expected) {
        assert.equal(fs.readFileSync(file, "utf8"), value.uninstalled);
      }
    }
  }
});

test("ambiguous visible TOML ownership markers are retained without editing config", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const setup = run(["setup", "--root", path.join(item.root, "managed"), "--agents", "codex", "--json"], item.env);
  assert.equal(setup.status, 0, setup.stderr);
  const entry = JSON.parse(setup.stdout).integrations[0];
  const original = `${entry.beginMarker}\n# An ambiguous copied comment block\n${entry.endMarker}\n${fs.readFileSync(entry.file, "utf8")}`;
  fs.writeFileSync(entry.file, original);
  const removed = run(["uninstall", "--json"], item.env);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(JSON.parse(removed.stdout).integrationsRemoved.retained, 1);
  assert.equal(fs.readFileSync(entry.file, "utf8"), original);
});

test("a copied marker cannot replace a missing owned marker and consume user settings", (t) => {
  for (const missing of ["begin", "end"]) {
    const item = fixture();
    t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
    const setup = run(["setup", "--root", path.join(item.root, "managed"), "--agents", "codex", "--json"], item.env);
    assert.equal(setup.status, 0, setup.stderr);
    const entry = JSON.parse(setup.stdout).integrations[0];
    const installed = fs.readFileSync(entry.file, "utf8");
    const original = missing === "begin"
      ? `${entry.beginMarker}\nmodel = "preserve-user-setting"\n${installed.replace(`${entry.beginMarker}\n`, "")}`
      : `${installed.replace(`${entry.endMarker}\n`, "")}KEEP_USER_TEXT = "preserve-user-setting"\n${entry.endMarker}\n`;
    fs.writeFileSync(entry.file, original);
    const removed = run(["uninstall", "--json"], item.env);
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(JSON.parse(removed.stdout).integrationsRemoved.retained, 1);
    assert.equal(fs.readFileSync(entry.file, "utf8"), original);
  }
});

test("repeat setup refuses altered owned TOML blocks without changing config or receipts", (t) => {
  for (const alteration of ["missing-settings", "ambiguous-markers", "missing-marker"]) {
    const item = fixture();
    t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
    const args = ["setup", "--root", path.join(item.root, "managed"), "--agents", "codex", "--json"];
    const setup = run(args, item.env);
    assert.equal(setup.status, 0, setup.stderr);
    const entry = JSON.parse(setup.stdout).integrations[0];
    const installed = fs.readFileSync(entry.file, "utf8");
    const original = alteration === "missing-settings"
      ? installed.split("\n").filter((line) => !/^(?:PATH|CLEAN_DEVELOPMENT_ACTIVE) = /.test(line)).join("\n")
      : alteration === "ambiguous-markers"
        ? `${entry.beginMarker}\n# Copied markers\n${entry.endMarker}\n${installed}`
        : installed.replace(entry.endMarker, "# User changed the end marker");
    fs.writeFileSync(entry.file, original);
    const receiptFile = path.join(item.root, "data", "state", "integrations.json");
    const receipt = fs.readFileSync(receiptFile, "utf8");
    const repeated = run(args, item.env);
    assert.equal(repeated.status, 1, alteration);
    assert.match(repeated.stderr, /Cannot update owned codex integration safely/);
    assert.equal(fs.readFileSync(entry.file, "utf8"), original);
    assert.equal(fs.readFileSync(receiptFile, "utf8"), receipt);
  }
});
