import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { inspectNativeCacheOptions } from "../src/native-cache-options.js";
import { explainCommand, formatExplanation } from "../src/explain.js";
import { environmentValue } from "../src/platform.js";
import { resolveExecutable } from "../src/runtime.js";
import { windowsBatchInvocation } from "../src/windows-command.js";

const cli = fileURLToPath(new URL("../bin/clean-development.js", import.meta.url));
function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cd-native-options-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"), cwd = path.join(root, "project"), tmp = path.join(root, "tmp");
  for (const dir of [home, cwd, tmp]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(cwd, "package.json"), '{"private":true}\n');
  const env = {};
  for (const key of ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "ComSpec"]) {
    const value = environmentValue(process.env, key); if (value !== undefined) env[key] = value;
  }
  Object.assign(env, { HOME: home, USERPROFILE: home, TMP: tmp, TEMP: tmp, TMPDIR: tmp,
    CLEAN_DEVELOPMENT_HOME: home, CLEAN_DEVELOPMENT_ROOT: path.join(root, "managed"),
    CLEAN_DEVELOPMENT_DATA_HOME: path.join(root, "data"), CLEAN_DEVELOPMENT_CONFIG_HOME: path.join(root, "config"),
    XDG_CONFIG_HOME: path.join(home, "config"), XDG_CACHE_HOME: path.join(home, "cache"),
    LOCALAPPDATA: path.join(home, "local"), APPDATA: path.join(home, "roaming"),
    npm_config_userconfig: path.join(root, "user.npmrc"), npm_config_globalconfig: path.join(root, "global.npmrc"),
    npm_config_offline: "true", npm_config_ignore_scripts: "true", npm_config_audit: "false", npm_config_fund: "false",
    UV_OFFLINE: "1", UV_NO_CONFIG: "1", UV_PYTHON_DOWNLOADS: "never", COREPACK_ENABLE_NETWORK: "0" });
  fs.writeFileSync(env.npm_config_userconfig, ""); fs.writeFileSync(env.npm_config_globalconfig, "");
  return { root, cwd, env };
}
function snapshot(root) {
  return fs.readdirSync(root, { recursive: true }).sort().map((name) => {
    const file = path.join(root, name); const stat = fs.lstatSync(file);
    return [name, stat.mode, stat.mtimeMs, stat.isFile() ? fs.readFileSync(file).toString("base64") : null];
  });
}

test("leading npm and uv cache declarations retain separate and attached values", () => {
  for (const [tool, option, variable] of [["npm", "--cache", "npm_config_cache"], ["uv", "--cache-dir", "UV_CACHE_DIR"]]) {
    for (const args of [[option, "relative path", "command"], [`${option}=relative path`, "command"]]) {
      const result = inspectNativeCacheOptions(tool, args);
      assert.deepEqual(result.declarations, [{ option, variable, effect: "path-override", value: "relative path" }]);
      assert.equal(result.stopReason, "command-or-unknown-option");
      assert.equal(result.effectiveDestination, null); assert.equal(result.observed, false);
    }
  }
});

test("inspection stops at commands, unknown options and -- without exposing unrelated values", () => {
  for (const args of [["run", "script.py", "--cache-dir=SECRET"], ["--unknown", "SECRET", "--cache-dir=SECRET"], ["--", "--cache-dir=SECRET"]]) {
    const report = inspectNativeCacheOptions("uv", args);
    assert.equal(report.declarations.length, 0);
    assert.doesNotMatch(JSON.stringify(report), /SECRET/);
  }
  assert.equal(inspectNativeCacheOptions("npx", ["--cache=SECRET"]), null);
});

test("missing, option-like, control-bearing and oversized values are not guessed", () => {
  for (const args of [["--cache"], ["--cache="], ["--cache", "--secret", "SECRET"], ["--cache=bad\npath"], [`--cache=${"x".repeat(8193)}`]]) {
    const result = inspectNativeCacheOptions("npm", args);
    assert.equal(result.declarations[0].value, null);
    assert.equal(result.declarations[0].effect, "unknown");
    assert.equal(result.stopReason, "invalid-or-missing-value");
    assert.equal(result.ambiguous, true);
    assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  }
});

test("uv temporary-cache aliases and repeated declarations do not invent a winner", () => {
  for (const flag of ["--no-cache", "--no-cache-dir", "-n"]) {
    assert.equal(inspectNativeCacheOptions("uv", [flag, "cache", "dir"]).declarations[0].effect, "temporary-cache");
  }
  const repeated = inspectNativeCacheOptions("npm", ["--cache=one", "--cache=two", "config"]);
  assert.equal(repeated.ambiguous, true); assert.equal(repeated.effectiveDestination, null);
  assert.equal(inspectNativeCacheOptions("uv", ["--no-cache", "--cache-dir=two"]).ambiguous, true);
  assert.equal(inspectNativeCacheOptions("uv", ["--no-cache=false"]).declarations.length, 0);
});

test("bounded inspection and frozen argv preserve literal path spelling", () => {
  const args = Object.freeze(["--cache=~/literal/$NOT_EXPANDED", "command"]);
  assert.equal(inspectNativeCacheOptions("npm", args).declarations[0].value, "~/literal/$NOT_EXPANDED");
  const many = inspectNativeCacheOptions("npm", Array(1000).fill("--cache=path"));
  assert.equal(many.declarations.length, 32); assert.equal(many.stopReason, "inspection-limit");
  assert.throws(() => inspectNativeCacheOptions("npm", "--cache=path"), /array/);
});

test("explain reports native declarations alongside forced environment routing without writes", (t) => {
  const f = fixture(t);
  f.env.npm_config_cache = path.join(f.root, "environment-cache"); f.env.CLEAN_DEVELOPMENT_FORCE = "1";
  const before = snapshot(f.root), envBefore = { ...f.env };
  const args = ["--cache", path.join(f.root, "native-cache"), "config", "get", "cache"];
  const report = explainCommand("npm", args, f);
  assert.equal(report.routing.variables.find((item) => item.name === "npm_config_cache").action, "set");
  assert.equal(report.routing.nativeCacheOptions.declarations[0].value, args[1]);
  assert.match(formatExplanation(report), /Native --cache: declared path/);
  assert.equal(report.routing.nativeCacheOptions.observed, false);
  assert.deepEqual(f.env, envBefore); assert.deepEqual(snapshot(f.root), before);
});

test("cache declaration display escapes controls while JSON retains exact values", (t) => {
  const f = fixture(t), value = "cache\u2028\x1b[0m";
  const report = explainCommand("npm", [`--cache=${value}`, "config"], f);
  const before = JSON.stringify(report), text = formatExplanation(report);
  assert.ok(text.includes("\\u2028")); assert.doesNotMatch(text, /[\x1b\u2028]/u);
  assert.equal(JSON.stringify(report), before);
  assert.equal(JSON.parse(before).routing.nativeCacheOptions.declarations[0].value, value);
  const temporary = formatExplanation(explainCommand("uv", ["--no-cache", "cache", "dir"], f));
  assert.match(temporary, /does not mean zero writes/);
});

test("public CLI explains a native cache prefix without executing or exposing trailing arguments", (t) => {
  const f = fixture(t), before = snapshot(f.root);
  const result = spawnSync(process.execPath, [cli, "explain", "--json", "--", "npm", "--cache=custom", "--", "PRIVATE_ARGUMENT"], {
    cwd: f.cwd, env: f.env, encoding: "utf8", timeout: 10000
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.routing.nativeCacheOptions.declarations[0].value, "custom");
  assert.equal(report.routing.nativeCacheOptions.stopReason, "argument-boundary");
  assert.doesNotMatch(result.stdout, /PRIVATE_ARGUMENT/);
  assert.deepEqual(snapshot(f.root), before);
});

function query(executable, args, f) {
  const invocation = process.platform === "win32" && /\.(cmd|bat)$/i.test(executable)
    ? windowsBatchInvocation(executable, args, f.env) : { command: executable, args };
  const result = spawnSync(invocation.command, invocation.args, { cwd: f.cwd, env: f.env,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments, encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}
for (const tool of ["npm", "uv"]) {
  test(`installed ${tool} confirms a leading native cache path supersedes the environment`, (t) => {
    const f = fixture(t), executable = resolveExecutable(tool, f.env, undefined, f.cwd);
    if (!executable) { if (tool === "npm") assert.fail("npm is required for this contract"); t.skip("uv unavailable"); return; }
    const variable = tool === "npm" ? "npm_config_cache" : "UV_CACHE_DIR";
    f.env[variable] = path.join(f.root, "environment-cache");
    const selected = path.join(f.root, "native-cache");
    const args = tool === "npm" ? ["--cache", selected, "config", "get", "cache"]
      : ["--cache-dir", selected, "cache", "dir", "--offline", "--no-config"];
    const declaration = explainCommand(tool, args, f).routing.nativeCacheOptions.declarations[0];
    assert.equal(path.resolve(query(executable, args, f)), path.resolve(declaration.value));
    t.diagnostic(`${tool}: ${query(executable, ["--version"], f)}`);
    if (tool === "uv") for (const flag of ["--no-cache", "--no-cache-dir", "-n"]) {
      const observed = query(executable, [flag, "cache", "dir", "--offline", "--no-config"], f);
      assert.notEqual(path.resolve(observed), path.resolve(f.env[variable]));
    }
  });
}
