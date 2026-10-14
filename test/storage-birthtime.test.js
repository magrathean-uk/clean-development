import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureOwnedBuildRoot, OWNERSHIP_MARKER } from "../src/adapters.js";
import { resolveConfig } from "../src/config.js";
import { directoryIdentities, revalidateDirectoryIdentities } from "../src/io.js";
import { approveManagedBuildRoot, validateManagedBuildRoot } from "../src/storage-identity.js";
import { isolatedEnvironment } from "../scripts/harness-utils.mjs";

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "clean-development-birthtime-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "Cargo.toml"), '[package]\nname="birthtime"\nversion="0.0.0"\n');
  const config = resolveConfig({ cwd: source, env: isolatedEnvironment(root) });
  for (const directory of [config.cacheRoot, config.buildRoot, config.scratchRoot]) fs.mkdirSync(directory, { recursive: true });
  return { root, config, workspace: { id: "fixture-birthtime-1234567890", root: source } };
}

function withCtimeFallback(run) {
  const original = fs.lstatSync;
  fs.lstatSync = function lstatWithCtimeFallback(...args) {
    const stat = original.apply(this, args);
    return new Proxy(stat, {
      get(target, property, receiver) {
        if (property === "birthtimeNs") return Reflect.get(target, "ctimeNs", target);
        return Reflect.get(target, property, receiver);
      }
    });
  };
  try { return run(); }
  finally { fs.lstatSync = original; }
}

function withFreshEqualBirthAndCtime(directory, run) {
  const original = fs.lstatSync;
  let birthtimeNs;
  fs.lstatSync = function lstatFreshEqual(...args) {
    const stat = original.apply(this, args);
    if (path.resolve(args[0]) !== directory || args[1]?.bigint !== true) return stat;
    if (birthtimeNs === undefined) birthtimeNs = stat.ctimeNs;
    return new Proxy(stat, {
      get(target, property, receiver) {
        if (property === "birthtimeNs") return birthtimeNs;
        return Reflect.get(target, property, receiver);
      }
    });
  };
  try { return run(); }
  finally { fs.lstatSync = original; }
}

test("ctime-backed birthtime is detected across directory mutation", (t) => {
  const item = fixture(t);
  withCtimeFallback(() => {
    const snapshots = directoryIdentities(item.config.buildRoot);
    fs.mkdirSync(path.join(item.config.buildRoot, "mutation"));
    assert.throws(() => revalidateDirectoryIdentities(snapshots), /does not provide a stable directory birth time/);
  });
});

test("a genuine birthtime equal to initial ctime is accepted after a stable-time observation", (t) => {
  const item = fixture(t);
  withFreshEqualBirthAndCtime(item.config.buildRoot, () => {
    ensureOwnedBuildRoot(item.config, item.workspace);
    const entries = fs.readdirSync(item.config.buildRoot);
    assert.deepEqual(entries, [item.workspace.id]);
    const receipts = path.join(item.config.locations.stateDir, "storage-identities");
    const before = JSON.parse(fs.readFileSync(path.join(receipts, fs.readdirSync(receipts)[0]), "utf8"));
    approveManagedBuildRoot(item.config);
    assert.deepEqual(fs.readdirSync(item.config.buildRoot), entries, "unchanged approval performs no probe");
    assert.equal(validateManagedBuildRoot(item.config).identity.birthtimeNs, before.identity.birthtimeNs);
  });
  assert.deepEqual(fs.readdirSync(item.config.buildRoot), [item.workspace.id]);
});

test("ctime-backed birthtime cannot publish an ownership marker or durable storage receipt", (t) => {
  const item = fixture(t);
  withCtimeFallback(() => {
    assert.throws(() => ensureOwnedBuildRoot(item.config, item.workspace), /does not provide a verifiably stable directory birth time/);
  });
  assert.equal(fs.existsSync(path.join(item.config.buildRoot, item.workspace.id, OWNERSHIP_MARKER)), false);
  const receipts = path.join(item.config.locations.stateDir, "storage-identities");
  assert.equal(fs.existsSync(receipts) ? fs.readdirSync(receipts).length : 0, 0);
  assert.deepEqual(fs.readdirSync(item.config.buildRoot), [], "failed approval cleans only its empty private probe");
});

test("read-only identity validation does not probe or mutate managed storage", (t) => {
  const item = fixture(t);
  ensureOwnedBuildRoot(item.config, item.workspace);
  const before = fs.readdirSync(item.config.buildRoot);
  withCtimeFallback(() => {
    assert.throws(() => validateManagedBuildRoot(item.config), { code: "CLEAN_DEVELOPMENT_STORAGE_CHANGED" });
  });
  assert.deepEqual(fs.readdirSync(item.config.buildRoot), before);
});

test("read-only validation refuses a root with no positive birthtime", (t) => {
  const item = fixture(t);
  ensureOwnedBuildRoot(item.config, item.workspace);
  const before = fs.readdirSync(item.config.buildRoot);
  const original = fs.lstatSync;
  fs.lstatSync = function zeroRootBirthtime(...args) {
    const stat = original.apply(this, args);
    if (path.resolve(String(args[0])) !== item.config.buildRoot || args[1]?.bigint !== true) return stat;
    return new Proxy(stat, {
      get(target, property, receiver) {
        if (property === "birthtimeNs") return 0n;
        return Reflect.get(target, property, receiver);
      }
    });
  };
  try {
    assert.throws(() => validateManagedBuildRoot(item.config), /no usable stable directory birth time/);
  } finally {
    fs.lstatSync = original;
  }
  assert.deepEqual(fs.readdirSync(item.config.buildRoot), before);
});

test("a zero-birthtime receipt cannot grant storage authority", (t) => {
  const item = fixture(t);
  ensureOwnedBuildRoot(item.config, item.workspace);
  const receiptDirectory = path.join(item.config.locations.stateDir, "storage-identities");
  const receipt = path.join(receiptDirectory, fs.readdirSync(receiptDirectory)[0]);
  const value = JSON.parse(fs.readFileSync(receipt, "utf8"));
  value.identity.birthtimeNs = "0";
  fs.writeFileSync(receipt, `${JSON.stringify(value, null, 2)}\n`);
  assert.throws(() => validateManagedBuildRoot(item.config), /Invalid storage identity receipt/);
});

test("probe cleanup retains the child when its managed-root ancestor is replaced", (t) => {
  const item = fixture(t);
  const original = fs.lstatSync;
  let probeChecks = 0;
  const retired = path.join(item.root, "retired-builds");
  fs.lstatSync = function replaceRootBeforeProbeCleanup(...args) {
    const stat = original.apply(this, args);
    if (path.basename(String(args[0])).startsWith(".clean-development-identity-probe-")) {
      probeChecks += 1;
      if (probeChecks === 2) {
        fs.renameSync(item.config.buildRoot, retired);
        fs.mkdirSync(item.config.buildRoot);
      }
    }
    return stat;
  };
  let failure;
  try {
    ensureOwnedBuildRoot(item.config, item.workspace);
  } catch (error) {
    failure = error;
  } finally {
    fs.lstatSync = original;
  }
  assert.equal(failure?.code, "CLEAN_DEVELOPMENT_STORAGE_PROBE_CLEANUP");
  assert.equal(fs.existsSync(path.join(item.config.buildRoot, item.workspace.id, OWNERSHIP_MARKER)), false);
  const retained = fs.readdirSync(retired);
  assert.equal(retained.length, 1);
  assert.match(retained[0], /^\.clean-development-identity-probe-/);
  assert.deepEqual(failure.cleanup, { code: "ENOENT", path: path.join(item.config.buildRoot, retained[0]), retained: true });
});

test("first probe lstat failure retains and identifies the unverified private directory", (t) => {
  const item = fixture(t);
  const original = fs.lstatSync;
  let failure;
  fs.lstatSync = function failFirstProbeLstat(...args) {
    if (path.basename(String(args[0])).startsWith(".clean-development-identity-probe-")) {
      const error = new Error("injected probe stat failure");
      error.code = "EIO";
      throw error;
    }
    return original.apply(this, args);
  };
  try {
    ensureOwnedBuildRoot(item.config, item.workspace);
  } catch (error) {
    failure = error;
  } finally {
    fs.lstatSync = original;
  }
  assert.equal(failure?.code, "EIO", "preserve the primary error code");
  assert.deepEqual(failure.cleanup, {
    code: "IDENTITY_UNVERIFIED",
    path: path.join(item.config.buildRoot, fs.readdirSync(item.config.buildRoot)[0]),
    retained: true
  });
  assert.match(failure.cleanup.path, /\.clean-development-identity-probe-/);
  assert.equal(fs.lstatSync(failure.cleanup.path).isDirectory(), true);
});

test("cleanup failure reports and retains a nonempty probe", (t) => {
  const item = fixture(t);
  const original = fs.lstatSync;
  let probeChecks = 0;
  let failure;
  fs.lstatSync = function addProbeSuccessor(...args) {
    const stat = original.apply(this, args);
    if (path.basename(String(args[0])).startsWith(".clean-development-identity-probe-")) {
      probeChecks += 1;
      if (probeChecks === 2) fs.writeFileSync(path.join(String(args[0]), "successor"), "retain");
    }
    return stat;
  };
  try {
    ensureOwnedBuildRoot(item.config, item.workspace);
  } catch (error) {
    failure = error;
  } finally {
    fs.lstatSync = original;
  }
  assert.equal(failure?.code, "CLEAN_DEVELOPMENT_STORAGE_PROBE_CLEANUP");
  assert.equal(failure.cleanup.code, "UNKNOWN");
  assert.equal(failure.cleanup.path.startsWith(`${item.config.buildRoot}${path.sep}`), true);
  assert.equal(failure.cleanup.retained, true);
  assert.equal(fs.readFileSync(path.join(failure.cleanup.path, "successor"), "utf8"), "retain");
});
