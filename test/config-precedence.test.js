import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { findProjectConfig, readUserConfig, resolveConfig } from "../src/config.js";
import { DEFAULT_CONFIG } from "../src/constants.js";
import { platformPaths } from "../src/platform.js";
import { planSession } from "../src/session.js";

const CLI = fileURLToPath(new URL("../bin/clean-development.js", import.meta.url));
const PATHS = {
  root: ["CLEAN_DEVELOPMENT_ROOT", null],
  cacheRoot: ["CLEAN_DEVELOPMENT_CACHE_ROOT", "caches"],
  buildRoot: ["CLEAN_DEVELOPMENT_BUILD_ROOT", "builds"],
  scratchRoot: ["CLEAN_DEVELOPMENT_SCRATCH_ROOT", "scratch"]
};
const write = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cd-precedence-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"), project = path.join(root, "project"), configDir = path.join(root, "config");
  for (const dir of [home, project, configDir]) fs.mkdirSync(dir);
  const env = { CLEAN_DEVELOPMENT_HOME: home, HOME: home, USERPROFILE: home,
    CLEAN_DEVELOPMENT_DATA_HOME: path.join(root, "data"), CLEAN_DEVELOPMENT_CONFIG_HOME: configDir };
  const userFile = path.join(configDir, "config.json"), projectFile = path.join(project, ".clean-development.json");
  write(userFile, { schemaVersion: 1 });
  write(projectFile, { schemaVersion: 1 });
  // Bound project discovery without relying on the runner's ancestor settings.
  const ancestorFile = path.join(root, ".clean-development.json");
  write(ancestorFile, { schemaVersion: 1, root: path.join(root, "ancestor-storage") });
  write(path.join(project, "package.json"), { name: "precedence-fixture", private: true });
  return { root, home, project, env, userFile, projectFile, ancestorFile };
}
function snapshot(root) {
  const result = {};
  const visit = (file) => {
    const stat = fs.lstatSync(file);
    const key = path.relative(root, file) || ".";
    if (stat.isSymbolicLink()) result[key] = ["link", fs.readlinkSync(file)];
    else if (stat.isDirectory()) { result[key] = ["directory"]; for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name)); }
    else result[key] = ["file", fs.readFileSync(file).toString("base64"), stat.mode, stat.mtimeMs];
  };
  visit(root);
  return result;
}
function link(t, target, file, type = "file") {
  try { fs.symlinkSync(target, file, type); return true; }
  catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error.code)) {
      t.skip("Creating file symlinks requires privileges on this Windows host"); return false;
    }
    throw error;
  }
}

for (const [key, [variable, suffix]] of Object.entries(PATHS)) {
  test(`${key}: all 16 conflicting-layer combinations retain the winning value and source`, async (t) => {
    for (let mask = 0; mask < 16; mask += 1) await t.test(`layer mask ${mask.toString(2).padStart(4, "0")}`, (t) => {
      const item = fixture(t), user = { schemaVersion: 1 }, project = { schemaVersion: 1 };
      const env = { ...item.env }, overrides = key === "root" ? {} : { root: path.join(item.root, "command-root") };
      const values = ["user", "project", "environment", "command"].map((layer) => path.join(item.root, `${layer}-${key}`));
      if (mask & 1) user[key] = values[0];
      if (mask & 2) project[key] = values[1];
      if (mask & 4) env[variable] = values[2];
      if (mask & 8) overrides[key] = values[3];
      write(item.userFile, user); write(item.projectFile, project);
      const before = snapshot(item.root), input = JSON.stringify({ env, overrides });
      const config = resolveConfig({ cwd: item.project, env: Object.freeze(env), overrides: Object.freeze(overrides) });
      const winner = [3, 2, 1, 0].find((index) => mask & (1 << index));
      const fallback = suffix ? path.join(overrides.root, suffix) : platformPaths(env).defaultRoot;
      const sources = [item.userFile, item.projectFile, key === "root" ? "environment" : `environment: ${variable}`, "command line"];
      const source = winner === undefined ? (suffix ? "derived from root (command line)" : "platform default") : sources[winner];
      assert.equal(config[key], winner === undefined ? fallback : values[winner]);
      assert.equal(config.pathSources[key], source);
      assert.equal(config.rootSource, config.pathSources.root);
      if (key === "root") for (const [childKey, [, childSuffix]] of Object.entries(PATHS).slice(1)) {
        assert.equal(config[childKey], path.join(config.root, childSuffix));
        assert.equal(config.pathSources[childKey], `derived from root (${source})`);
      }
      assert.equal(JSON.stringify({ env, overrides }), input);
      assert.deepEqual(snapshot(item.root), before);
    });
  });
}

test("non-path values merge per field; false, zero and independent tool switches survive", async (t) => {
  for (let mask = 0; mask < 8; mask += 1) await t.test(`layer mask ${mask}`, (t) => {
    const item = fixture(t);
    const user = { schemaVersion: 1, agents: ["claude"] }, project = { schemaVersion: 1 }, overrides = {};
    if (mask & 1) Object.assign(user, { enabled: false, retention: { buildDays: 10 }, tools: { npm: false, go: false } });
    if (mask & 2) Object.assign(project, { enabled: true, retention: { buildDays: 20 }, tools: { npm: true, uv: false } });
    if (mask & 4) Object.assign(overrides, { enabled: false, retention: { buildDays: 0 }, tools: { npm: false } });
    write(item.userFile, user); write(item.projectFile, project);
    const config = resolveConfig({ cwd: item.project, env: item.env, overrides });
    assert.equal(config.enabled, mask & 4 ? false : mask & 2 ? true : mask & 1 ? false : true);
    assert.equal(config.retention.buildDays, mask & 4 ? 0 : mask & 2 ? 20 : mask & 1 ? 10 : 30);
    assert.equal(config.tools.npm, mask & 4 ? false : mask & 2 ? true : mask & 1 ? false : true);
    assert.equal(config.tools.go, !(mask & 1)); assert.equal(config.tools.uv, !(mask & 2));
    assert.deepEqual(config.agents, ["claude"]);
  });
});

test("changing only root leaves independent subroots selected from lower layers", (t) => {
  const item = fixture(t), user = { schemaVersion: 1 }, project = { schemaVersion: 1 };
  user.cacheRoot = path.join(item.root, "user-cache"); user.scratchRoot = path.join(item.root, "user-scratch");
  project.buildRoot = path.join(item.root, "project-build");
  write(item.userFile, user); write(item.projectFile, project);
  const config = resolveConfig({ cwd: item.project, env: { ...item.env, CLEAN_DEVELOPMENT_ROOT: path.join(item.root, "env-root") },
    overrides: { root: path.join(item.root, "cli-root") } });
  for (const key of ["cacheRoot", "scratchRoot"]) { assert.equal(config[key], user[key]); assert.equal(config.pathSources[key], item.userFile); }
  assert.equal(config.buildRoot, project.buildRoot); assert.equal(config.pathSources.buildRoot, item.projectFile);
});

test("only the nearest project file participates, even across a Git boundary", (t) => {
  const item = fixture(t), nested = path.join(item.project, "nested"); fs.mkdirSync(nested); fs.mkdirSync(path.join(nested, ".git"));
  write(item.ancestorFile, { schemaVersion: 1, enabled: false, tools: { npm: false }, root: path.join(item.root, "parent") });
  const config = resolveConfig({ cwd: nested, env: item.env });
  assert.equal(config.projectConfigPath, item.projectFile); assert.equal(config.rootSource, "platform default");
  assert.equal(config.enabled, true); assert.equal(config.tools.npm, true);
  fs.unlinkSync(item.projectFile);
  assert.equal(findProjectConfig(nested), item.ancestorFile);
  assert.equal(resolveConfig({ cwd: nested, env: item.env }).rootSource, item.ancestorFile);
});

const malformed = ["{", "null", "[]", "{}", '{"schemaVersion":2}', '{"schemaVersion":1,"enabled":"false"}',
  '{"schemaVersion":1,"cacheRoot":null}', '{"schemaVersion":1,"root":""}', '{"schemaVersion":1,"buildroot":"typo"}',
  '{"schemaVersion":1,"tools":{"npm":0}}', '{"schemaVersion":1,"retention":{"buildDays":-1}}'];
for (const layer of ["user", "project"]) test(`malformed ${layer} files fail even with higher-priority path overrides`, async (t) => {
  for (let index = 0; index < malformed.length; index += 1) await t.test(`invalid case ${index}`, (t) => {
    const item = fixture(t), file = layer === "user" ? item.userFile : item.projectFile;
    fs.writeFileSync(file, malformed[index]); const before = snapshot(item.root);
    assert.throws(() => resolveConfig({ cwd: item.project, env: { ...item.env, CLEAN_DEVELOPMENT_ROOT: path.join(item.root, "env") },
      overrides: { root: path.join(item.root, "cli") } }), (error) => error.message.includes(file));
    assert.deepEqual(snapshot(item.root), before);
  });
});

test("selected relative path errors identify the actual winning layer, not an unrelated project file", async (t) => {
  for (const [key, [variable]] of Object.entries(PATHS)) for (const layer of ["user", "project", "environment", "command"]) {
    await t.test(`${key} / ${layer}`, (t) => {
      const item = fixture(t), env = { ...item.env }, overrides = {};
      if (layer === "user") write(item.userFile, { schemaVersion: 1, [key]: "relative-storage" });
      if (layer === "project") write(item.projectFile, { schemaVersion: 1, [key]: "relative-storage" });
      if (layer === "environment") env[variable] = "relative-storage";
      if (layer === "command") overrides[key] = "relative-storage";
      const source = layer === "user" ? item.userFile : layer === "project" ? item.projectFile : layer === "command" ? "command line"
        : key === "root" ? "environment" : `environment: ${variable}`;
      assert.throws(() => resolveConfig({ cwd: item.project, env, overrides }), (error) =>
        error.message.includes(`Paths in ${source} must be absolute`));
    });
  }
});

test("empty storage environment overrides fail closed rather than selecting a lower layer", (t) => {
  const item = fixture(t);
  for (const [variable] of Object.values(PATHS)) for (const value of ["", " ", null, 0]) {
    assert.throws(() => resolveConfig({ cwd: item.project, env: { ...item.env, [variable]: value } }), (error) => error.message.includes(variable));
  }
});

for (const layer of ["user", "project"]) test(`readable ${layer} symlink preserves the selected location as origin without editing either file`, (t) => {
  const item = fixture(t), file = layer === "user" ? item.userFile : item.projectFile;
  const referent = path.join(item.root, `${layer}-referent.json`), storage = path.join(item.root, "external-storage");
  write(referent, { schemaVersion: 1, root: storage, enabled: false }); fs.unlinkSync(file);
  if (!link(t, path.relative(path.dirname(file), referent), file)) return;
  const before = snapshot(item.root), config = resolveConfig({ cwd: item.project, env: item.env });
  assert.equal(config.root, storage); assert.equal(config.rootSource, file); assert.equal(config.enabled, false);
  assert.deepEqual(snapshot(item.root), before);
});

for (const layer of ["user", "project"]) test(`dangling ${layer} config is an error, not permission to fall back`, (t) => {
  const item = fixture(t), file = layer === "user" ? item.userFile : item.projectFile;
  fs.unlinkSync(file);
  if (!link(t, path.join(item.root, "missing-config.json"), file)) return;
  const before = snapshot(item.root);
  assert.throws(() => resolveConfig({ cwd: item.project, env: item.env }), (error) => error.message.includes(file));
  if (layer === "user") assert.throws(() => readUserConfig(item.env), (error) => error.message.includes(file));
  assert.deepEqual(snapshot(item.root), before);
});

test("discovery selects a dangling nearest entry instead of an ancestor configuration", (t) => {
  const item = fixture(t); fs.unlinkSync(item.projectFile);
  if (!link(t, "absent.json", item.projectFile)) return;
  assert.equal(findProjectConfig(item.project), item.projectFile);
});

test("a symlink loop cannot hide the nearest config", (t) => {
  const item = fixture(t); fs.unlinkSync(item.projectFile);
  if (!link(t, path.basename(item.projectFile), item.projectFile)) return;
  assert.throws(() => resolveConfig({ cwd: item.project, env: item.env }), (error) => error.message.includes(item.projectFile));
});

test("a project config disappearing after discovery is not reclassified as absent", (t) => {
  const item = fixture(t), lstat = fs.lstatSync, exists = fs.existsSync;
  let seen = false, removed = false;
  const inspect = (file, read) => {
    if (file === item.projectFile) {
      if (seen && !removed) { fs.unlinkSync(file); removed = true; }
      seen = true;
    }
    return read();
  };
  // Covers both the original exists-based code and the corrected lstat lookup.
  t.mock.method(fs, "existsSync", (file) => inspect(file, () => exists(file)));
  t.mock.method(fs, "lstatSync", (file, options) => inspect(file, () => lstat(file, options)));
  assert.throws(() => resolveConfig({ cwd: item.project, env: item.env }), (error) => error.message.includes(item.projectFile));
  assert.equal(removed, true);
});

for (const code of ["EACCES", "EIO"]) test(`uncertain config lookup (${code}) does not select an ancestor`, (t) => {
  const item = fixture(t), exists = fs.existsSync, lstat = fs.lstatSync;
  t.mock.method(fs, "existsSync", (file) => file === item.projectFile ? false : exists(file));
  t.mock.method(fs, "lstatSync", (file, options) => {
    if (file === item.projectFile) throw Object.assign(new Error(`Cannot inspect ${file}`), { code });
    return lstat(file, options);
  });
  assert.throws(() => resolveConfig({ cwd: item.project, env: item.env }), { code });
});

test("includeProject=false intentionally ignores malformed and dangling project entries", (t) => {
  const item = fixture(t); fs.writeFileSync(item.projectFile, "{");
  const config = resolveConfig({ cwd: item.project, env: item.env, includeProject: false });
  assert.equal(config.projectConfigPath, null); assert.equal(config.rootSource, "platform default");
  fs.unlinkSync(item.projectFile);
  if (!link(t, "missing.json", item.projectFile)) return;
  assert.equal(resolveConfig({ cwd: item.project, env: item.env, includeProject: false }).projectConfigPath, null);
});

for (const [key, [variable]] of Object.entries(PATHS)) test(`${key}: project-local selections remain visible for read-only boundary diagnosis`, async (t) => {
  for (const location of ["project", "child", "alias", "sibling"]) await t.test(location, (t) => {
    const item = fixture(t), alias = path.join(item.root, "project-alias");
    if (location === "alias" && !link(t, item.project, alias, process.platform === "win32" ? "junction" : "dir")) return;
    const value = location === "project" ? item.project : location === "child" ? path.join(item.project, "storage")
      : location === "alias" ? path.join(alias, "storage") : path.join(item.root, "project-sibling", "storage");
    const expected = location === "alias" ? path.join(item.project, "storage") : value;
    const env = { ...item.env, [variable]: value }, before = snapshot(item.root);
    const config = resolveConfig({ cwd: item.project, env });
    assert.equal(config[key], expected);
    assert.equal(config.pathSources[key], key === "root" ? "environment" : `environment: ${variable}`);
    const plan = planSession({ cwd: item.project, env, config });
    assert.equal(plan.managed.repositoryPaths.includes(expected), location !== "sibling");
    assert.deepEqual(snapshot(item.root), before);
  });
});

test("filesystem/home roots are refused, including canonical aliases", (t) => {
  const item = fixture(t), alias = path.join(item.root, "home-alias");
  if (!link(t, item.home, alias, process.platform === "win32" ? "junction" : "dir")) return;
  for (const key of Object.keys(PATHS)) for (const value of [path.parse(item.root).root, item.home, alias]) {
    assert.throws(() => resolveConfig({ cwd: item.project, env: item.env, overrides: { [key]: value } }), /Refusing broad managed root/);
  }
});

test("setup/update CLI root overrides are cwd-normalised and intentionally exclude project config", (t) => {
  const item = fixture(t); fs.writeFileSync(item.projectFile, "{");
  const before = snapshot(item.root);
  for (const command of ["setup", "update"]) {
    const env = { ...item.env, CLEAN_DEVELOPMENT_ROOT: path.join(item.root, "env-root") };
    // Required only for spawning Node on Windows; do not forward ambient config.
    for (const key of ["SystemRoot", "WINDIR"]) if (process.env[key]) env[key] = process.env[key];
    const child = spawnSync(process.execPath, [CLI, command, "--root", "relative-cli-root", "--agents", "claude", "--dry-run", "--json"],
      { cwd: item.project, env, encoding: "utf8", timeout: 10000 });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    const report = JSON.parse(child.stdout);
    assert.equal(report.root, path.join(item.project, "relative-cli-root"));
    assert.equal(report.dryRun, true);
  }
  assert.deepEqual(snapshot(item.root), before);
});

test("results are independent of previous caller edits to defaults or nested merge results", (t) => {
  const item = fixture(t), defaults = JSON.stringify(DEFAULT_CONFIG), overrides = { tools: { npm: false }, retention: { buildDays: 0 } };
  const before = JSON.stringify(overrides);
  const first = resolveConfig({ cwd: item.project, env: item.env, overrides });
  first.tools.go = false; first.retention.buildDays = 999;
  const second = resolveConfig({ cwd: item.project, env: item.env });
  assert.equal(second.tools.go, true); assert.equal(second.retention.buildDays, 30);
  assert.equal(JSON.stringify(DEFAULT_CONFIG), defaults); assert.equal(JSON.stringify(overrides), before);
});


test("absent user configuration is optional, while a directory or invalid linked file is not", (t) => {
  const item = fixture(t); fs.unlinkSync(item.userFile);
  assert.equal(readUserConfig(item.env), null);
  assert.equal(resolveConfig({ cwd: item.project, env: item.env }).rootSource, "platform default");
  fs.mkdirSync(item.userFile);
  assert.throws(() => readUserConfig(item.env), (error) => error.message.includes(item.userFile));
  fs.rmdirSync(item.userFile);
  const bad = path.join(item.root, "invalid-linked-config.json"); fs.writeFileSync(bad, "{");
  if (!link(t, bad, item.userFile)) return;
  assert.throws(() => readUserConfig(item.env), (error) => error.message.includes(item.userFile));
});

test("non-selected path strings are not resolved, but malformed file shapes still cannot be masked", (t) => {
  const item = fixture(t);
  write(item.userFile, { schemaVersion: 1, root: "relative-but-overridden" });
  const env = { ...item.env, CLEAN_DEVELOPMENT_ROOT: "also-relative-but-overridden" };
  const commandRoot = path.join(item.root, "selected");
  const config = resolveConfig({ cwd: item.project, env, overrides: { root: commandRoot } });
  assert.equal(config.root, commandRoot); assert.equal(config.rootSource, "command line");
  write(item.userFile, { schemaVersion: 1, root: "" });
  assert.throws(() => resolveConfig({ cwd: item.project, env, overrides: { root: commandRoot } }), /root must be a non-empty string/);
});
