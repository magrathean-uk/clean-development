import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { environmentForTool } from "../src/adapters.js";
import { resolveConfig } from "../src/config.js";
import { SHIM_TOOLS } from "../src/constants.js";
import { applySessionPlan, environmentWithoutSessionRouting, nativeSessionEnvironment, planSession } from "../src/session.js";
import { injectedEnvironment, SESSION_ENV_MARKER } from "../src/routing-environment.js";
import { isolatedEnvironment } from "../scripts/harness-utils.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clean-development-provenance-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = isolatedEnvironment(root);
  delete env.CLEAN_DEVELOPMENT_ROOT;
  const projects = ["a", "b"].map((name) => {
    const cwd = path.join(root, name);
    fs.mkdirSync(cwd);
    fs.writeFileSync(path.join(cwd, "package.json"), "{}\n");
    fs.writeFileSync(path.join(cwd, ".clean-development.json"), JSON.stringify({
      schemaVersion: 1, root: path.join(root, `managed-${name}`)
    }));
    return { cwd, config: resolveConfig({ cwd, env }) };
  });
  return { root, env, a: projects[0], b: projects[1] };
}

function route(tool, project, env) {
  return environmentForTool(tool, [], { ...project, env, create: false });
}

test("every adapter reroutes its own unchanged environment A to B to A", (t) => {
  const item = fixture(t);
  for (const tool of SHIM_TOOLS) {
    const first = route(tool, item.a, item.env);
    const second = route(tool, item.b, first.env);
    const expected = route(tool, item.b, item.env);
    assert.deepEqual(second.applied, expected.applied, tool);
    assert.deepEqual(second.preserved, {}, tool);
    assert.deepEqual(route(tool, item.a, second.env).applied, first.applied, tool);
    assert.deepEqual(injectedEnvironment(second.env), expected.applied, tool);
  }
  assert.equal(fs.existsSync(item.a.config.root), false);
  assert.equal(fs.existsSync(item.b.config.root), false);
});

test("independent overrides survive rerouting and skip for every adapter", (t) => {
  const item = fixture(t);
  for (const tool of SHIM_TOOLS) {
    const first = route(tool, item.a, item.env);
    for (const name of Object.keys(first.applied)) {
      const changed = { ...first.env, [name]: "user-choice" };
      const next = route(tool, item.b, changed);
      assert.equal(next.preserved[name], "user-choice", `${tool}:${name}`);
      assert.equal(injectedEnvironment(next.env)[name], undefined);
      assert.equal(environmentWithoutSessionRouting(next.env)[name], "user-choice");
    }
  }
});

test("default paths are explicit without provenance; empty values and force remain routable", (t) => {
  const item = fixture(t);
  const value = path.join(item.a.config.locations.home, ".npm");
  assert.equal(route("npm", item.a, { ...item.env, npm_config_cache: value }).preserved.npm_config_cache, value);
  assert.equal(route("npm", item.a, { ...item.env, npm_config_cache: "" }).applied.npm_config_cache,
    path.join(item.a.config.cacheRoot, "node", "npm"));
  const forced = route("npm", item.a, { ...item.env, NPM_CONFIG_CACHE: value, CLEAN_DEVELOPMENT_FORCE: "1" });
  assert.equal(forced.env.NPM_CONFIG_CACHE, undefined);
  assert.equal(forced.applied.npm_config_cache, path.join(item.a.config.cacheRoot, "node", "npm"));
});

test("case variants do not hide or erase independent overrides", (t) => {
  const item = fixture(t);
  const first = route("npm", item.a, item.env);
  const mixed = { ...first.env, NPM_CONFIG_CACHE: "independent" };
  const next = route("npm", item.b, mixed);
  assert.equal(next.env.npm_config_cache, undefined);
  assert.equal(next.preserved.NPM_CONFIG_CACHE, "independent");
  const skipped = environmentWithoutSessionRouting(mixed);
  assert.equal(skipped.npm_config_cache, undefined);
  assert.equal(skipped.NPM_CONFIG_CACHE, "independent");
  const renamed = { ...first.env, NPM_CONFIG_CACHE: first.env.npm_config_cache };
  delete renamed.npm_config_cache;
  assert.equal(route("npm", item.b, renamed).applied.npm_config_cache,
    path.join(item.b.config.cacheRoot, "node", "npm"));
});

test("POSIX native adapter names remain distinct from unrelated case variants through routing and skip", { skip: process.platform === "win32" }, (t) => {
  const item = fixture(t);
  for (const tool of SHIM_TOOLS.filter((name) => !["npm", "npx", "pnpm", "swift"].includes(name))) {
    const first = route(tool, item.a, item.env);
    for (const name of Object.keys(first.applied)) {
      const lower = name.toLowerCase(), value = first.applied[name];
      const changed = { ...first.env, [lower]: value };
      const next = route(tool, item.b, changed);
      assert.equal(next.applied[name], route(tool, item.b, item.env).applied[name], `${tool}:${name}`);
      assert.equal(next.env[lower], value, `${tool}:${lower} preserved`);
      const skipped = environmentWithoutSessionRouting(next.env);
      assert.equal(skipped[name], undefined, `${tool}:${name} removed`);
      assert.equal(skipped[lower], value, `${tool}:${lower} remains independent`);
    }
  }
});

test("POSIX skip preserves independently named metadata and PATH variants", { skip: process.platform === "win32" }, (t) => {
  const item = fixture(t), first = route("cargo", item.a, item.env);
  const changed = { ...first.env, path: "independent-path" };
  for (const name of ["CLEAN_DEVELOPMENT_ACTIVE", "CLEAN_DEVELOPMENT_CARGO_TARGET_DIR", SESSION_ENV_MARKER]) {
    changed[name.toLowerCase()] = first.env[name];
  }
  const skipped = environmentWithoutSessionRouting(changed);
  assert.equal(skipped.CARGO_TARGET_DIR, undefined);
  assert.equal(skipped.path, "independent-path");
  for (const name of ["CLEAN_DEVELOPMENT_ACTIVE", "CLEAN_DEVELOPMENT_CARGO_TARGET_DIR", SESSION_ENV_MARKER]) {
    assert.equal(skipped[name], undefined);
    assert.equal(skipped[name.toLowerCase()], first.env[name]);
  }
});

test("Windows skip removes a quoted managed PATH entry and preserves unrelated spelling", { skip: process.platform !== "win32" }, (t) => {
  const item = fixture(t), bin = path.join(item.root, "runtime;bin"), other = path.join(item.root, "other;tools");
  fs.mkdirSync(bin); fs.mkdirSync(other);
  const env = { ...item.env, PATH: `"${other}";"${bin}";;relative;"malformed` };
  const skipped = environmentWithoutSessionRouting(env, bin);
  assert.equal(skipped.PATH, `"${other}";;relative;"malformed`);
  assert.equal(env.PATH, `"${other}";"${bin}";;relative;"malformed`);
});

test("an unrelated adapter retains provenance for an unchanged cache spelling", (t) => {
  const item = fixture(t);
  const first = route("npm", item.a, item.env);
  const explicit = path.join(item.root, "user-cache");
  const mixed = { ...first.env, NPM_CONFIG_CACHE: explicit };
  const intermediate = route("go", item.a, mixed);
  assert.equal(intermediate.env.npm_config_cache, first.env.npm_config_cache);
  assert.equal(intermediate.env.NPM_CONFIG_CACHE, explicit);
  assert.equal(injectedEnvironment(intermediate.env).npm_config_cache, first.env.npm_config_cache);

  const next = route("npm", item.b, intermediate.env);
  assert.equal(next.env.npm_config_cache, undefined);
  assert.equal(next.preserved.NPM_CONFIG_CACHE, explicit);
  assert.equal(injectedEnvironment(next.env).npm_config_cache, undefined);
  const skipped = environmentWithoutSessionRouting(intermediate.env);
  assert.equal(skipped.npm_config_cache, undefined);
  assert.equal(skipped.NPM_CONFIG_CACHE, explicit);
  assert.deepEqual(mixed, { ...first.env, NPM_CONFIG_CACHE: explicit });
  assert.equal(fs.existsSync(item.a.config.root), false);
  assert.equal(fs.existsSync(item.b.config.root), false);
});

test("an unrelated adapter drops cache provenance when no spelling still matches", (t) => {
  const item = fixture(t);
  const first = route("npm", item.a, item.env);
  const explicit = path.join(item.root, "user-cache");
  for (const keepLowerCase of [false, true]) {
    const changed = { ...first.env, NPM_CONFIG_CACHE: explicit };
    if (keepLowerCase) changed.npm_config_cache = explicit;
    else delete changed.npm_config_cache;
    const intermediate = route("go", item.a, changed);
    assert.equal(injectedEnvironment(intermediate.env).npm_config_cache, undefined);
    const skipped = environmentWithoutSessionRouting(intermediate.env);
    assert.equal(skipped.NPM_CONFIG_CACHE, explicit);
    assert.equal(skipped.npm_config_cache, keepLowerCase ? explicit : undefined);
  }
});

test("nested sessions and native-hook environments retain routing provenance", (t) => {
  const item = fixture(t);
  const first = applySessionPlan(planSession({ ...item.a, env: item.env }), "session-only", item.env);
  const native = nativeSessionEnvironment(first.env, { mode: "session-only" });
  const secondPlan = planSession({ ...item.b, env: native });
  assert.deepEqual(secondPlan.managed.preserved, {});
  const second = applySessionPlan(secondPlan, "session-only", native);
  assert.equal(second.env.npm_config_cache, path.join(item.b.config.cacheRoot, "node", "npm"));
  assert.equal(environmentWithoutSessionRouting(second.env).npm_config_cache, undefined);
  assert.equal(fs.existsSync(item.b.config.locations.dataDir), false);
});

test("malformed or unrelated provenance cannot remove arbitrary environment variables", () => {
  for (const marker of ["{", "null", "[]", '{"PATH":"keep"}', '{"npm_config_cache":3}',
    '{"npm_config_cache":"a","NPM_CONFIG_CACHE":"b"}', " ".repeat(65537)]) {
    const env = { PATH: "keep", npm_config_cache: "explicit", [SESSION_ENV_MARKER]: marker };
    assert.deepEqual(injectedEnvironment(env), {});
    const skipped = environmentWithoutSessionRouting(env);
    assert.equal(skipped.PATH, "keep");
    assert.equal(skipped.npm_config_cache, "explicit");
  }
});

test("skip still removes a legacy Cargo value but preserves a changed value", () => {
  const env = { CLEAN_DEVELOPMENT_ACTIVE: "1", CLEAN_DEVELOPMENT_CARGO_TARGET_DIR: "old", CARGO_TARGET_DIR: "old" };
  assert.equal(environmentWithoutSessionRouting(env).CARGO_TARGET_DIR, undefined);
  assert.equal(environmentWithoutSessionRouting({ ...env, CARGO_TARGET_DIR: "explicit" }).CARGO_TARGET_DIR, "explicit");
});

test("public CLI uses the current project's npm cache and disabled projects remove inherited routing", (t) => {
  const item = fixture(t);
  const first = applySessionPlan(planSession({ ...item.a, env: item.env }), "session-only", item.env);
  const cli = path.resolve("bin/clean-development.js");
  const result = spawnSync(process.execPath, [cli, "run", "--session", "session-only", "--", "npm", "config", "get", "cache"], {
    cwd: item.b.cwd, env: first.env, encoding: "utf8", timeout: 15000
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), path.join(item.b.config.cacheRoot, "node", "npm"));
  fs.writeFileSync(path.join(item.b.cwd, ".clean-development.json"), '{"schemaVersion":1,"enabled":false}\n');
  const skipped = spawnSync(process.execPath, [cli, "run", "--", process.execPath, "-e", "process.stdout.write(process.env.npm_config_cache || 'unset')"], {
    cwd: item.b.cwd, env: first.env, encoding: "utf8", timeout: 15000
  });
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.equal(skipped.stdout, "unset");
});
