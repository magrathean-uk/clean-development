import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalizePotentialPath, environmentValue, isPathInside, platformPaths, setEnvironmentValue } from "../src/platform.js";

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cd-platform-precedence-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"); fs.mkdirSync(home);
  return { root, home };
}

test("home selection: CLEAN_DEVELOPMENT_HOME > HOME > USERPROFILE > os.homedir", async (t) => {
  for (let mask = 0; mask < 8; mask += 1) await t.test(`home layer mask ${mask}`, (t) => {
    const item = fixture(t), names = ["USERPROFILE", "HOME", "CLEAN_DEVELOPMENT_HOME"];
    const env = {}, values = names.map((name) => path.join(item.root, name));
    names.forEach((name, index) => { if (mask & (1 << index)) env[name] = values[index]; });
    const mockedHome = t.mock.method(os, "homedir", () => item.home);
    const winner = [2, 1, 0].find((index) => mask & (1 << index));
    assert.equal(platformPaths(Object.freeze(env)).home, winner === undefined ? item.home : values[winner]);
    assert.equal(mockedHome.mock.callCount(), mask ? 0 : 1);
  });
});

test("empty HOME/USERPROFILE fall through, but an explicit invalid Clean Development home does not", (t) => {
  const item = fixture(t); t.mock.method(os, "homedir", () => item.home);
  assert.equal(platformPaths({ HOME: "", USERPROFILE: item.home }).home, item.home);
  assert.equal(platformPaths({ HOME: "", USERPROFILE: "" }).home, item.home);
  for (const value of ["", " ", "relative", item.root.slice(0, 1), null]) {
    assert.throws(() => platformPaths({ HOME: item.home, CLEAN_DEVELOPMENT_HOME: value }), /CLEAN_DEVELOPMENT_HOME/);
  }
  assert.throws(() => platformPaths({ HOME: "relative", USERPROFILE: item.home }), /HOME/);
});

for (const platform of ["linux", "darwin", "win32"]) test(`${platform}: base-location precedence and derived paths`, (t) => {
  const item = fixture(t), env = { CLEAN_DEVELOPMENT_HOME: item.home };
  // The platform argument tests location selection with host-native fixture
  // paths. This is not Windows path-grammar or native-host acceptance.
  const expectedDefaults = platform === "linux" ? [path.join(item.home, ".local", "share", "clean-development"),
    path.join(item.home, ".config", "clean-development"), path.join(item.home, ".cache", "clean-development")]
    : platform === "darwin" ? [path.join(item.home, "Library", "Application Support", "clean-development"),
      path.join(item.home, "Library", "Application Support", "clean-development"), path.join(item.home, "Library", "Caches", "clean-development")]
      : [path.join(item.home, "AppData", "Local", "clean-development"), path.join(item.home, "AppData", "Roaming", "clean-development"),
        path.join(item.home, "AppData", "Local", "clean-development", "cache")];
  const names = ["dataDir", "configDir", "defaultRoot"];
  const base = platformPaths(env, platform);
  names.forEach((name, index) => assert.equal(base[name], expectedDefaults[index]));
  const osEnv = { ...env, XDG_DATA_HOME: path.join(item.root, "xdg-data"), XDG_CONFIG_HOME: path.join(item.root, "xdg-config"),
    XDG_CACHE_HOME: path.join(item.root, "xdg-cache"), LOCALAPPDATA: path.join(item.root, "local"), APPDATA: path.join(item.root, "roaming") };
  const selected = platformPaths(osEnv, platform);
  const expectedOs = platform === "linux" ? [path.join(osEnv.XDG_DATA_HOME, "clean-development"), path.join(osEnv.XDG_CONFIG_HOME, "clean-development"),
    path.join(osEnv.XDG_CACHE_HOME, "clean-development")]
    : platform === "win32" ? [path.join(osEnv.LOCALAPPDATA, "clean-development"), path.join(osEnv.APPDATA, "clean-development"),
      path.join(osEnv.LOCALAPPDATA, "clean-development", "cache")] : expectedDefaults;
  names.forEach((name, index) => assert.equal(selected[name], expectedOs[index]));
  const customData = path.join(item.root, "custom-data"), customConfig = path.join(item.root, "custom-config");
  const dataOnly = platformPaths({ ...osEnv, CLEAN_DEVELOPMENT_DATA_HOME: customData }, platform);
  assert.equal(dataOnly.configDir, platform === "darwin" ? customData : selected.configDir);
  const customEnv = Object.freeze({ ...osEnv, CLEAN_DEVELOPMENT_DATA_HOME: customData, CLEAN_DEVELOPMENT_CONFIG_HOME: customConfig });
  const result = platformPaths(customEnv, platform);
  assert.equal(result.dataDir, customData); assert.equal(result.configDir, customConfig);
  assert.equal(result.defaultRoot, selected.defaultRoot);
  assert.equal(result.configPath, path.join(customConfig, "config.json"));
  for (const [key, tail] of [["runtimeDir", "runtime"], ["stateDir", "state"], ["binDir", "bin"]]) assert.equal(result[key], path.join(customData, tail));
  assert.deepEqual(fs.readdirSync(item.root), ["home"]);
});

test("base paths reject empty, relative and broad values without masking them behind custom locations", (t) => {
  const item = fixture(t), env = { CLEAN_DEVELOPMENT_HOME: item.home,
    CLEAN_DEVELOPMENT_DATA_HOME: path.join(item.root, "data"), CLEAN_DEVELOPMENT_CONFIG_HOME: path.join(item.root, "config") };
  for (const platform of ["linux", "darwin", "win32"]) {
    const names = ["CLEAN_DEVELOPMENT_DATA_HOME", "CLEAN_DEVELOPMENT_CONFIG_HOME",
      ...(platform === "linux" ? ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"] : platform === "win32" ? ["LOCALAPPDATA", "APPDATA"] : [])];
    for (const name of names) for (const value of ["", "relative", path.parse(item.root).root, item.home]) {
      assert.throws(() => platformPaths({ ...env, [name]: value }, platform), (error) => error.message.includes(name));
    }
  }
});

test("environment key matching is case-insensitive and duplicate spellings use enumeration order", (t) => {
  const item = fixture(t);
  const env = Object.freeze({ clean_development_home: item.home, clean_development_data_home: path.join(item.root, "lower-data") });
  assert.equal(platformPaths(env).home, item.home);
  assert.equal(platformPaths(env).dataDir, env.clean_development_data_home);
  assert.equal(environmentValue({ HOME: "first", home: "second" }, "home"), "first");
  assert.equal(environmentValue({ home: "first", HOME: "second" }, "HOME"), "first");
  const changed = { HOME: "first", home: "second", keep: "unchanged" };
  setEnvironmentValue(changed, "HOME", item.home);
  assert.deepEqual(changed, { HOME: item.home, keep: "unchanged" });
});

test("canonical aliases with missing tails preserve containment without creating directories", (t) => {
  const item = fixture(t), alias = path.join(item.root, "alias");
  fs.symlinkSync(item.home, alias, process.platform === "win32" ? "junction" : "dir");
  const candidate = path.join(alias, "not-created", "cache");
  assert.equal(canonicalizePotentialPath(candidate), path.join(item.home, "not-created", "cache"));
  assert.equal(isPathInside(item.home, candidate), true);
  assert.equal(isPathInside(item.home, alias), false); // Strict containment, not equality.
  assert.equal(isPathInside(item.home, path.join(item.root, "home-sibling")), false);
  assert.equal(fs.existsSync(path.join(item.home, "not-created")), false);
});
