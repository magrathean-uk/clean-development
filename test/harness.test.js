import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { isolatedEnvironment, rustupHomeEnvironment, summarizeOverhead, withoutCleanDevelopmentEnvironment } from "../scripts/harness-utils.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("verification environments discard inherited routing overrides regardless of casing", () => {
  const temporary = path.join(os.tmpdir(), "verification-environment");
  const env = isolatedEnvironment(temporary, {
    PATH: "/bin",
    CLEAN_DEVELOPMENT_BUILD_ROOT: "/outside/builds",
    clean_development_cache_root: "/outside/caches",
    CLEAN_DEVELOPMENT_SCRATCH_ROOT: "/outside/scratch",
    CLEAN_DEVELOPMENT_FORCE: "1",
    CARGO_TARGET_DIR: "/outside/cargo",
    npm_config_cache: "/outside/npm",
    UV_CACHE_DIR: "/outside/uv"
  });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.CLEAN_DEVELOPMENT_ROOT, path.join(temporary, "managed"));
  assert.equal(Object.values(env).some((value) => value.startsWith("/outside")), false);
  assert.equal(env.CLEAN_DEVELOPMENT_FORCE, undefined);
});

test("fixture environments drop every CLEAN_DEVELOPMENT_ variable regardless of casing and keep the rest", () => {
  const inherited = {
    PATH: "/bin",
    HOME: "/home/example",
    CLEAN_DEVELOPMENT_ROOT: "/outside/managed",
    CLEAN_DEVELOPMENT_ACTIVE: "1",
    clean_development_data_home: "/outside/data",
    npm_config_cache: "/outside/npm"
  };
  const env = withoutCleanDevelopmentEnvironment(inherited);
  assert.deepEqual(env, { PATH: "/bin", HOME: "/home/example", npm_config_cache: "/outside/npm" });
  assert.equal(inherited.CLEAN_DEVELOPMENT_ROOT, "/outside/managed");
  const previous = process.env.CLEAN_DEVELOPMENT_ROOT;
  process.env.CLEAN_DEVELOPMENT_ROOT = "/outside/ambient";
  try {
    assert.equal(Object.keys(withoutCleanDevelopmentEnvironment()).some((key) => key.toUpperCase().startsWith("CLEAN_DEVELOPMENT_")), false);
  } finally {
    if (previous === undefined) delete process.env.CLEAN_DEVELOPMENT_ROOT;
    else process.env.CLEAN_DEVELOPMENT_ROOT = previous;
  }
});

test("prune fixtures cannot delete inherited or repository-configured build storage", (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "clean-development-prune-isolation-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const project = path.join(temporary, "project");
  fs.mkdirSync(project);
  const storage = path.join(temporary, "outside-storage");
  const protectedDirectory = path.join(storage, "fixture-deadbeef00");
  fs.mkdirSync(protectedDirectory, { recursive: true });
  const canary = path.join(protectedDirectory, "keep.txt");
  fs.writeFileSync(canary, "must survive\n");
  fs.writeFileSync(path.join(project, ".clean-development.json"), JSON.stringify({ schemaVersion: 1, buildRoot: storage }));
  for (const inherited of [{}, { CLEAN_DEVELOPMENT_BUILD_ROOT: storage }]) {
    const env = { ...isolatedEnvironment(temporary), ...inherited };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ["--test", path.join(root, "test", "prune.test.js")], {
      cwd: project, env, encoding: "utf8", timeout: 30000
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.readFileSync(canary, "utf8"), "must survive\n");
    assert.deepEqual(fs.readdirSync(protectedDirectory), ["keep.txt"]);
  }
});

test("overhead statistics use paired deltas instead of subtracting distribution percentiles", () => {
  const result = summarizeOverhead([1, 1, 1, 1, 101], [101, 1, 1, 1, 1]);
  assert.equal(result.directP95Ms, 101);
  assert.equal(result.routedP95Ms, 101);
  assert.equal(result.addedMedianMs, 0);
  assert.equal(result.addedP95Ms, 100);
  assert.throws(() => summarizeOverhead([], []), /paired/);
  assert.throws(() => summarizeOverhead([1], [1, 2]), /paired/);
});

test("real-tool smoke refuses success when no supported tools are available", (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "clean-development-empty-smoke-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [path.join(root, "scripts", "smoke-real-tools.mjs")], {
    cwd: temporary, env: { ...isolatedEnvironment(temporary), PATH: temporary }, encoding: "utf8", timeout: 30000
  });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /No real tools were available/);
});

test("Cargo smoke rejects a successful command that produced no compiler artifacts", { skip: process.platform === "win32" }, (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "clean-development-empty-cargo-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  fs.symlinkSync("/bin/sh", path.join(temporary, "sh"));
  const cargo = path.join(temporary, "cargo");
  fs.writeFileSync(cargo, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const result = spawnSync(process.execPath, [path.join(root, "scripts", "smoke-real-tools.mjs")], {
    cwd: temporary, env: { ...isolatedEnvironment(temporary), PATH: temporary }, encoding: "utf8", timeout: 30000
  });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /Cargo reported no compiler artifacts/);
});

test("rustup home for disposable-HOME children is inherited or an installed default, never a new path", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rustup-home-"));
  try {
    assert.deepEqual(rustupHomeEnvironment({ RUSTUP_HOME: "/routed/rustup" }, home), { RUSTUP_HOME: "/routed/rustup" });
    assert.deepEqual(rustupHomeEnvironment({}, home), {});
    assert.equal(fs.existsSync(path.join(home, ".rustup")), false);
    fs.mkdirSync(path.join(home, ".rustup"));
    assert.deepEqual(rustupHomeEnvironment({ RUSTUP_HOME: "" }, home), {});
    fs.mkdirSync(path.join(home, ".rustup", "toolchains"));
    assert.deepEqual(rustupHomeEnvironment({ RUSTUP_HOME: "" }, home), { RUSTUP_HOME: path.join(home, ".rustup") });
    assert.deepEqual(rustupHomeEnvironment({ RUSTUP_HOME: "/routed/rustup" }, home), { RUSTUP_HOME: "/routed/rustup" });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
