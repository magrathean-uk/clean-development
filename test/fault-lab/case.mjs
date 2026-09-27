import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { OWNERSHIP_MARKER } from "../../src/adapters.js";
import { resolveConfig } from "../../src/config.js";
import { runTool } from "../../src/runtime.js";
import { applyPrune, prunePlan, workspaceRecord } from "../../src/state.js";
import { identifyWorkspace } from "../../src/workspace.js";

const CLI = fileURLToPath(new URL("../../bin/clean-development.js", import.meta.url));
const ARGV = ["build", "--offline", "--", "literal argument ;,=+"];
const LIMIT = 64 * 1024;
const MARKER = ".fault-lab-owner.json";

export const SCENARIOS = [
  "healthy", "missing-managed-root", "missing-build", "missing-cache", "missing-during-marker",
  "replaced-managed-root", "enospc-marker-write", "enospc-marker-rename",
  "enospc-build-publish", "enospc-record-publish", "publication-cleanup-error",
  "prune-partial-cleanup"
];

// Deliberately do not inherit HOME, routing, Node preload or package-manager
// settings. Neither a worker nor the fake tools need a contributor's PATH.
export function isolatedEnvironment(root) {
  return {
    HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"),
    CLEAN_DEVELOPMENT_HOME: path.join(root, "home"),
    CLEAN_DEVELOPMENT_DATA_HOME: path.join(root, "data"),
    CLEAN_DEVELOPMENT_CONFIG_HOME: path.join(root, "config"),
    CLEAN_DEVELOPMENT_ROOT: path.join(root, "managed"),
    CLEAN_DEVELOPMENT_SESSION_MODE: "session-only",
    XDG_CACHE_HOME: path.join(root, "home", "cache"),
    XDG_CONFIG_HOME: path.join(root, "home", "config"),
    XDG_DATA_HOME: path.join(root, "home", "data"),
    TMPDIR: path.join(root, "tmp"), TMP: path.join(root, "tmp"), TEMP: path.join(root, "tmp"),
    PATH: path.join(root, "tools"), LAB_ROOT: root,
    LANG: "C", LC_ALL: "C"
  };
}

export function fingerprint(root) {
  const entries = [];
  let bytes = 0;
  function visit(target, relative) {
    assert.ok(entries.length < 512, "fixture inventory entry bound exceeded");
    const stat = fs.lstatSync(target);
    const entry = { path: relative, mode: stat.mode & 0o777, type: "other" };
    if (stat.isSymbolicLink()) {
      entry.type = "symlink";
      entry.target = fs.readlinkSync(target); // Never follow an inventory link.
    } else if (stat.isFile()) {
      bytes += stat.size;
      assert.ok(bytes <= 1024 * 1024, "fixture inventory byte bound exceeded");
      entry.type = "file";
      entry.sha256 = crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
    } else if (stat.isDirectory()) entry.type = "directory";
    entries.push(entry);
    if (entry.type === "directory") {
      for (const name of fs.readdirSync(target).sort()) visit(path.join(target, name), `${relative}/${name}`);
    }
  }
  visit(root, ".");
  return { sha256: crypto.createHash("sha256").update(JSON.stringify(entries)).digest("hex"), entries: entries.length, bytes };
}

export function verifyLabRoot(root) {
  assert.equal(fs.realpathSync.native(root), root, "lab root must be canonical");
  assert.ok(fs.lstatSync(root).isDirectory());
  const markerFile = path.join(root, MARKER);
  const details = fs.lstatSync(markerFile);
  assert.ok(details.isFile() && !details.isSymbolicLink() && details.size <= 4096, "invalid lab marker");
  const marker = JSON.parse(fs.readFileSync(markerFile, "utf8"));
  assert.equal(marker.owner, "clean-development-fault-lab");
  assert.equal(marker.root, root);
  return marker;
}

function identity(directory) {
  if (!fs.existsSync(directory)) return null;
  const stat = fs.lstatSync(directory, { bigint: true });
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

function serialiseError(error) {
  if (!error) return null;
  return { name: error.name, code: error.code ?? null, syscall: error.syscall ?? null,
    path: error.path ?? null, message: String(error.message).slice(0, 2048) };
}

function injectedError(code, syscall, target) {
  return Object.assign(new Error(`${code}: fault-lab injected ${syscall}: ${target}`), { code, syscall, path: target });
}

function fixture(labRoot, name) {
  verifyLabRoot(labRoot);
  assert.ok(SCENARIOS.includes(name), "unknown scenario");
  const root = path.join(labRoot, name);
  fs.mkdirSync(root); // Exclusive: never reuse a contributor-supplied tree.
  const env = isolatedEnvironment(root);
  const source = path.join(root, "source");
  for (const directory of [source, env.HOME, env.TMPDIR, env.PATH]) fs.mkdirSync(directory);
  fs.mkdirSync(path.join(source, ".git"));
  fs.mkdirSync(path.join(source, "release"));
  fs.writeFileSync(path.join(source, "Cargo.toml"), '[package]\nname="fault_lab"\nversion="0.0.0"\n');
  fs.writeFileSync(path.join(source, "package.json"), '{"name":"fault-lab","private":true}\n');
  fs.writeFileSync(path.join(source, ".clean-development.json"), '{"schemaVersion":1}\n');
  fs.writeFileSync(path.join(source, ".git", "HEAD"), "ref: refs/heads/disposable\n");
  fs.writeFileSync(path.join(source, ".env"), "SYNTHETIC_CREDENTIAL=not-a-real-secret\n", { mode: 0o600 });
  fs.writeFileSync(path.join(source, "release", "keep.bin"), Buffer.from([0, 1, 2, 255]));
  const config = resolveConfig({ cwd: source, env });
  for (const directory of [config.cacheRoot, config.buildRoot, config.scratchRoot]) fs.mkdirSync(directory, { recursive: true });
  const workspace = identifyWorkspace("cargo", ARGV, source);
  const build = path.join(config.buildRoot, workspace.id);
  const record = workspaceRecord(config, workspace.id).file;
  const fake = path.join(env.PATH, "fake.cjs");
  fs.writeFileSync(fake, `const fs = require('node:fs');\nconst path = require('node:path');
const root = process.env.LAB_ROOT;
function inside(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error('invalid fixture path');
  const relative = path.relative(root, p);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('tool write outside fixture refused');
  return p;
}
if (process.argv.includes('locate-project')) {
  process.stdout.write(JSON.stringify({root:path.join(process.cwd(),'Cargo.toml')}));
} else {
  const target = process.env.CARGO_TARGET_DIR || process.env.npm_config_cache || path.join(process.cwd(),'target');
  const capture = {target, argv:process.argv.slice(2), cwd:process.cwd(), exit:23};
  fs.writeFileSync(inside(process.env.LAB_CAPTURE), JSON.stringify(capture));
  fs.mkdirSync(inside(target), {recursive:true});
  fs.writeFileSync(inside(path.join(target,'artifact.txt')), 'disposable fake output\\n');
  process.exitCode = 23;
}\n`);
  const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
  for (const tool of ["cargo", "npm"]) {
    fs.writeFileSync(path.join(env.PATH, tool), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fake)} "$@"\n`, { mode: 0o700 });
  }
  return { root, source, env, config, workspace, build, record, before: fingerprint(source) };
}

function captureAt(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

async function firstInvocation(item, tool = "cargo", label = "first") {
  const capture = path.join(item.root, `${label}-capture.json`);
  try {
    const status = await runTool(tool, ARGV, { config: item.config, cwd: item.source, env: { ...item.env, LAB_CAPTURE: capture } });
    return { status, error: null, capture: captureAt(capture) };
  } catch (error) {
    return { status: null, error: serialiseError(error), rawError: error, capture: captureAt(capture) };
  }
}

// A genuinely new CLI process re-resolves the saved configuration with no fault
// hooks installed. It does not call setup/prepare or opt into a new destination.
function laterInvocation(item, tool = "cargo") {
  const capture = path.join(item.root, "later-capture.json");
  const result = spawnSync(process.execPath, [CLI, "shim", tool, "--", ...ARGV], {
    cwd: item.source, env: { ...item.env, LAB_CAPTURE: capture }, encoding: "utf8",
    timeout: 10_000, killSignal: "SIGKILL", maxBuffer: LIMIT
  });
  if (result.error || result.signal) throw new Error(`Later CLI incomplete: ${result.error?.code || result.signal}`);
  return { status: result.status, stderr: result.stderr.slice(0, 2048), capture: captureAt(capture) };
}

function storageEvidence(item) {
  const value = fs.existsSync(item.record) ? JSON.parse(fs.readFileSync(item.record, "utf8")) : null;
  const marker = path.join(item.build, OWNERSHIP_MARKER);
  return { managedRootIdentity: identity(item.config.root), rootIdentity: identity(item.config.buildRoot), buildExists: fs.existsSync(item.build),
    markerExists: fs.existsSync(marker), recordExists: Boolean(value), ownershipId: value?.ownershipId ?? null,
    staging: fs.existsSync(item.config.buildRoot) ? fs.readdirSync(item.config.buildRoot).filter((name) => name.startsWith(".clean-development-")).sort() : [] };
}

export async function runCase(labRoot, name) {
  const item = fixture(labRoot, name);
  const tool = name === "missing-cache" ? "npm" : "cargo";
  const checks = [];
  const check = (id, passed, expected, actual) => checks.push({ id, passed: Boolean(passed), expected, actual });
  const initialRootIdentity = identity(item.config.buildRoot);
  const initialManagedRootIdentity = identity(item.config.root);
  const rootToMove = name === "missing-cache" ? item.config.cacheRoot
    : ["missing-managed-root", "replaced-managed-root"].includes(name) ? item.config.root : item.config.buildRoot;
  const retired = path.join(item.root, "retired-root");
  let seed = null;
  if (name === "replaced-managed-root" || name === "prune-partial-cleanup") {
    seed = await firstInvocation(item, "cargo", "seed");
    assert.equal(seed.status, 23, "seed command did not complete");
    assert.ok(seed.capture, "seed tool never ran");
  }
  const seededStorage = storageEvidence(item);
  let retiredBefore = null;
  if (["missing-managed-root", "missing-build", "missing-cache", "replaced-managed-root"].includes(name)) {
    fs.renameSync(rootToMove, retired);
    retiredBefore = fingerprint(retired);
    if (name === "replaced-managed-root") {
      fs.mkdirSync(rootToMove);
      fs.mkdirSync(item.config.buildRoot);
      fs.writeFileSync(path.join(rootToMove, "foreign-sentinel"), "unowned replacement contents\n");
    }
  }
  const events = [];
  const originals = new Map();
  let primary = null;
  let secondary = null;
  let staging = null;
  function hook(method, match, action) {
    const original = fs[method];
    originals.set(method, original);
    fs[method] = function (...args) {
      if (match(...args)) {
        // Match only this lane's product write and execute the chosen boundary
        // once. Every other call uses the real filesystem implementation.
        assert.ok(events.length < 8, "fault event bound exceeded");
        events.push({ method, path: String(args[0]) });
        return action(original, args);
      }
      return Reflect.apply(original, fs, args);
    };
  }
  const stagedMarker = (file) => typeof file === "string"
    && path.dirname(path.dirname(file)) === item.config.buildRoot
    && path.basename(path.dirname(file)).startsWith(`.clean-development-${item.workspace.id}-`)
    && path.basename(file).startsWith(`${OWNERSHIP_MARKER}.tmp-`);
  const directoryPublication = (from, to) => to === item.build
    && path.dirname(from) === item.config.buildRoot && path.basename(from).startsWith(".clean-development-");
  let fired = false;
  if (name === "missing-during-marker") {
    hook("mkdirSync", (directory, options) => !fired && options?.recursive === true
      && path.dirname(directory) === item.config.buildRoot && path.basename(directory).startsWith(".clean-development-"), (original, args) => {
      fired = true;
      fs.renameSync(item.config.root, retired);
      retiredBefore = fingerprint(retired);
      return Reflect.apply(original, fs, args);
    });
  } else if (name === "enospc-marker-write") {
    hook("writeFileSync", (file) => !fired && stagedMarker(file), (original, args) => {
      fired = true;
      // A small real partial write, not a real full disk.
      Reflect.apply(original, fs, [args[0], String(args[1]).slice(0, 17), args[2]]);
      primary = injectedError("ENOSPC", "write", args[0]);
      throw primary;
    });
  } else if (name === "enospc-marker-rename") {
    hook("renameSync", (from, to) => !fired && stagedMarker(from) && path.basename(to) === OWNERSHIP_MARKER, (_original, args) => {
      fired = true;
      primary = injectedError("ENOSPC", "rename-marker", args[1]);
      throw primary;
    });
  } else if (["enospc-build-publish", "publication-cleanup-error"].includes(name)) {
    hook("renameSync", (from, to) => !fired && directoryPublication(from, to), (_original, args) => {
      fired = true;
      staging = args[0];
      primary = injectedError("ENOSPC", "rename-build", args[1]);
      throw primary;
    });
    if (name === "publication-cleanup-error") hook("rmSync", (file) => file === staging, (_original, args) => {
      secondary = injectedError("EACCES", "remove-staging", args[0]);
      throw secondary;
    });
  } else if (name === "enospc-record-publish") {
    hook("renameSync", (from, to) => !fired && to === item.record && from.startsWith(`${item.record}.tmp-`), (_original, args) => {
      fired = true;
      primary = injectedError("ENOSPC", "rename-receipt", args[1]);
      throw primary;
    });
  } else if (name === "prune-partial-cleanup") {
    const receipt = JSON.parse(fs.readFileSync(item.record, "utf8"));
    receipt.lastUsedAt = "2000-01-01T00:00:00.000Z";
    fs.writeFileSync(item.record, JSON.stringify(receipt));
    fs.mkdirSync(path.join(item.config.buildRoot, "unregistered"));
    fs.writeFileSync(path.join(item.config.buildRoot, "unregistered", "keep"), "unowned\n");
    hook("rmSync", (file) => !fired && file === item.build, (_original, args) => {
      fired = true;
      // Model partial recursive cleanup: delete exactly one disposable artifact,
      // leave the ownership marker/receipt, and report the interrupted operation.
      fs.unlinkSync(path.join(item.build, "cargo", "target", "artifact.txt"));
      primary = injectedError("EIO", "remove-build", args[0]);
      throw primary;
    });
  }
  let first;
  try {
    if (name === "prune-partial-cleanup") {
      const plan = prunePlan(item.config, { olderThanDays: 1 });
      assert.equal(plan.length, 1);
      assert.equal(plan[0].eligible, true);
      try { first = { removed: await applyPrune(item.config, plan), error: null, capture: null }; }
      catch (error) { first = { removed: null, error: serialiseError(error), rawError: error, capture: null }; }
    } else first = await firstInvocation(item, tool);
  } finally {
    for (const [method, original] of originals) fs[method] = original;
  }
  const observedError = first.rawError;
  delete first.rawError;
  const afterFirst = storageEvidence(item);
  const sourceAfterFirst = fingerprint(item.source);
  const stagingBeforeRetry = afterFirst.staging.map((name) => ({ name, ...fingerprint(path.join(item.config.buildRoot, name)) }));
  const later = laterInvocation(item, tool);
  const afterLater = storageEvidence(item);
  const sourceAfterLater = fingerprint(item.source);
  const hasFault = !["healthy", "missing-managed-root", "missing-build", "missing-cache", "replaced-managed-root"].includes(name);
  const expectedEvents = hasFault ? (name === "publication-cleanup-error" ? 2 : 1) : 0;
  check("fault-reached", events.length === expectedEvents,
    "each selected fault boundary reached exactly once", events.length);
  check("source-unchanged", item.before.sha256 === sourceAfterFirst.sha256 && item.before.sha256 === sourceAfterLater.sha256,
    "source, .git, synthetic credential and final deliverable unchanged", { before: item.before, afterFirst: sourceAfterFirst, afterLater: sourceAfterLater });
  const expectedTarget = tool === "cargo" ? path.join(item.build, "cargo", "target") : path.join(item.config.cacheRoot, "node", "npm");
  const captures = [seed?.capture, first.capture, later.capture].filter(Boolean);
  check("no-path-fallback", captures.every((capture) => capture.target === expectedTarget),
    expectedTarget, captures.map((capture) => capture.target));
  check("argv-cwd-intact", captures.every((capture) => JSON.stringify(capture.argv) === JSON.stringify(ARGV) && capture.cwd === item.source),
    { argv: ARGV, cwd: item.source }, captures.map(({ argv, cwd }) => ({ argv, cwd })));
  if (retiredBefore) check("retired-root-unchanged", retiredBefore.sha256 === fingerprint(retired).sha256,
    retiredBefore, fingerprint(retired));
  if (primary) {
    check("original-error", observedError === primary && first.error?.code === primary.code,
      serialiseError(primary), first.error);
    check("no-launch-after-error", first.capture === null, "no tool execution on failed publication/cleanup", first.capture);
  }
  if (["missing-managed-root", "missing-build", "missing-cache"].includes(name)) {
    check("missing-stays-missing", !fs.existsSync(rootToMove) && !first.capture && !later.capture,
      "both invocations reject an absent base without recreating it", { exists: fs.existsSync(rootToMove), first: first.error, later });
    const unavailableBase = tool === "npm" ? item.config.cacheRoot : item.config.buildRoot;
    check("direct-root-error", Boolean(first.error?.message.includes(unavailableBase) && later.stderr.includes(unavailableBase)),
      "both errors name the unavailable configured base", { first: first.error, later: later.stderr });
  } else if (["missing-during-marker", "replaced-managed-root"].includes(name)) {
    check("storage-identity", !first.capture && !later.capture && (name !== "missing-during-marker" || !afterFirst.rootIdentity),
      "stop before publishing/running on a disappeared or replaced base; no automatic re-approval", {
        original: initialRootIdentity, originalManaged: initialManagedRootIdentity,
        afterFirst: afterFirst.rootIdentity, afterLater: afterLater.rootIdentity,
        firstRan: Boolean(first.capture), laterRan: Boolean(later.capture),
        oldOwnershipId: seededStorage.ownershipId, newOwnershipId: afterFirst.ownershipId
      });
    if (name === "replaced-managed-root") check("foreign-sentinel", fs.readFileSync(path.join(rootToMove, "foreign-sentinel"), "utf8") === "unowned replacement contents\n",
      "pre-existing foreign file is unchanged", "checked bytes");
  } else if (name === "enospc-record-publish") {
    check("orphan-fails-closed", afterFirst.markerExists && !afterFirst.recordExists && !later.capture
      && later.stderr.includes("without a matching state receipt"),
    "retain marker-only build; next CLI rejects it rather than adopts/reroutes", { afterFirst, later });
  } else if (name === "publication-cleanup-error") {
    check("uncertain-stage-retained", Boolean(staging && fs.existsSync(staging)), "failed cleanup retains staged evidence", Boolean(staging && fs.existsSync(staging)));
  }
  if (!["missing-managed-root", "missing-build", "missing-cache", "missing-during-marker", "replaced-managed-root", "enospc-record-publish"].includes(name)) {
    check("retry-same-target", later.status === 23 && later.capture?.target === expectedTarget,
      "fresh CLI uses the same configured target and preserves child status 23", later);
  }
  if (["enospc-marker-write", "enospc-marker-rename", "enospc-build-publish", "publication-cleanup-error"].includes(name)) {
    check("no-premature-ownership", !afterFirst.buildExists && !afterFirst.recordExists,
      "failed publication exposes no final build or state receipt", afterFirst);
  }
  if (["enospc-marker-write", "enospc-marker-rename", "publication-cleanup-error"].includes(name)) {
    const unchanged = stagingBeforeRetry.length === 1 && stagingBeforeRetry.every((entry) => {
      const target = path.join(item.config.buildRoot, entry.name);
      return fs.existsSync(target) && fingerprint(target).sha256 === entry.sha256;
    });
    check("retry-retains-staging", unchanged, "retry does not modify or claim the interrupted staging directory", stagingBeforeRetry);
  }
  if (name === "enospc-build-publish") check("completed-staging-cleanup", afterFirst.staging.length === 0,
    "successful rollback removes only the unpublished stage", afterFirst.staging);
  if (name === "healthy") check("child-status", first.status === 23, 23, first.status);
  let cleanupRetry = null;
  if (name === "prune-partial-cleanup") {
    check("cleanup-evidence-retained", afterFirst.markerExists && afterFirst.recordExists,
      "partial removal leaves ownership marker and state receipt", afterFirst);
    const receipt = JSON.parse(fs.readFileSync(item.record, "utf8"));
    receipt.lastUsedAt = "2000-01-01T00:00:00.000Z";
    fs.writeFileSync(item.record, JSON.stringify(receipt));
    cleanupRetry = await applyPrune(item.config, prunePlan(item.config, { olderThanDays: 1 }));
    check("cleanup-retry", cleanupRetry.length === 1 && !fs.existsSync(item.build) && !fs.existsSync(item.record)
      && fs.readFileSync(path.join(item.config.buildRoot, "unregistered", "keep"), "utf8") === "unowned\n",
    "explicit revalidated prune removes only owned build and receipt", cleanupRetry);
    check("source-after-cleanup", fingerprint(item.source).sha256 === item.before.sha256, item.before, fingerprint(item.source));
  }
  // Inventory bounds also detect accidental excessive fixture generation.
  const inventory = fingerprint(item.root);
  return { scenario: name, checks, events, initialRootIdentity, initialManagedRootIdentity, first, later, afterFirst, afterLater,
    primary: serialiseError(primary), secondary: serialiseError(secondary), cleanupRetry, inventory };
}
