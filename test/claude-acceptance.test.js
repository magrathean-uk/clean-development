import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { makeFixture, destroyFixture, setup, hook, observe, evaluate, product, routedParent,
  observedEnvironment, intact, preflight, observer, execute, repository } from "./claude-acceptance/fixture.mjs";

const posix = { skip: process.platform === "win32" ? "POSIX hook fixture; native Windows acceptance not established" : false };
function lab(t) { const item = makeFixture(); t.after(() => destroyFixture(item)); return item; }
function passed(result) { assert.equal(result.status, "passed", result.reason); assert.equal(result.layer, "fixture-only"); }

test("Claude fixture: ordinary packaged startup before setup is inert; native child writes only its local target", posix, (t) => {
  const item = lab(t);
  const before = fs.readFileSync(path.join(item.env.CLAUDE_CONFIG_DIR, "settings.json"), "utf8");
  const envFile = hook(item, { generic: true });
  assert.equal(fs.existsSync(envFile), false);
  for (const directory of ["data", "config", "managed"]) assert.equal(fs.existsSync(path.join(item.root, directory)), false);
  observe(item, "before-setup");
  passed(evaluate(item, "before-setup", { routed: false }));
  assert.equal(fs.readFileSync(path.join(item.env.CLAUDE_CONFIG_DIR, "settings.json"), "utf8"), before);
});

test("Claude fixture: explicit setup exposes shims but defaults actual shell and Cargo children to skip", posix, (t) => {
  const item = lab(t);
  const first = setup(item), second = setup(item);
  assert.deepEqual(second, first);
  const envFile = hook(item);
  const value = observe(item, "after-setup", { envFile });
  assert.equal(value.shell.env.CLEAN_DEVELOPMENT_SESSION_MODE, "skip");
  assert.equal(value.shell.cargoCommand, path.join(item.bin, "cargo"));
  assert.equal(value.shell.env.ACCEPTANCE_KEEP, "unrelated-hook");
  assert.equal(value.cargo.env.ACCEPTANCE_KEEP, "unrelated-hook");
  passed(evaluate(item, "after-setup", { routed: false }));
});

test("Claude fixture: session-only routes the actual child and changing cwd selects a distinct managed Cargo root", posix, (t) => {
  const item = lab(t); setup(item);
  const env = routedParent(item), envFile = hook(item, { env });
  const a = observe(item, "session-only", { env, envFile });
  passed(evaluate(item, "session-only", { routed: true }));
  hook(item, { env, generic: true, source: "cwd-change", cwd: item.projects.other, environmentFile: envFile });
  const b = observe(item, "other", { env, envFile, cwd: item.projects.other });
  passed(evaluate(item, "other", { routed: true, cwd: item.projects.other }));
  assert.notEqual(a.cargo.target, b.cargo.target);
  const records = fs.readdirSync(path.join(item.root, "data", "state", "workspaces")).filter((p) => p.endsWith(".json"));
  assert.equal(records.length, 2);
  intact(item);
});

test("Claude fixture: explicit skip removes inherited routing but preserves an independent cache and unrelated hook", posix, (t) => {
  const item = lab(t); setup(item);
  const parent = routedParent(item);
  const child = JSON.parse(product(item, ["run", "--session", "skip", "--", process.execPath, observer, "environment"], parent).stdout);
  const env = { ...item.env, ...child }, envFile = hook(item, { env });
  observe(item, "skip", { env, envFile });
  passed(evaluate(item, "skip", { routed: false }));
  assert.equal(observedEnvironment(item, envFile, env).npm_config_cache, undefined);
});

test("Claude fixture: owned startup hook cleans both shell and Cargo children in an already disabled project", posix, (t) => {
  const item = lab(t); setup(item);
  const env = routedParent(item);
  const cwd = item.projects.disabled, envFile = hook(item, { env, cwd });
  const value = observe(item, "disabled", { env, envFile, cwd });
  assert.equal(value.shell.env.CLEAN_DEVELOPMENT_SESSION_MODE, "skip");
  assert.equal(value.shell.env.CLEAN_DEVELOPMENT_SESSION_ENV, undefined);
  passed(evaluate(item, "disabled", { routed: false, cwd }));
});

test("Claude acceptance detector: shipped ownerless CwdChanged leaves stale parent cache (known gap, not a pass)", posix, (t) => {
  const item = lab(t); const settings = setup(item);
  assert.equal(settings.hooks.CwdChanged, undefined, "Update this evidence when the integration writer gains an owned cwd hook");
  const env = routedParent(item), envFile = hook(item, { env });
  const before = fs.readFileSync(envFile, "utf8");
  assert.ok(env.npm_config_cache, "Routed parent must actually carry a managed cache");
  hook(item, { generic: true, env, environmentFile: envFile, source: "cwd-change", cwd: item.projects.disabled });
  assert.equal(fs.readFileSync(envFile, "utf8"), before);
  const value = observe(item, "cwd-change", { env, envFile, cwd: item.projects.disabled });
  assert.equal(value.cargo.env.npm_config_cache, undefined, "Cargo shim still cleans the tool child");
  assert.equal(value.cargo.env.CARGO_TARGET_DIR, undefined);
  assert.equal(value.shell.env.npm_config_cache, env.npm_config_cache, "The ordinary shell child still inherits routed npm cache");
  const result = evaluate(item, "cwd-change", { routed: false, cwd: item.projects.disabled });
  assert.equal(result.status, "failed", "The acceptance detector must not call this a successful disabled transition");
  assert.match(result.reason, /Shell child retained a managed npm cache/);
  assert.equal(result.layer, "fixture-only");
  intact(item);
});

test("Claude fixture: resume and fork hook commands retain a skip override and route only explicit session-only", posix, (t) => {
  for (const source of ["resume", "fork"]) {
    const item = lab(t); setup(item);
    const env = routedParent(item);
    const envFile = hook(item, { source, env });
    observe(item, source, { env, envFile });
    passed(evaluate(item, source, { routed: true }));
    const skip = { ...item.env, CLEAN_DEVELOPMENT_SESSION_MODE: "skip" };
    const next = hook(item, { source, env: skip, environmentFile: path.join(item.root, "skip.env") });
    observe(item, `${source}-skip`, { env: skip, envFile: next, cwd: item.projects.other });
    passed(evaluate(item, `${source}-skip`, { routed: false, cwd: item.projects.other }));
  }
});

test("Claude fixture: uninstall preserves unrelated settings and managed artifacts; fresh shell resolves native Cargo", posix, (t) => {
  const item = lab(t); setup(item);
  const env = routedParent(item), envFile = hook(item, { env });
  const before = observe(item, "routed", { env, envFile });
  const artifact = fs.readFileSync(before.cargo.artifact);
  product(item, ["uninstall", "--json"]);
  const settings = JSON.parse(fs.readFileSync(path.join(item.env.CLAUDE_CONFIG_DIR, "settings.json"), "utf8"));
  assert.deepEqual(settings, item.originalSettings);
  assert.deepEqual(fs.readFileSync(before.cargo.artifact), artifact);
  const fresh = hook(item, { generic: true, environmentFile: path.join(item.root, "fresh.env") });
  assert.equal(fs.existsSync(fresh), false);
  const value = observe(item, "uninstall");
  assert.equal(value.shell.cargoCommand, path.join(item.root, "tools", "cargo"));
  passed(evaluate(item, "uninstall", { routed: false }));
});

test("Claude fixture: wrong owner and modified env blocks fail closed; no child or project writes", posix, (t) => {
  const item = lab(t); setup(item);
  const envFile = hook(item), before = fs.readFileSync(envFile, "utf8");
  assert.throws(() => execute("/bin/sh", [path.join(repository, "hooks/session-start"), "00000000-0000-4000-8000-000000000000"], {
    env: { ...item.env, CLAUDE_PLUGIN_ROOT: repository, CLAUDE_ENV_FILE: envFile }, cwd: item.projects.normal
  }), /owner does not match/);
  assert.equal(fs.readFileSync(envFile, "utf8"), before);
  const modified = before.replace("export PATH", "export PATH\n# externally modified");
  fs.writeFileSync(envFile, modified);
  assert.throws(() => hook(item), /Refusing modified/);
  // The unrelated fixture hook appends its own line; the product-owned block is untouched.
  assert.ok(fs.readFileSync(envFile, "utf8").startsWith(modified));
  assert.equal(fs.existsSync(path.join(item.projects.normal, "target")), false);
  intact(item);
});

test("Claude acceptance preflight never turns missing hosts or fixture runs into live acceptance", posix, (t) => {
  const item = lab(t);
  item.env.PATH = path.dirname(process.execPath); // deterministic: deliberately no host or real Cargo
  const report = preflight(item);
  assert.equal(report.claude.available, false);
  assert.equal(report.claude.version, null);
  assert.equal(report.liveAcceptance, "not-run");
  assert.ok(report.cases.every((entry) => entry.status === "blocked"));
});

test("Claude fixture: the owned shell wrapper delegates through plugin-root and stable-PATH branches without prompt output", posix, (t) => {
  const item = lab(t); setup(item);
  const receipt = JSON.parse(fs.readFileSync(path.join(item.root, "data/state/integrations.json"), "utf8"));
  const owner = receipt.integrations.find((entry) => entry.agent === "claude").ownershipId;
  for (const plugin of [true, false]) {
    const envFile = path.join(item.root, `${plugin ? "plugin" : "path"}.env`);
    const env = { ...item.env, PATH: `${item.bin}:${item.env.PATH}`, CLAUDE_ENV_FILE: envFile };
    if (plugin) env.CLAUDE_PLUGIN_ROOT = repository;
    const result = execute("/bin/sh", [path.join(repository, "hooks/session-start"), owner], { env, cwd: item.projects.normal });
    assert.equal(result.stdout, "");
    const child = observedEnvironment(item, envFile, item.env);
    assert.equal(child.CLEAN_DEVELOPMENT_SESSION_MODE, "skip");
    assert.equal(child.PATH.split(":")[0], item.bin);
  }
});

test("Claude acceptance detector rejects failed, missing and mismatched child evidence, even when an artifact exists", posix, (t) => {
  const item = lab(t);
  observe(item, "native");
  const file = path.join(item.root, "evidence/native-cargo.json");
  const original = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const changed of [{ ...original, exitCode: 29 }, { ...original, nonce: "unrelated-observation" }, { ...original, backend: "live" }]) {
    fs.writeFileSync(file, JSON.stringify(changed));
    assert.equal(evaluate(item, "native", { routed: false }).status, "failed");
  }
  fs.rmSync(file);
  assert.equal(evaluate(item, "native", { routed: false }).status, "failed");
});

test("Claude acceptance preparation discards ambient credentials and rejects redirected disposable config paths", posix, async (t) => {
  const { loadFixture } = await import("./claude-acceptance/fixture.mjs");
  const item = lab(t);
  for (const key of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "BASH_ENV", "NODE_OPTIONS", "SSH_AUTH_SOCK"]) assert.equal(item.env[key], undefined);
  const file = path.join(item.root, "lab.json"), original = fs.readFileSync(file, "utf8");
  const changed = JSON.parse(original);
  changed.env.CLAUDE_CONFIG_DIR = path.join(item.root, "not-the-disposable-config");
  fs.writeFileSync(file, JSON.stringify(changed));
  try { assert.throws(() => loadFixture(item.root), /Changed lab path: CLAUDE_CONFIG_DIR/); }
  finally { fs.writeFileSync(file, original); }
});


test("Claude live launcher refuses fixture backends and unavailable tools before any host launch", posix, async (t) => {
  const { launch } = await import("./claude-acceptance/run.mjs");
  const item = lab(t);
  assert.throws(() => launch(item, "native", "normal"), /Fixture tools cannot establish host acceptance/);
  item.backend = "live";
  item.env.PATH = path.dirname(process.execPath);
  assert.throws(() => launch(item, "native", "normal"), /Live launch blocked/);
  assert.equal(fs.readdirSync(path.join(item.root, "evidence")).some((file) => file.startsWith("launch-")), false);
});
