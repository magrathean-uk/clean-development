import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveConfig } from "../src/config.js";
import { integrationHealth, integrationStatus } from "../src/integrations.js";
import { MAX_METADATA_BYTES } from "../src/io.js";
import { formatStorageStatus, storageStatus } from "../src/status.js";
import { isolatedEnvironment } from "../scripts/harness-utils.mjs";

const cli = fileURLToPath(new URL("../bin/clean-development.js", import.meta.url));

function run(item, args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: item.root, env: item.env, encoding: "utf8" });
}

function fixture(t, agents = "claude,codex,grok", initialConfig = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "clean-development-integration-health-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...isolatedEnvironment(root), HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"),
    CLAUDE_CONFIG_DIR: path.join(root, "claude"), CODEX_HOME: path.join(root, "codex"), GROK_HOME: path.join(root, "grok") };
  for (const name of ["npm_execpath", "NPM_EXECPATH", "npm_lifecycle_event", "npm_command"]) delete env[name];
  fs.mkdirSync(env.HOME, { recursive: true });
  for (const [agent, content] of Object.entries(initialConfig)) {
    const directory = env[agent === "codex" ? "CODEX_HOME" : "GROK_HOME"];
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "config.toml"), content);
  }
  const item = { root, env };
  const setup = run(item, ["setup", "--agents", agents, "--json"]);
  assert.equal(setup.status, 0, setup.stderr);
  item.config = resolveConfig({ cwd: root, env, includeProject: false });
  item.receipt = JSON.parse(setup.stdout).integrations;
  return item;
}

function row(item, agent, env = item.env) {
  return integrationHealth(item.config, env).integrations.find((entry) => entry.agent === agent);
}

function tree(root) {
  return fs.readdirSync(root, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name)).map((entry) => {
    const file = path.join(root, entry.name);
    const details = fs.lstatSync(file);
    return { name: entry.name, mode: details.mode, mtime: details.mtimeMs,
      content: entry.isDirectory() ? tree(file) : entry.isSymbolicLink() ? fs.readlinkSync(file) : fs.readFileSync(file).toString("base64") };
  });
}

function preserve(t, item, operation) {
  const before = tree(item.root);
  operation();
  assert.deepEqual(tree(item.root), before, "diagnostics must not write fixture configuration, receipts or runtime");
}

test("observed integration presence is separate from recorded ownership and does not write", (t) => {
  const item = fixture(t);
  preserve(t, item, () => {
    const report = storageStatus(item.config, { env: item.env });
    assert.deepEqual(report.integrations, item.receipt);
    assert.equal(report.integrationHealth.receipt.status, "present");
    assert.ok(report.integrationHealth.integrations.every((entry) => entry.status === "present"));
    assert.match(formatStorageStatus(report), /Integration codex: present/);
    assert.match(report.integrationHealth.scope, /already-running host environments are independent/);
    const doctor = run(item, ["doctor", "--json"]);
    assert.equal(doctor.status, 0, doctor.stderr);
  });
});

for (const agent of ["codex", "grok"]) {
  test(`${agent} diagnostics classify missing, modified, ambiguous and unavailable owned blocks`, (t) => {
    const item = fixture(t, agent);
    const entry = item.receipt.find((value) => value.agent === agent);
    const original = fs.readFileSync(entry.file, "utf8");
    fs.writeFileSync(entry.file, 'keep = "user-value"\n');
    preserve(t, item, () => {
      assert.equal(row(item, agent).status, "missing");
      const status = run(item, ["status", "--json"]);
      assert.equal(status.status, 0, status.stderr);
      assert.equal(JSON.parse(status.stdout).integrations[0].ownedBlock, true);
      assert.equal(JSON.parse(status.stdout).integrationHealth.integrations.find((value) => value.agent === agent).status, "missing");
      const doctor = run(item, ["doctor", "--json"]);
      assert.equal(doctor.status, 1, doctor.stderr);
      assert.equal(JSON.parse(doctor.stdout).checks.find((value) => value.name === `integration:${agent}`).optional, false);
    });
    fs.writeFileSync(entry.file, original.replace(agent === "codex" ? 'CLEAN_DEVELOPMENT_SESSION_MODE = "skip"' : "cmd_prefix = ",
      agent === "codex" ? 'CLEAN_DEVELOPMENT_SESSION_MODE = "session-only"' : "cmd_prefix = \"changed\" # "));
    preserve(t, item, () => assert.equal(row(item, agent).status, "modified"));
    fs.writeFileSync(entry.file, original + original);
    preserve(t, item, () => assert.equal(row(item, agent).status, "ambiguous"));
    fs.writeFileSync(entry.file, "x".repeat(MAX_METADATA_BYTES + 1));
    preserve(t, item, () => {
      assert.equal(row(item, agent).status, "unavailable");
      assert.match(row(item, agent).detail, /Metadata exceeds/);
    });
    fs.unlinkSync(entry.file);
    preserve(t, item, () => assert.equal(row(item, agent).reason, "configuration-missing"));
  });
}

test("Claude diagnostics validate the recorded lifecycle matcher and owned command without altering unrelated hooks", (t) => {
  const item = fixture(t, "claude");
  const entry = item.receipt[0];
  const settings = JSON.parse(fs.readFileSync(entry.file, "utf8"));
  const owned = settings.hooks.SessionStart[0];
  settings.hooks.Stop = [{ hooks: [{ type: "command", command: "keep me" }] }];
  settings.hooks.SessionStart.push({ matcher: "startup", hooks: [{ type: "command", command: "keep too" }] });
  fs.writeFileSync(entry.file, JSON.stringify(settings));
  preserve(t, item, () => assert.equal(row(item, "claude").status, "present"));
  owned.matcher = "startup";
  fs.writeFileSync(entry.file, JSON.stringify(settings));
  preserve(t, item, () => assert.equal(row(item, "claude").status, "modified"));
  owned.matcher = "startup|resume|clear|compact|fork";
  settings.hooks.SessionStart.push(owned);
  fs.writeFileSync(entry.file, JSON.stringify(settings));
  preserve(t, item, () => assert.equal(row(item, "claude").status, "ambiguous"));
  settings.hooks.SessionStart = settings.hooks.SessionStart.filter((group) => group !== owned);
  fs.writeFileSync(entry.file, JSON.stringify(settings));
  preserve(t, item, () => assert.equal(row(item, "claude").status, "missing"));
  fs.writeFileSync(entry.file, '{"secret": "do-not-echo-this-value",');
  preserve(t, item, () => {
    assert.equal(row(item, "claude").status, "modified");
    assert.ok(!JSON.stringify(integrationHealth(item.config, item.env)).includes("do-not-echo-this-value"));
  });
});

test("permission failures are unavailable and diagnostics never try to repair them", (t) => {
  const item = fixture(t, "codex");
  const file = item.receipt[0].file;
  const stat = fs.statSync;
  t.mock.method(fs, "statSync", (target, ...args) => {
    if (target === file) throw Object.assign(new Error("fixture access denied"), { code: "EACCES" });
    return stat(target, ...args);
  });
  preserve(t, item, () => {
    assert.equal(row(item, "codex").status, "unavailable");
    assert.match(row(item, "codex").detail, /EACCES/);
  });
});

test("installed leaf symlinks remain present; changed referents and config-home choices are diagnosed", { skip: process.platform === "win32" }, (t) => {
  const item = fixture(t, "codex");
  const entry = item.receipt[0];
  const receiptFile = path.join(item.config.locations.stateDir, "integrations.json");
  const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
  const target = path.join(item.root, "kept-config.toml");
  fs.renameSync(entry.file, target);
  fs.symlinkSync(target, entry.file);
  receipt.integrations[0].referent = target;
  fs.writeFileSync(receiptFile, JSON.stringify(receipt));
  preserve(t, item, () => assert.equal(row(item, "codex").status, "present"));
  const other = path.join(item.root, "other-config.toml");
  fs.copyFileSync(target, other);
  fs.unlinkSync(entry.file);
  fs.symlinkSync(other, entry.file);
  preserve(t, item, () => assert.equal(row(item, "codex").reason, "referent-changed"));
  preserve(t, item, () => assert.equal(row(item, "codex", { ...item.env, CODEX_HOME: path.join(item.root, "different-home") }).reason, "configuration-path-changed"));
});

test("invalid receipts remain explicit status and doctor failures without weakening strict ownership readers", (t) => {
  const item = fixture(t, "claude");
  const receiptFile = path.join(item.config.locations.stateDir, "integrations.json");
  for (const content of ['{"schemaVersion":999,"integrations":[]}', '{"secret":"do-not-disclose-this",']) {
    fs.writeFileSync(receiptFile, content);
    preserve(t, item, () => {
      const status = run(item, ["status", "--json"]);
      assert.equal(status.status, 0, status.stderr);
      const report = JSON.parse(status.stdout);
      assert.equal(report.integrationHealth.receipt.status, "invalid");
      assert.deepEqual(report.integrations, []);
      assert.ok(!status.stdout.includes("do-not-disclose-this"));
      const doctor = run(item, ["doctor", "--json"]);
      assert.equal(doctor.status, 1, doctor.stderr);
      assert.equal(JSON.parse(doctor.stdout).checks.find((value) => value.name === "integration-receipt").ok, false);
      assert.throws(() => integrationStatus(item.config, item.env));
    });
  }
});

test("unrecorded optional hosts do not fail doctor; selected missing receipts do", (t) => {
  const item = fixture(t, "claude");
  const doctor = run(item, ["doctor", "--json"]);
  assert.equal(doctor.status, 0, doctor.stderr);
  const check = JSON.parse(doctor.stdout).checks.find((value) => value.name === "integration:codex");
  assert.equal(check.status, "missing"); assert.equal(check.optional, true); assert.equal(check.recorded, false);
  fs.unlinkSync(path.join(item.config.locations.stateDir, "integrations.json"));
  preserve(t, item, () => {
    const missing = run(item, ["doctor", "--json"]);
    assert.equal(missing.status, 1, missing.stderr);
    assert.equal(JSON.parse(missing.stdout).checks.find((value) => value.name === "integration:claude").reason, "integration-not-recorded");
  });
});

test("legacy block presence requires the recorded runtime prefix and assignments in their expected table", (t) => {
  const item = fixture(t, "codex");
  const entry = item.receipt[0];
  const receiptFile = path.join(item.config.locations.stateDir, "integrations.json");
  const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
  delete receipt.integrations[0].blockSha256;
  fs.writeFileSync(receiptFile, JSON.stringify(receipt));
  const original = fs.readFileSync(entry.file, "utf8");
  preserve(t, item, () => assert.equal(row(item, "codex").reason, "legacy-owned-block-matched"));
  fs.writeFileSync(entry.file, original.replace(JSON.stringify(item.config.locations.binDir).slice(1, -1), "/unowned/bin"));
  preserve(t, item, () => assert.equal(row(item, "codex").status, "modified"));
  fs.writeFileSync(entry.file, `[user_table]\n${original}`);
  preserve(t, item, () => assert.equal(row(item, "codex").reason, "owned-block-scope-changed"));
});

test("native health accepts normalized newlines and commented user tables while ignoring markers in multiline strings", (t) => {
  const item = fixture(t, "codex,grok", {
    codex: 'allow_login_shell = false\n[shell_environment_policy.set] # retained user table\nKEEP = "yes"\n',
    grok: '[toolset.bash] # retained user table\ntimeout_secs = 30\n'
  });
  for (const entry of item.receipt) {
    const original = fs.readFileSync(entry.file, "utf8");
    const withLiteralMarkers = `unrelated = """\n${original}\n"""\n${original}`;
    fs.writeFileSync(entry.file, withLiteralMarkers.replaceAll("\n", "\r\n"));
    preserve(t, item, () => assert.equal(row(item, entry.agent).status, "present"));
  }
});

test("an unchanged owned block cannot make invalid surrounding native TOML healthy", (t) => {
  const item = fixture(t, "codex"), entry = item.receipt[0], original = fs.readFileSync(entry.file, "utf8");
  const invalid = [
    '\nBAD = unquoted_invalid_value\n',
    '\n[review]\nkey = 1\n"key" = 2\n',
    '\n[review]\n"\\u006bey" = 1\nkey = 2\n',
    '\n[review]\nkey = 1\n[review]\nother = 2\n',
    '\n[review]\ninner.answer = 42\n[review.inner]\nother = 2\n',
    '\n[review]\nvalue = 1\n[review.value.child]\nanswer = 2\n',
    '\n[review]\nleading_zero = 01\n',
    '\n[review]\nbroken_array = [1,,2]\n',
    '\n[review]\nvalue = "bad\\qescape"\n',
    '\n[review]\n"unterminated key = 1\n',
    '\n# forbidden raw control: \u0000\n'
  ];
  for (const suffix of invalid) {
    fs.writeFileSync(entry.file, original + suffix);
    preserve(t, item, () => {
      assert.equal(row(item, "codex").status, "modified", "invalid surrounding file must not establish native presence");
      const doctor = run(item, ["doctor", "--json"]);
      assert.equal(doctor.status, 1, doctor.stderr);
      assert.ok(!doctor.stdout.includes("unquoted_invalid_value"), "diagnostic reasons must not echo configuration values");
    });
  }
});

test("bounded native health recognizes common typed values and decoded quoted table/key scopes", (t) => {
  const item = fixture(t, "codex"), entry = item.receipt[0], original = fs.readFileSync(entry.file, "utf8");
  const suffix = [
    '', '[profiles."quoted.table"] # retained scope',
    'model = "escaped\\\"model"', "literal = 'literal # content'", 'retry_limit = 1_000',
    'ratio = -1.25e+2', 'hex = 0xDE_AD', 'octal = 0o755', 'binary = 0b1010',
    'infinite = +inf', 'not_number = nan',
    'flags = [true, false, [1, 2], "literal # value",] # retained comment',
    'message = """multi', 'line with two ending quotes"""""',
    '"\\u0064ecoded" = "quoted key"', ''
  ].join('\n');
  fs.writeFileSync(entry.file, original + suffix);
  preserve(t, item, () => {
    assert.equal(row(item, "codex").status, "present");
    const doctor = run(item, ["doctor", "--json"]);
    assert.equal(doctor.status, 0, doctor.stderr);
  });
});

test("unverified native TOML forms and parsing limits are unavailable rather than silently healthy", (t) => {
  const item = fixture(t, "codex"), entry = item.receipt[0], original = fs.readFileSync(entry.file, "utf8");
  for (const suffix of [
    '\n[review]\ninline = { key = "value" }\n',
    '\n[[review]]\nkey = "value"\n',
    '\n[review]\ncreated = 1979-05-27T07:32:00Z\n',
    '\n[review]\nnew_escape = "\\e"\n',
    `\n${Array.from({ length: 34 }, () => "part").join(".")} = 1\n`,
    `\n[review]\nnested = ${"[".repeat(34)}1${"]".repeat(34)}\n`
  ]) {
    fs.writeFileSync(entry.file, original + suffix);
    preserve(t, item, () => {
      const observed = row(item, "codex");
      assert.equal(observed.status, "unavailable");
      assert.equal(observed.reason, "native-toml-form-unverified");
      assert.match(observed.detail, /bounded diagnostic subset/);
      const doctor = run(item, ["doctor", "--json"]);
      assert.equal(doctor.status, 1, doctor.stderr);
    });
  }
});
