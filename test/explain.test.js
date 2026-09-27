import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { environmentForTool } from "../src/adapters.js";
import { resolveConfig } from "../src/config.js";
import { explainCommand, formatExplanation } from "../src/explain.js";
import { applySessionPlan, planSession } from "../src/session.js";
import { isolatedEnvironment } from "../scripts/harness-utils.mjs";

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "clean-development-explain-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "project");
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, "package.json"), "{}\n");
  const env = isolatedEnvironment(root);
  delete env.CLEAN_DEVELOPMENT_ROOT;
  const projectFile = path.join(cwd, ".clean-development.json");
  const config = { schemaVersion: 1, root: path.join(root, "managed") };
  fs.writeFileSync(projectFile, JSON.stringify(config));
  return { root, cwd, env, projectFile, config };
}

function snapshot(root) {
  const result = {};
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    result[entry.name] = entry.isDirectory() ? snapshot(file) : fs.readFileSync(file).toString("base64");
  }
  return result;
}

function variable(report, name) {
  return report.routing.variables.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
}

test("explain predicts the same npm route as dispatch without creating or changing files", (t) => {
  const item = fixture(t);
  const before = snapshot(item.root);
  const envBefore = { ...item.env };
  const report = explainCommand("npm", ["test"], item);
  const actual = environmentForTool("npm", ["test"], { ...item, config: resolveConfig(item), create: false });
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.kind, "prediction");
  assert.equal(report.routing.status, "predicted");
  assert.equal(variable(report, "npm_config_cache").value, actual.applied.npm_config_cache);
  assert.match(variable(report, "npm_config_cache").source, /derived from root/);
  assert.equal(report.configuration.paths.root.source, item.projectFile);
  assert.deepEqual(item.env, envBefore);
  assert.deepEqual(snapshot(item.root), before);
  const text = formatExplanation(report);
  assert.match(text, /read-only/);
  assert.match(text, /npm_config_cache=/);
  assert.match(text, /not observed output paths/);
});

test("explain preserves explicit defaults, identifies forced routing and recognises provenance", (t) => {
  const item = fixture(t);
  const env = { ...item.env, npm_config_cache: path.join(item.root, "home", ".npm") };
  assert.equal(variable(explainCommand("npm", [], { ...item, env }), "npm_config_cache").action, "preserve");
  const forced = explainCommand("npm", [], { ...item, env: { ...env, CLEAN_DEVELOPMENT_FORCE: "1" } });
  assert.equal(variable(forced, "npm_config_cache").reason, "explicit force mode");
  const applied = applySessionPlan(planSession({ ...item, config: resolveConfig(item) }), "session-only", item.env);
  const rerouted = explainCommand("npm", [], { ...item, env: applied.env });
  assert.equal(variable(rerouted, "npm_config_cache").reason, "reroute unchanged Clean Development value");
});

test("explain attributes independently configured cache roots and effective npm prefixes", (t) => {
  const item = fixture(t);
  const nested = path.join(item.root, "other-project");
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, "package.json"), "{}\n");
  fs.writeFileSync(path.join(nested, ".clean-development.json"), JSON.stringify({
    schemaVersion: 1, root: path.join(item.root, "other-managed")
  }));
  const env = { ...item.env, CLEAN_DEVELOPMENT_CACHE_ROOT: path.join(item.root, "special-cache") };
  const report = explainCommand("npm", ["--prefix", nested, "test"], { ...item, env });
  assert.equal(report.workspace.effectiveCwd, nested);
  assert.equal(report.configuration.paths.root.path, path.join(item.root, "other-managed"));
  assert.equal(variable(report, "npm_config_cache").source, "environment: CLEAN_DEVELOPMENT_CACHE_ROOT");
  assert.equal(variable(report, "npm_config_cache").value, path.join(item.root, "special-cache", "node", "npm"));
});

test("skip avoids malformed configuration and never exposes unrelated arguments", (t) => {
  const item = fixture(t);
  fs.writeFileSync(item.projectFile, "{");
  const before = snapshot(item.root);
  const report = explainCommand("npm", ["--token", "private-argument"], { ...item, mode: "skip" });
  assert.equal(report.routing.status, "skipped");
  assert.equal(report.configuration, null);
  assert.deepEqual(report.routing.variables, []);
  assert.doesNotMatch(JSON.stringify(report), /private-argument/);
  assert.deepEqual(snapshot(item.root), before);
  const inherited = explainCommand("npm", [], { ...item, env: { ...item.env, CLEAN_DEVELOPMENT_SESSION_MODE: "skip" } });
  assert.equal(inherited.session.source, "environment");
});

test("disabled routing and repository-local storage are reported without writes", (t) => {
  const item = fixture(t);
  fs.writeFileSync(item.projectFile, JSON.stringify({ ...item.config, tools: { npm: false } }));
  assert.equal(explainCommand("npm", [], item).routing.status, "disabled");
  fs.writeFileSync(item.projectFile, JSON.stringify({ ...item.config, root: path.join(item.cwd, "managed") }));
  const before = snapshot(item.root);
  const blocked = explainCommand("npm", [], item);
  assert.equal(blocked.routing.status, "blocked");
  assert.deepEqual(blocked.routing.variables, []);
  assert.deepEqual(snapshot(item.root), before);
});

test("Cargo explanation is provisional and never runs the executable or project scripts", (t) => {
  const item = fixture(t);
  fs.writeFileSync(path.join(item.cwd, "Cargo.toml"), '[workspace]\nmembers = []\n');
  const bin = path.join(item.root, "bin");
  fs.mkdirSync(bin);
  const sentinel = path.join(item.root, "executed");
  const tool = path.join(bin, process.platform === "win32" ? "cargo.cmd" : "cargo");
  fs.writeFileSync(tool, process.platform === "win32" ? `@echo unexpected > "${sentinel}"\r\n`
    : `#!/bin/sh\nprintf unexpected > '${sentinel}'\n`, { mode: 0o755 });
  const env = { ...item.env, PATH: `${bin}${path.delimiter}${item.env.PATH}` };
  const before = snapshot(item.root);
  const report = explainCommand("cargo", ["run", "--target-dir=explicit-target", "--", "secret"], { ...item, env });
  assert.equal(report.executable.path, tool);
  assert.match(report.workspace.authority, /static estimate/);
  assert.equal(report.routing.commandLineTarget, "explicit-target");
  assert.match(report.limitations.join("\n"), /provisional/);
  assert.match(report.limitations.join("\n"), /takes precedence/);
  assert.doesNotMatch(JSON.stringify(report), /secret/);
  const afterSeparator = explainCommand("cargo", ["run", "--", "--target-dir=not-cargo"], { ...item, env });
  assert.equal(afterSeparator.routing.commandLineTarget, null);
  assert.deepEqual(snapshot(item.root), before);
});

test("unsupported commands and missing executables remain predictions, not successful probes", (t) => {
  const item = fixture(t);
  const report = explainCommand(process.execPath, ["-e", "throw new Error('must not run')"], item);
  assert.equal(report.supportedShim, false);
  assert.equal(report.routing.status, "indirect");
  assert.equal(report.executable.found, true);
  assert.match(report.limitations.join("\n"), /nested commands/);
  const missing = explainCommand("clean-development-nonexistent-executable", [], item);
  assert.equal(missing.executable.found, false);
  assert.match(missing.limitations.join("\n"), /no installation/);
});

test("explain refuses new persistence but accepts inherited persistence as a child prediction", (t) => {
  const item = fixture(t);
  assert.throws(() => explainCommand("npm", [], { ...item, mode: "persist" }), /session --dry-run/);
  assert.throws(() => explainCommand("", [], item), /requires a command/);
  const report = explainCommand("npm", [], { ...item, env: { ...item.env, CLEAN_DEVELOPMENT_SESSION_MODE: "persist" } });
  assert.equal(report.session.mode, "session-only");
  assert.equal(report.session.source, "environment");
});

test("public CLI provides stable JSON and text output while rejecting invalid options", (t) => {
  const item = fixture(t);
  const before = snapshot(item.root);
  const cli = path.resolve("bin/clean-development.js");
  const run = (args) => spawnSync(process.execPath, [cli, ...args], {
    cwd: item.cwd, env: item.env, encoding: "utf8", timeout: 15000
  });
  const json = run(["explain", "--json", "--", "npm", "test"]);
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).kind, "prediction");
  const text = run(["explain", "--", "npm", "test"]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /Clean Development command prediction/);
  assert.notEqual(run(["explain", "--json"]).status, 0);
  assert.notEqual(run(["explain", "--apply", "--", "npm"]).status, 0);
  assert.notEqual(run(["explain", "--session", "persist", "--", "npm"]).status, 0);
  assert.deepEqual(snapshot(item.root), before);
});
