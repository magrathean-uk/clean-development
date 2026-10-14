import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { resolveConfig } from "../src/config.js";
import { installAgentIntegrations, planMissingIntegrationRepairs } from "../src/integrations.js";
import { withoutCleanDevelopmentEnvironment } from "../scripts/harness-utils.mjs";

const cli = path.resolve("bin/clean-development.js");

function fixture() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "clean-development-repair-")));
  const env = {
    ...withoutCleanDevelopmentEnvironment(),
    CLEAN_DEVELOPMENT_HOME: path.join(root, "home"),
    CLEAN_DEVELOPMENT_DATA_HOME: path.join(root, "data"),
    CLEAN_DEVELOPMENT_CONFIG_HOME: path.join(root, "config"),
    CODEX_HOME: path.join(root, "codex"),
    GROK_HOME: path.join(root, "grok")
  };
  for (const name of ["npm_execpath", "NPM_EXECPATH", "npm_lifecycle_event", "npm_command"]) delete env[name];
  return { root, env, managed: path.join(root, "managed") };
}

function run(item, args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: process.cwd(), env: item.env, encoding: "utf8" });
}

function setup(item, agents) {
  const result = run(item, ["setup", "--root", item.managed, "--agents", agents, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function receipt(item) {
  const file = path.join(item.root, "data", "state", "integrations.json");
  return { file, text: fs.readFileSync(file, "utf8"), value: JSON.parse(fs.readFileSync(file, "utf8")) };
}

function makeMissingBlock(item, agent, unrelated = '[user]\nkeep = "preserved"\n') {
  const initial = setup(item, agent);
  const entry = initial.integrations.find((value) => value.agent === agent);
  assert.equal(entry.mode, "native-shell-environment");
  fs.writeFileSync(entry.file, unrelated);
  return { initial, entry, unrelated };
}

test("Codex missing owned TOML can be repaired only by explicit consent", (t) => {
    const agent = "codex";
    const item = fixture();
    t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
    const { entry, unrelated } = makeMissingBlock(item, agent);
    const oldReceipt = receipt(item);
    const defaultPreview = run(item, ["setup", "--root", item.managed, "--agents", agent, "--dry-run", "--json"]);
    assert.equal(defaultPreview.status, 0, defaultPreview.stderr);
    assert.equal(Object.hasOwn(JSON.parse(defaultPreview.stdout), "integrationRepairs"), false);
    assert.equal(fs.readFileSync(entry.file, "utf8"), unrelated);
    assert.equal(fs.readFileSync(oldReceipt.file, "utf8"), oldReceipt.text);

    const preview = run(item, ["update", "--root", item.managed, "--repair-missing", "--dry-run", "--json"]);
    assert.equal(preview.status, 0, preview.stderr);
    const repairs = JSON.parse(preview.stdout).integrationRepairs;
    assert.deepEqual(repairs.map(({ agent: name, file }) => ({ agent: name, file })), [{ agent, file: entry.file }]);
    assert.match(repairs[0].reason, /recorded TOML block is absent/);
    assert.equal(JSON.stringify(repairs).includes("keep ="), false);
    assert.equal(fs.readFileSync(entry.file, "utf8"), unrelated);
    assert.equal(fs.readFileSync(oldReceipt.file, "utf8"), oldReceipt.text);

    const refused = run(item, ["update", "--root", item.managed, "--json"]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, new RegExp(`Cannot update owned ${agent} integration safely`));
    assert.equal(fs.readFileSync(entry.file, "utf8"), unrelated);
    assert.equal(fs.readFileSync(oldReceipt.file, "utf8"), oldReceipt.text);

    const applied = run(item, ["update", "--root", item.managed, "--repair-missing", "--json"]);
    assert.equal(applied.status, 0, applied.stderr);
    const updated = JSON.parse(applied.stdout);
    assert.equal(updated.integrations.find((value) => value.agent === agent).mode, "native-shell-environment");
    assert.equal(fs.readFileSync(entry.file, "utf8").includes("keep = \"preserved\""), true);
    assert.equal((fs.readFileSync(entry.file, "utf8").match(new RegExp(`clean-development begin \\(${agent}\\)`, "g")) || []).length, 1);
  });

test("repair refuses modified, partial, other-owner, ambiguous, unmarked remnants, and missing files", (t) => {
  for (const variant of ["modified", "partial", "other-owner", "ambiguous", "unmarked", "missing-file"]) {
    const item = fixture();
    t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
    const { entry, initial } = makeMissingBlock(item, "codex");
    let content;
    if (variant === "modified") {
      content = `${entry.beginMarker}\nCLEAN_DEVELOPMENT_SESSION_MODE = "persist"\n${entry.endMarker}\n`;
    } else if (variant === "partial") content = `${entry.beginMarker}\n`;
    else if (variant === "other-owner") content = `# clean-development begin (codex) owner=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\n# clean-development end (codex) owner=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\n`;
    else if (variant === "ambiguous") {
      content = '[user]\nkeep = "preserved"\n';
      const stored = receipt(item);
      stored.value.integrations.push({ ...entry });
      fs.writeFileSync(stored.file, `${JSON.stringify(stored.value, null, 2)}\n`);
    } else if (variant === "missing-file") {
      content = undefined;
      fs.unlinkSync(entry.file);
    } else content = `[shell_environment_policy.set]\nPATH = ${JSON.stringify(initial.runtime.binDir)}\nCLEAN_DEVELOPMENT_SESSION_MODE = "skip"\n`;
    if (content !== undefined) fs.writeFileSync(entry.file, content);
    const beforeReceipt = receipt(item);
    const preview = run(item, ["update", "--root", item.managed, "--agents", "codex", "--repair-missing", "--dry-run", "--json"]);
    assert.equal(preview.status, 0, `${variant}: ${preview.stderr}`);
    assert.deepEqual(JSON.parse(preview.stdout).integrationRepairs, [], variant);
    const applied = run(item, ["update", "--root", item.managed, "--agents", "codex", "--repair-missing", "--json"]);
    assert.equal(applied.status, 1, `${variant}: ${applied.stderr}`);
    assert.match(applied.stderr, /Cannot update owned codex integration safely/);
    if (variant === "missing-file") assert.equal(fs.existsSync(entry.file), false);
    else assert.equal(fs.readFileSync(entry.file, "utf8"), content, variant);
    assert.equal(fs.readFileSync(beforeReceipt.file, "utf8"), beforeReceipt.text, variant);
  }
});

test("repair apply revalidates configuration changed after dry-run", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const initial = setup(item, "codex");
  const entry = initial.integrations.find((value) => value.agent === "codex");
  fs.writeFileSync(entry.file, '[user]\nkeep = "before-preview"\n');
  const preview = run(item, ["update", "--root", item.managed, "--repair-missing", "--dry-run", "--json"]);
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).integrationRepairs.length, 1);
  const changed = `[shell_environment_policy.set]\nPATH = ${JSON.stringify(initial.runtime.binDir)}\nCLEAN_DEVELOPMENT_SESSION_MODE = "skip"\n`;
  fs.writeFileSync(entry.file, changed);
  const apply = run(item, ["update", "--root", item.managed, "--repair-missing", "--json"]);
  assert.equal(apply.status, 1);
  assert.match(apply.stderr, /Cannot update owned codex integration safely/);
  assert.equal(fs.readFileSync(entry.file, "utf8"), changed);

});

test("repair preview and apply never remove a block restored between validation reads", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const initial = setup(item, "codex");
  const entry = initial.integrations.find((value) => value.agent === "codex");
  const ownedBlock = fs.readFileSync(entry.file, "utf8");
  const absentFile = '[user]\nkeep = "preserved"\n';
  fs.writeFileSync(entry.file, absentFile);
  const config = resolveConfig({ env: item.env, overrides: { root: item.managed }, includeProject: false });

  const originalOpen = fs.openSync;
  const originalWrite = fs.writeFileSync;
  let previewFileOpens = 0;
  fs.openSync = function (file, ...args) {
    if (path.resolve(String(file)) === path.resolve(entry.file) && ++previewFileOpens === 2) {
      originalWrite.call(fs, entry.file, ownedBlock, "utf8");
    }
    return originalOpen.call(fs, file, ...args);
  };
  try {
    assert.deepEqual(planMissingIntegrationRepairs(config, ["codex"], item.env), []);
  } finally {
    fs.openSync = originalOpen;
  }
  assert.equal(previewFileOpens, 2);
  assert.equal(fs.readFileSync(entry.file, "utf8"), ownedBlock);

  fs.writeFileSync(entry.file, absentFile);
  const beforeReceipt = receipt(item);
  let applyFileOpens = 0;
  fs.openSync = function (file, ...args) {
    if (path.resolve(String(file)) === path.resolve(entry.file) && ++applyFileOpens === 2) {
      originalWrite.call(fs, entry.file, ownedBlock, "utf8");
    }
    return originalOpen.call(fs, file, ...args);
  };
  try {
    assert.throws(() => installAgentIntegrations(
      config, { binDir: initial.runtime.binDir }, ["codex"], item.env, process.cwd(), { repairMissing: true }
    ), /Cannot update owned codex integration safely/);
  } finally {
    fs.openSync = originalOpen;
  }
  assert.equal(applyFileOpens, 2);
  assert.equal(fs.readFileSync(entry.file, "utf8"), ownedBlock);
  assert.equal(fs.readFileSync(beforeReceipt.file, "utf8"), beforeReceipt.text);
});

test("repair preview of an existing owned block is empty and read-only", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const initial = setup(item, "codex");
  const entry = initial.integrations.find((value) => value.agent === "codex");
  const before = fs.readFileSync(entry.file, "utf8");
  const config = resolveConfig({ env: item.env, overrides: { root: item.managed }, includeProject: false });
  assert.deepEqual(planMissingIntegrationRepairs(config, ["codex"], item.env), []);
  assert.equal(fs.readFileSync(entry.file, "utf8"), before);
});

test("update repair preserves the configured agent selection", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const initial = setup(item, "codex,grok");
  const codex = initial.integrations.find((value) => value.agent === "codex");
  fs.writeFileSync(codex.file, '[user]\nkeep = "preserved"\n');
  const updated = run(item, ["update", "--root", item.managed, "--repair-missing", "--json"]);
  assert.equal(updated.status, 0, updated.stderr);
  const summary = JSON.parse(updated.stdout);
  assert.deepEqual(summary.agents, ["codex", "grok"]);
  const installed = receipt(item).value.integrations;
  assert.deepEqual(installed.map((entry) => entry.agent).sort(), ["codex", "grok"]);
});

test("eligible Codex absence falls back to launcher when user policy cannot be preserved natively", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const initial = setup(item, "codex");
  const entry = initial.integrations.find((value) => value.agent === "codex");
  const userPolicy = '[shell_environment_policy]\ninherit = "all"\n\n[shell_environment_policy.set]\nMODEL = "keep"\n';
  fs.writeFileSync(entry.file, userPolicy);
  const preview = run(item, ["update", "--root", item.managed, "--repair-missing", "--dry-run", "--json"]);
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).integrationRepairs.length, 1);
  const updated = run(item, ["update", "--root", item.managed, "--repair-missing", "--json"]);
  assert.equal(updated.status, 0, updated.stderr);
  const integration = JSON.parse(updated.stdout).integrations.find((value) => value.agent === "codex");
  assert.equal(integration.mode, "zero-context-launcher");
  assert.equal(fs.readFileSync(entry.file, "utf8"), userPolicy);
});
