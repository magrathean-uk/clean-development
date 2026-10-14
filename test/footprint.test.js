import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { isolatedNativeEnvironment } from "../scripts/harness-utils.mjs";
import { snapshotFootprint, compareFootprints } from "../scripts/footprint-utils.mjs";

const cli = fileURLToPath(new URL("../bin/clean-development.js", import.meta.url));

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "clean-development-footprint-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = isolatedNativeEnvironment(root, process.env);
  for (const directory of [env.HOME, env.XDG_CACHE_HOME, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_STATE_HOME, env.TMPDIR,
    env.CLEAN_DEVELOPMENT_CACHE_ROOT, env.CLEAN_DEVELOPMENT_BUILD_ROOT]) fs.mkdirSync(directory, { recursive: true });
  return { root, env };
}

test("native verification isolates defaults without replacing toolchain pins or hermetic Git/Cargo choices", (t) => {
  const item = fixture(t), cargo = path.join(item.root, "hermetic-cargo");
  const inherited = { PATH: "/installed/bin", HOME: "/outside/home", home: "/outside/alias", XDG_CACHE_HOME: "/outside/cache",
    npm_config_cache: "/outside/npm", NPM_CONFIG_USERCONFIG: "/outside/npmrc", CARGO_HOME: "/outside/cargo",
    RUSTUP_HOME: "/installed/rustup", RUSTUP_TOOLCHAIN: "pinned", DEVELOPER_DIR: "/installed/sdk", SDKROOT: "/installed/sdk/root",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(item.root, "hermetic-gitconfig"), GOTOOLCHAIN: "local",
    BASH_ENV: "/outside/startup", ZDOTDIR: "/outside/zsh", PYTHONSTARTUP: "/outside/python-startup" };
  const env = isolatedNativeEnvironment(item.root, inherited, { overrides: { CARGO_HOME: cargo, CARGO_NET_OFFLINE: "true" } });
  for (const key of ["PATH", "RUSTUP_HOME", "RUSTUP_TOOLCHAIN", "DEVELOPER_DIR", "SDKROOT", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL", "GOTOOLCHAIN"]) {
    assert.equal(env[key], inherited[key]);
  }
  assert.equal(env.CARGO_HOME, cargo); assert.equal(env.CARGO_NET_OFFLINE, "true");
  for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME",
    "TMPDIR", "TMP", "TEMP", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "PIP_CONFIG_FILE", "PIP_CACHE_DIR", "npm_config_cache", "npm_config_userconfig"]) {
    assert.ok(env[key].startsWith(`${item.root}${path.sep}`), key);
  }
  assert.equal(Object.values(env).some((value) => value.startsWith("/outside")), false);
  for (const key of ["BASH_ENV", "ENV", "ZDOTDIR", "PYTHONSTARTUP", "NODE_PATH"]) assert.equal(env[key], undefined);
  assert.equal(new Set(Object.keys(env).map((key) => key.toUpperCase())).size, Object.keys(env).length);
  assert.throws(() => isolatedNativeEnvironment(os.homedir()), /dedicated/);
});

test("a route-stripping child is detected when it writes to the disposable native home", (t) => {
  const item = fixture(t), roots = [{ name: "home", path: item.env.HOME }];
  const before = snapshotFootprint(roots);
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", [
    "import fs from 'node:fs'; import path from 'node:path';",
    "for (const key of Object.keys(process.env)) if (key.startsWith('CLEAN_DEVELOPMENT_') || ['XDG_CACHE_HOME','PIP_CACHE_DIR'].includes(key)) delete process.env[key];",
    "const cache = path.join(process.env.HOME, '.cache', 'pip'); fs.mkdirSync(cache, { recursive: true });",
    "fs.writeFileSync(path.join(cache, 'private-name-canary'), 'private-content-canary');"
  ].join("\n")], { env: item.env, encoding: "utf8", timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  const after = snapshotFootprint(roots), comparison = compareFootprints(before, after);
  assert.equal(comparison.complete, true); assert.equal(comparison.clean, false);
  assert.equal(comparison.deltas[0].files, 1); assert.ok(comparison.deltas[0].logicalBytes > 0);
  assert.equal(JSON.stringify({ after, comparison }).includes("private-"), false);
});

test("nested shell python -m pip dispatch uses declared fixture caches without a pip shim or downloads", { skip: process.platform === "win32" }, (t) => {
  const item = fixture(t), project = path.join(item.root, "project"), bin = path.join(item.root, "fake-bin");
  fs.mkdirSync(project); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(project, "pyproject.toml"), "[project]\nname='footprint-fixture'\nversion='0.0.0'\n");
  const python = path.join(bin, "python3");
  fs.writeFileSync(python, `#!${process.execPath}\n` + [
    "const fs = require('node:fs'), path = require('node:path');",
    "if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['-m', 'pip', '--version'])) process.exit(91);",
    "fs.mkdirSync(process.env.PIP_CACHE_DIR, { recursive: true });",
    "fs.writeFileSync(path.join(process.env.PIP_CACHE_DIR, 'fake-offline-artifact'), 'fixture');"
  ].join("\n"), { mode: 0o755 });
  const roots = [{ name: "home", path: item.env.HOME }, { name: "cache", path: item.env.XDG_CACHE_HOME }];
  const before = snapshotFootprint(roots);
  const child = spawnSync(process.execPath, [cli, "run", "--session", "session-only", "--", "/bin/sh", "-c", "python3 -m pip --version"], {
    cwd: project, env: { ...item.env, PATH: `${bin}${path.delimiter}${item.env.PATH}` }, encoding: "utf8", timeout: 10000
  });
  assert.equal(child.status, 0, child.stderr);
  const comparison = compareFootprints(before, snapshotFootprint(roots));
  assert.equal(comparison.complete, true);
  assert.equal(comparison.deltas.find((delta) => delta.name === "home").changed, false);
  assert.equal(comparison.deltas.find((delta) => delta.name === "cache").files, 1);
  assert.equal(fs.readFileSync(path.join(item.env.PIP_CACHE_DIR, "fake-offline-artifact"), "utf8"), "fixture");
});

test("footprint entry/depth/time bounds produce incomplete observations with an unknown clean result", (t) => {
  const item = fixture(t), roots = [{ name: "home", path: item.env.HOME }];
  fs.mkdirSync(path.join(item.env.HOME, "nested"));
  fs.writeFileSync(path.join(item.env.HOME, "nested", "file"), "a");
  const full = snapshotFootprint(roots);
  for (const limits of [{ maxEntries: 1 }, { maxDepth: 1 }]) {
    const partial = snapshotFootprint(roots, { limits });
    assert.equal(partial.complete, false);
    assert.equal(compareFootprints(full, partial).clean, null);
  }
  const original = fs.lstatSync;
  const delayed = t.mock.method(fs, "lstatSync", (...args) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4);
    return original(...args);
  });
  const partial = snapshotFootprint(roots, { limits: { maxDurationMs: 1 } });
  delayed.mock.restore();
  assert.equal(partial.complete, false); assert.ok(partial.roots[0].reasons.includes("time-limit"));
  assert.equal(compareFootprints(full, partial).clean, null);
});

test("footprint observes missing roots without creating them and refuses whole-home or implicit selections", (t) => {
  const item = fixture(t), absent = path.join(item.root, "absent");
  const snapshot = snapshotFootprint([{ name: "absent", path: absent }]);
  assert.equal(snapshot.complete, true); assert.equal(snapshot.roots[0].exists, false);
  assert.equal(fs.existsSync(absent), false);
  assert.throws(() => snapshotFootprint([]), /explicit roots/);
  assert.throws(() => snapshotFootprint([{ name: "home", path: os.homedir() }]), /broad roots/);
  assert.throws(() => snapshotFootprint([{ name: "relative", path: "relative" }]), /absolute/);
  assert.throws(() => snapshotFootprint([{ name: "home", path: item.env.HOME }], { limits: { maxEntries: 200001 } }), /limit/);
});

test("footprint skips links and mount boundaries rather than inventorying their targets", (t) => {
  const item = fixture(t), outside = path.join(item.root, "outside"), mounted = path.join(item.env.HOME, "mounted");
  fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "secret-file"), "canary");
  fs.mkdirSync(mounted); fs.writeFileSync(path.join(mounted, "unobserved-file"), "canary");
  fs.symlinkSync(outside, path.join(item.env.HOME, "link"), process.platform === "win32" ? "junction" : "dir");
  const original = fs.lstatSync;
  const observed = t.mock.method(fs, "lstatSync", (...args) => {
    const stat = original(...args);
    if (args[0] !== mounted) return stat;
    const changed = Object.create(stat); Object.defineProperty(changed, "dev", { value: stat.dev + 1 }); return changed;
  });
  const snapshot = snapshotFootprint([{ name: "home", path: item.env.HOME }]);
  assert.equal(snapshot.complete, false); assert.equal(snapshot.roots[0].files, 0);
  assert.equal(snapshot.roots[0].symlinks, 1); assert.equal(snapshot.roots[0].skippedMounts, 1);
  assert.equal(observed.mock.calls.some((call) => String(call.arguments[0]).endsWith("secret-file") || String(call.arguments[0]).endsWith("unobserved-file")), false);
  observed.mock.restore();
  const alias = snapshotFootprint([{ name: "alias", path: path.join(item.env.HOME, "link") }]);
  assert.equal(alias.complete, false); assert.deepEqual(alias.roots[0].reasons, ["symlink-boundary"]);
});
