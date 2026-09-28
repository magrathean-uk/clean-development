import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { resolveConfig } from "../src/config.js";
import { VERSION } from "../src/constants.js";
import { ensureRuntime, packageRoot, removeRuntime, runtimeHealth, runtimeRemovalPlan } from "../src/runtime.js";
import { isolatedEnvironment } from "../scripts/harness-utils.mjs";

const OLD_VERSION = "0.0.9";
const MARKER = ".clean-development-runtime.json";
const directoryLink = process.platform === "win32" ? "junction" : "dir";
const digest = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

function temporary(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "clean-development-runtime-install-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function fixture(t) {
  const root = temporary(t);
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const env = isolatedEnvironment(root, {});
  const config = resolveConfig({ cwd: project, env });
  fs.mkdirSync(config.locations.binDir, { recursive: true });
  const unrelated = path.join(config.locations.binDir, "unrelated-user-file");
  fs.writeFileSync(unrelated, "not owned by the runtime\n");
  return { root, project, env, config, unrelated, receiptFile: path.join(config.locations.stateDir, "runtime.json") };
}

// A synthetic earlier package exercises the publication protocol, not release compatibility.
async function previousInstaller(t) {
  const source = temporary(t);
  for (const entry of ["bin", "src", "package.json"]) {
    fs.cpSync(path.join(packageRoot(), entry), path.join(source, entry), { recursive: true });
  }
  const constants = path.join(source, "src", "constants.js");
  fs.writeFileSync(constants, fs.readFileSync(constants, "utf8").replace(`export const VERSION = "${VERSION}";`, `export const VERSION = "${OLD_VERSION}";`));
  const manifest = path.join(source, "package.json");
  fs.writeFileSync(manifest, JSON.stringify({ ...json(manifest), version: OLD_VERSION }));
  return (await import(pathToFileURL(path.join(source, "src", "runtime.js")).href)).ensureRuntime;
}

function snapshot(root) {
  const entries = [];
  function visit(file) {
    if (!fs.existsSync(file) && !fs.lstatSync(file, { throwIfNoEntry: false })) return;
    const stat = fs.lstatSync(file);
    const name = path.relative(root, file);
    if (stat.isSymbolicLink()) entries.push([name, "link", fs.readlinkSync(file)]);
    else if (stat.isDirectory()) {
      entries.push([name, "directory"]);
      for (const child of fs.readdirSync(file).sort()) visit(path.join(file, child));
    } else entries.push([name, "file", stat.mode & 0o777, digest(file)]);
  }
  visit(root);
  return entries;
}

function readOnlyHealth(item) {
  const before = snapshot(item.root);
  const health = runtimeHealth(item.config);
  assert.deepEqual(snapshot(item.root), before, "health must not repair or mutate the installation");
  return health;
}

// Complete the real filesystem operation, then interrupt. Only lock cleanup unwinds;
// this models publication states, not power-loss durability or stale-lock recovery.
function upgradeAt(t, item, stopAfter = null) {
  const { runtimeDir, stateDir, binDir } = item.config.locations;
  const versionRoot = path.join(runtimeDir, VERSION);
  const launcherNames = new Set(json(item.receiptFile).ownedFiles.map((record) => path.basename(record.path)));
  const events = [];
  const mocks = [];
  const stage = (directory) => path.dirname(directory) === runtimeDir && path.basename(directory).startsWith(`${VERSION}.tmp-`);
  function checkpoint(name) {
    events.push(name);
    if (name === stopAfter) throw Object.assign(new Error(`Interrupted after ${name}`), { code: "ETESTINTERRUPTED" });
  }
  function observe(method, classify) {
    const original = fs[method];
    mocks.push(t.mock.method(fs, method, (...args) => {
      const result = original(...args);
      const name = classify(...args);
      if (name) checkpoint(name);
      return result;
    }));
  }
  observe("mkdirSync", (file, options) => stage(String(file)) && !options?.recursive ? "staging-directory" : null);
  observe("cpSync", (_source, destination) => stage(path.dirname(destination)) ? `staging-copy:${path.basename(destination)}` : null);
  observe("chmodSync", (file) => path.dirname(file) === binDir && launcherNames.has(path.basename(file)) ? `launcher:${path.basename(file)}` : null);
  observe("renameSync", (_source, destination) => {
    if (path.dirname(destination) === path.join(stateDir, "runtime-receipts")) return "archive";
    if (stage(path.dirname(destination)) && path.basename(destination) === MARKER) return "runtime-marker";
    if (destination === versionRoot) return "runtime-directory";
    if (path.dirname(destination) === binDir && launcherNames.has(path.basename(destination))) return `launcher:${path.basename(destination)}`;
    if (destination === item.receiptFile) return "receipt";
    return null;
  });
  try {
    if (stopAfter) assert.throws(() => ensureRuntime(item.config), { code: "ETESTINTERRUPTED" });
    else ensureRuntime(item.config);
  } finally {
    for (const mocked of mocks.reverse()) mocked.mock.restore();
  }
  if (stopAfter) assert.equal(events.at(-1), stopAfter);
  return events;
}

function replaceWithUnownedAlias(versionRoot, relative = "src") {
  const original = path.join(versionRoot, relative);
  const unowned = path.join(versionRoot, "unrecorded-copy");
  fs.cpSync(original, unowned, { recursive: true });
  fs.rmSync(original, { recursive: true });
  fs.symlinkSync(unowned, original, directoryLink);
  return { original, unowned };
}

for (const operation of ["health", "setup", "uninstall"]) {
  test(`current inventory must not confer ownership through a directory alias during ${operation}`, (t) => {
    const item = fixture(t);
    const runtime = ensureRuntime(item.config);
    const { unowned } = replaceWithUnownedAlias(runtime.versionRoot);
    const before = snapshot(unowned);
    if (operation === "health") {
      const health = readOnlyHealth(item);
      assert.equal(health.ok, false);
      assert.match(health.detail, /symlink|real directory/);
    } else if (operation === "setup") {
      assert.throws(() => ensureRuntime(item.config), /symlink|real directory/);
    } else {
      const result = removeRuntime(item.config);
      assert.ok(result.retained.some((entry) => entry.startsWith(runtime.versionRoot)));
    }
    assert.deepEqual(snapshot(unowned), before, "byte-identical files at unrecorded paths are still unowned");
    assert.equal(fs.readFileSync(item.unrelated, "utf8"), "not owned by the runtime\n");
  });
}

test("a published copy without a receipt cannot adopt files through an unrecorded alias", (t) => {
  const item = fixture(t);
  const runtime = ensureRuntime(item.config);
  const receipt = json(item.receiptFile);
  for (const entry of receipt.ownedFiles) fs.unlinkSync(entry.path);
  fs.unlinkSync(item.receiptFile);
  const { unowned } = replaceWithUnownedAlias(runtime.versionRoot);
  const before = snapshot(item.root);
  assert.deepEqual(readOnlyHealth(item), { ok: false, detail: "not installed" });
  assert.equal(ensureRuntime(item.config, { automatic: true }), null);
  assert.deepEqual(removeRuntime(item.config), { removed: [], retained: [] });
  assert.deepEqual(snapshot(item.root), before);
  assert.throws(() => ensureRuntime(item.config), /symlink|real directory/);
  assert.deepEqual(snapshot(item.root), before);
  assert.ok(fs.existsSync(path.join(unowned, "runtime.js")));
});

test("archived inventories cannot delete an unrecorded copy through a directory alias", async (t) => {
  const installPrevious = await previousInstaller(t);
  const item = fixture(t);
  const old = installPrevious(item.config);
  const current = ensureRuntime(item.config);
  const { unowned } = replaceWithUnownedAlias(old.versionRoot);
  const before = snapshot(unowned);
  assert.equal(readOnlyHealth(item).ok, true, "health checks the active version, not archived files");
  ensureRuntime(item.config);
  const planBefore = snapshot(item.root);
  const plan = runtimeRemovalPlan(item.config);
  assert.deepEqual(snapshot(item.root), planBefore);
  const result = removeRuntime(item.config);
  assert.deepEqual(snapshot(unowned), before);
  assert.ok(result.retained.some((entry) => entry.startsWith(old.versionRoot)));
  assert.equal(fs.existsSync(current.versionRoot), false);
  assert.equal(plan.archivedReceipts.length, 1);
  assert.ok(fs.existsSync(plan.archivedReceipts[0]), "uncertain archived inventory must be retained");
});

test("empty directory cleanup cannot follow an archived alias after recorded files disappear", (t) => {
  const item = fixture(t);
  ensureRuntime(item.config);
  const versionRoot = path.join(item.config.locations.runtimeDir, OLD_VERSION);
  const unowned = path.join(versionRoot, "unrecorded-copy", "nested");
  fs.mkdirSync(unowned, { recursive: true });
  fs.symlinkSync(path.dirname(unowned), path.join(versionRoot, "src"), directoryLink);
  const marker = path.join(versionRoot, MARKER);
  fs.writeFileSync(marker, JSON.stringify({ schemaVersion: 1, owner: "clean-development", version: OLD_VERSION, installationId: "empty-alias" }));
  const archiveDir = path.join(item.config.locations.stateDir, "runtime-receipts");
  fs.mkdirSync(archiveDir);
  const archive = path.join(archiveDir, `${OLD_VERSION}-empty-alias.json`);
  fs.writeFileSync(archive, JSON.stringify({
    ...json(item.receiptFile), version: OLD_VERSION, installationId: "empty-alias", versionRoot,
    runtimeFiles: [
      { path: path.join(versionRoot, "src", "nested", "missing.js"), sha256: "0".repeat(64) },
      { path: marker, sha256: digest(marker) }
    ]
  }));
  removeRuntime(item.config);
  assert.ok(fs.existsSync(unowned), "an unrecorded empty directory is not owned merely because an inventory alias resolves to it");
  assert.ok(fs.existsSync(archive));
});

test("every completed upgrade publication has explicit retry, health and uninstall outcomes", async (t) => {
  const installPrevious = await previousInstaller(t);
  const control = fixture(t);
  installPrevious(control.config);
  const checkpoints = upgradeAt(t, control);
  assert.deepEqual(checkpoints.slice(0, 7), ["archive", "staging-directory", "staging-copy:bin", "staging-copy:src", "staging-copy:package.json", "runtime-marker", "runtime-directory"]);
  assert.equal(checkpoints.at(-1), "receipt");
  assert.equal(new Set(checkpoints).size, checkpoints.length);
  const launchers = json(control.receiptFile).ownedFiles.map((entry) => `launcher:${path.basename(entry.path)}`);
  assert.deepEqual(checkpoints.slice(7, -1), launchers, "exercise each stable launcher, including the unchanged shell helper");

  for (const checkpoint of checkpoints) {
    await t.test(checkpoint, (t) => {
      const item = fixture(t);
      const old = installPrevious(item.config);
      const previous = json(item.receiptFile);
      upgradeAt(t, item, checkpoint);
      const published = checkpoint === "receipt";
      const versionRoot = path.join(item.config.locations.runtimeDir, VERSION);
      const versionPublished = fs.existsSync(versionRoot);
      const changedLaunchers = previous.ownedFiles.filter((entry) => fs.existsSync(entry.path) && digest(entry.path) !== entry.sha256);
      const mixed = !published && changedLaunchers.length > 0;
      const health = readOnlyHealth(item);
      assert.equal(health.ok, published);
      if (!published) assert.match(health.detail, /installed; run clean-development update/);
      const beforePlan = snapshot(item.root);
      const plan = runtimeRemovalPlan(item.config);
      assert.deepEqual(snapshot(item.root), beforePlan);
      assert.ok(plan.files.includes(previous.runtimeFiles[0].path));
      assert.equal(plan.files.some((file) => file.startsWith(`${versionRoot}${path.sep}`)), published);

      // Replay setup and uninstall independently from the same interrupted state.
      const saved = path.join(item.root, "saved-data");
      fs.cpSync(item.config.locations.dataDir, saved, { recursive: true });
      if (mixed) {
        assert.throws(() => ensureRuntime(item.config), /Refusing to overwrite unowned or modified runtime file/);
        assert.equal(readOnlyHealth(item).ok, false);
      } else {
        ensureRuntime(item.config);
        assert.equal(readOnlyHealth(item).ok, true);
      }
      fs.rmSync(item.config.locations.dataDir, { recursive: true });
      fs.cpSync(saved, item.config.locations.dataDir, { recursive: true });
      fs.rmSync(saved, { recursive: true });
      const partialDirectories = fs.readdirSync(item.config.locations.runtimeDir).filter((name) => name.includes(".tmp-"));
      const partialBefore = partialDirectories.map((name) => snapshot(path.join(item.config.locations.runtimeDir, name)));
      const result = removeRuntime(item.config);
      assert.equal(fs.existsSync(old.versionRoot), false);
      assert.equal(fs.existsSync(versionRoot), versionPublished && !published);
      for (const entry of previous.ownedFiles) {
        const retained = !published && changedLaunchers.some((changed) => changed.path === entry.path);
        assert.equal(fs.existsSync(entry.path), retained, entry.path);
        if (retained) assert.ok(result.retained.includes(entry.path));
      }
      assert.deepEqual(partialDirectories.map((name) => snapshot(path.join(item.config.locations.runtimeDir, name))), partialBefore, "unreceipted staging content is not deletion authority");
      assert.equal(fs.readFileSync(item.unrelated, "utf8"), "not owned by the runtime\n");
      assert.equal(json(item.receiptFile).status, "uninstalled");
      const after = snapshot(item.root);
      assert.equal(ensureRuntime(item.config, { automatic: true }), null);
      assert.deepEqual(snapshot(item.root), after);
    });
  }
});

test("missing active receipts retain launchers and archived inventories rather than guessing ownership", async (t) => {
  const installPrevious = await previousInstaller(t);
  const item = fixture(t);
  installPrevious(item.config);
  ensureRuntime(item.config);
  fs.unlinkSync(item.receiptFile);
  const before = snapshot(item.root);
  assert.deepEqual(readOnlyHealth(item), { ok: false, detail: "not installed" });
  assert.equal(ensureRuntime(item.config, { automatic: true }), null);
  assert.throws(() => ensureRuntime(item.config), /unowned or modified runtime file/);
  assert.deepEqual(removeRuntime(item.config), { removed: [], retained: [] });
  assert.deepEqual(snapshot(item.root), before);
});

test("modified launchers, runtime files and unknown archive records survive explicit uninstall", async (t) => {
  const installPrevious = await previousInstaller(t);
  const item = fixture(t);
  const old = installPrevious(item.config);
  const current = ensureRuntime(item.config);
  const launcher = json(item.receiptFile).ownedFiles[0].path;
  const activeFile = path.join(current.versionRoot, "src", "runtime.js");
  const archivedFile = path.join(old.versionRoot, "src", "runtime.js");
  const unknownArchive = path.join(item.config.locations.stateDir, "runtime-receipts", "unrelated.json");
  for (const file of [launcher, activeFile, archivedFile]) fs.writeFileSync(file, "modified; retain me\n");
  fs.writeFileSync(unknownArchive, "{}\n");
  assert.equal(readOnlyHealth(item).ok, false);
  assert.throws(() => ensureRuntime(item.config), /modified/);
  const result = removeRuntime(item.config);
  for (const file of [launcher, activeFile, archivedFile]) {
    assert.equal(fs.readFileSync(file, "utf8"), "modified; retain me\n");
    assert.ok(result.retained.includes(file));
  }
  assert.equal(fs.readFileSync(unknownArchive, "utf8"), "{}\n");
});
