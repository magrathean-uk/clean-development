import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { resolveConfig } from "./config.js";
import { VERSION } from "./constants.js";
import { integrationStatus } from "./integrations.js";
import { launcherSpecifications, packageRoot, validateRuntimeReceipt } from "./runtime.js";
import { acquireRecoveryLocks, digest, directoryIdentity, equal, fingerprint, observeFile, publishRepair, requireDirectory } from "./recovery-io.js";

const MARKER = ".clean-development-runtime.json";
const WITNESS = "recovery.json";
const MAX_RECORDS = 512;
const ROOT_KEYS = ["root", "cacheRoot", "buildRoot", "scratchRoot"];
const LOCATION_KEYS = ["dataDir", "stateDir", "runtimeDir", "binDir", "configPath"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function context(config) {
  return { managed: Object.fromEntries(ROOT_KEYS.map((key) => [key, config[key]])),
    locations: Object.fromEntries(LOCATION_KEYS.map((key) => [key, config.locations[key]])) };
}

function receiptAt(config, bytes, label) {
  const value = JSON.parse(bytes.toString("utf8"));
  validateRuntimeReceipt(config, value, label, { verifyPackage: false });
  if (value.runtimeFiles.length + value.ownedFiles.length > MAX_RECORDS) throw new Error(`Recovery inventory exceeds ${MAX_RECORDS} records: ${label}`);
  // Only packaged runtime payloads and the ownership marker may be repaired.
  for (const entry of value.runtimeFiles) {
    const relative = path.relative(value.versionRoot, entry.path);
    if (entry.path !== path.resolve(entry.path) || !(relative === MARKER || relative === "package.json"
      || relative.startsWith(`src${path.sep}`) || relative.startsWith(`bin${path.sep}`))) {
      throw new Error(`Recovery receipt has an unsupported runtime path: ${entry.path}`);
    }
  }
  return value;
}

// The installer refreshes installedAt/source even when ownership is unchanged.
// Those descriptive fields cannot invalidate an otherwise exact inventory.
function sameReceiptOwnership(left, right) {
  return ["schemaVersion", "version", "status", "installationId", "node", "versionRoot", "binDir",
    "binDirectoryCreated", "ownedFiles", "runtimeFiles"].every((key) => equal(left[key], right[key]));
}

function markerMatches(receipt, bytes) {
  const entry = receipt.runtimeFiles.find((record) => record.path === path.join(receipt.versionRoot, MARKER));
  if (!entry || digest(bytes) !== entry.sha256) return false;
  const marker = JSON.parse(bytes.toString("utf8"));
  return marker.schemaVersion === 1 && marker.owner === "clean-development"
    && marker.version === receipt.version && marker.installationId === receipt.installationId;
}

function snapshot(config) {
  const file = path.join(config.locations.stateDir, "runtime.json");
  const observation = observeFile(file);
  if (observation.state === "absent") return null;
  const receipt = receiptAt(config, observation.bytes, file);
  const result = { receipt: observation.bytes.toString("utf8"), sha256: observation.sha256,
    marker: null, rootIdentity: null, launchers: [] };
  try {
    const marker = observeFile(path.join(receipt.versionRoot, MARKER));
    if (marker.state === "file" && markerMatches(receipt, marker.bytes)) {
      result.marker = marker.bytes.toString("utf8");
      result.rootIdentity = directoryIdentity(receipt.versionRoot);
    }
  } catch { /* A missing/modified marker never becomes recovery authority. */ }
  for (const entry of receipt.ownedFiles) {
    try {
      const file = observeFile(entry.path, 64 * 1024);
      if (file.sha256 === entry.sha256 && digest(file.bytes.toString("utf8")) === entry.sha256) {
        result.launchers.push({ path: entry.path, sha256: entry.sha256, contents: file.bytes.toString("utf8") });
      }
    } catch { /* Preserve the receipt, but not unsupported or modified bytes. */ }
  }
  return result;
}

function validIdentity(value) {
  return value && typeof value.dev === "string" && /^\d+$/.test(value.dev)
    && typeof value.ino === "string" && /^\d+$/.test(value.ino);
}

function validateSnapshot(config, value) {
  if (value === null) return null;
  if (!value || typeof value.receipt !== "string" || digest(value.receipt) !== value.sha256
    || !Array.isArray(value.launchers) || value.launchers.length > MAX_RECORDS) throw new Error("Invalid recovery receipt snapshot");
  const receipt = receiptAt(config, Buffer.from(value.receipt), "recovery snapshot");
  if (value.marker !== null && (typeof value.marker !== "string" || !validIdentity(value.rootIdentity)
    || !markerMatches(receipt, Buffer.from(value.marker)))) throw new Error("Recovery snapshot marker does not match its receipt");
  const owned = new Map(receipt.ownedFiles.map((entry) => [entry.path, entry.sha256]));
  const seen = new Set();
  for (const entry of value.launchers) {
    if (!entry || typeof entry.contents !== "string" || digest(entry.contents) !== entry.sha256
      || owned.get(entry.path) !== entry.sha256 || seen.has(entry.path)) throw new Error("Invalid recovery launcher snapshot");
    seen.add(entry.path);
  }
  return receipt;
}

function anchors(config) {
  return Object.fromEntries([...new Set([...ROOT_KEYS.map((key) => config[key]), config.locations.dataDir, config.locations.stateDir])]
    .map((directory) => [directory, directoryIdentity(directory)]));
}

function validateWitness(config, value) {
  if (!value || value.schemaVersion !== 1 || value.owner !== "clean-development-recovery"
    || !UUID.test(value.transactionId) || !["setup", "update", "uninstall"].includes(value.operation)
    || !["started", "runtime-published", "complete"].includes(value.phase)
    || typeof value.startedAt !== "string" || !Number.isFinite(Date.parse(value.startedAt))
    || !equal(value.context, context(config))) throw new Error("Recovery witness is invalid or belongs to different configuration/data locations");
  const expectedAnchors = Object.keys(anchors(config)).sort();
  if (!value.anchors || !equal(Object.keys(value.anchors).sort(), expectedAnchors)
    || Object.values(value.anchors).some((item) => item !== null && !validIdentity(item))) throw new Error("Invalid recovery directory identities");
  validateSnapshot(config, value.before);
  validateSnapshot(config, value.after);
  const intent = value.intent;
  if (!intent || typeof intent.version !== "string" || !SEMVER.test(intent.version)
    || typeof intent.node !== "string" || !path.isAbsolute(intent.node) || !HASH.test(intent.packageSha256)
    || !Array.isArray(intent.launchers)) throw new Error("Invalid recovery install intent");
  const expected = launcherSpecifications(path.join(config.locations.runtimeDir, intent.version), config.locations.binDir, intent.node)
    .specifications.map(({ path: file, sha256 }) => ({ path: file, sha256 }));
  if (!equal(intent.launchers, expected)) throw new Error("Recovery install intent does not match the generated launcher contract");
  return value;
}

function readWitness(config, allowManagedChange = false) {
  const file = path.join(config.locations.stateDir, WITNESS);
  const observation = observeFile(file);
  let value = null;
  if (observation.state === "file") {
    value = JSON.parse(observation.bytes.toString("utf8"));
    const validationConfig = allowManagedChange && value?.context?.managed
      ? { ...config, ...value.context.managed } : config;
    validateWitness(validationConfig, value);
  }
  return { file, observation, value };
}

function saveWitness(config, value, previous) {
  validateWitness(config, value);
  const file = path.join(config.locations.stateDir, WITNESS);
  publishRepair(file, `${JSON.stringify(value, null, 2)}\n`, {
    before: fingerprint(previous), parent: requireDirectory(config.locations.stateDir), mode: 0o600
  });
  return observeFile(file);
}

// Called only by explicit setup/update/uninstall while their setup lock is held.
// This is an ownership witness, not a command log, repair trigger or deletion log.
export function beginLifecycleRecovery(config, operation) {
  const prior = readWitness(config, true);
  if (prior.value && prior.value.phase !== "complete") {
    if (prior.value.operation === operation && equal(prior.value.context, context(config))) {
      for (const [directory, expected] of Object.entries(prior.value.anchors)) if (expected) requireDirectory(directory, expected);
      return { value: prior.value, observation: prior.observation };
    }
    // A different explicit lifecycle is fresh consent, not an implicit retry.
    // Keep the interrupted witness rather than discarding its ownership evidence.
    const archive = path.join(config.locations.stateDir, `recovery-${prior.value.transactionId}.json`);
    const existing = observeFile(archive);
    if (existing.state === "absent") publishRepair(archive, prior.observation.bytes, {
      before: fingerprint(existing), parent: requireDirectory(config.locations.stateDir)
    });
    else if (existing.sha256 !== prior.observation.sha256) throw new Error(`Recovery witness archive is modified: ${archive}`);
  }
  const intent = { version: VERSION, node: process.execPath,
    packageSha256: observeFile(path.join(packageRoot(), "package.json")).sha256,
    launchers: launcherSpecifications(path.join(config.locations.runtimeDir, VERSION), config.locations.binDir)
      .specifications.map(({ path: file, sha256 }) => ({ path: file, sha256 })) };
  const value = { schemaVersion: 1, owner: "clean-development-recovery", transactionId: crypto.randomUUID(),
    operation, phase: "started", startedAt: new Date().toISOString(), context: context(config),
    anchors: anchors(config), before: snapshot(config), after: null, intent };
  return { value, observation: saveWitness(config, value, prior.observation) };
}

export function checkpointLifecycleRecovery(config, transaction, phase) {
  const next = { ...transaction.value, phase, after: snapshot(config) };
  for (const [directory, expected] of Object.entries(next.anchors)) if (expected) requireDirectory(directory, expected);
  transaction.observation = saveWitness(config, next, transaction.observation);
  transaction.value = next;
}

function inspect(config, env) {
  const observed = new Map();
  const payloads = new Map();
  const plan = { schemaVersion: 1, command: "recover", dryRun: true, context: context(config),
    operation: null, phase: null, blocked: false, actions: [], retained: [], anchors: {}, planId: null };
  const retain = (file, reason, next, blocking = false) => {
    plan.retained.push({ path: file, reason, next });
    if (blocking) plan.blocked = true;
  };
  const observe = (file) => {
    const value = observeFile(file);
    observed.set(file, fingerprint(value));
    return value;
  };
  const directory = (file) => {
    const value = directoryIdentity(file);
    observed.set(`${file}${path.sep}`, value);
    return value;
  };
  const finish = () => {
    plan.actions.sort((a, b) => a.order - b.order || a.path.localeCompare(b.path));
    const evidence = [...observed].sort(([a], [b]) => a.localeCompare(b));
    plan.planId = digest(JSON.stringify({ ...plan, planId: null, evidence }));
    return { plan, payloads };
  };
  const add = (file, bytes, before, kind, reason, order, authority, mode = 0o600, stagingDirectory = path.dirname(file)) => {
    const parent = directory(path.dirname(file));
    const stagingParent = directory(stagingDirectory);
    if (!parent || !stagingParent) {
      retain(file, "The parent directory is missing; recovery will not recreate a possible mount point.", "Restore the original directory/volume, verify ownership, then re-plan.");
      return;
    }
    const sha256 = digest(bytes);
    const action = { id: digest(JSON.stringify([kind, file, sha256])), kind, path: file,
      sha256, before: fingerprint(before), parent, stagingDirectory, stagingParent, authority, mode, reason, order };
    plan.actions.push(action);
    payloads.set(action.id, Buffer.from(bytes));
  };

  // Include user config bytes as a precondition; never use project config here.
  try { observe(config.locations.configPath); }
  catch (error) { retain(config.locations.configPath, error.message, "Restore the selected user configuration; no lower-precedence destination is selected.", true); }
  for (const file of [...new Set([...ROOT_KEYS.map((key) => config[key]), config.locations.dataDir, config.locations.stateDir])]) {
    try {
      const current = directory(file);
      plan.anchors[file] = current;
      if (!current) retain(file, "Required directory/volume is missing.", `Mount or restore exactly ${file}; recovery never creates an alternate destination.`, true);
    } catch (error) { retain(file, error.message, "Restore a canonical, real directory at the configured location, then re-plan.", true); }
  }
  if (plan.blocked) return finish();

  let witness = null;
  try {
    const file = path.join(config.locations.stateDir, WITNESS);
    const value = observe(file);
    if (value.state === "file") witness = validateWitness(config, JSON.parse(value.bytes.toString("utf8")));
    if (witness) {
      plan.operation = witness.operation;
      plan.phase = witness.phase;
      for (const [file, expected] of Object.entries(witness.anchors)) {
        if (expected && !equal(directory(file), expected)) retain(file, "Directory identity differs from the lifecycle witness.", "Restore the original directory/volume; do not copy the receipt to legitimise the replacement.", true);
      }
    }
  } catch (error) { retain(path.join(config.locations.stateDir, WITNESS), error.message, "Preserve this witness and restore a verified backup or inspect it manually; recovery does not overwrite damaged metadata.", true); }

  const receiptFile = path.join(config.locations.stateDir, "runtime.json");
  let live;
  let receipt;
  let authority;
  let backup;
  try {
    live = observe(receiptFile);
    if (live.state === "file") {
      receipt = receiptAt(config, live.bytes, receiptFile);
      authority = live.sha256;
      backup = [witness?.after, witness?.before].find((item) => item && (() => {
        const saved = receiptAt(config, Buffer.from(item.receipt), "recovery snapshot");
        return saved.versionRoot === receipt.versionRoot && saved.installationId === receipt.installationId;
      })());
      if (backup && receipt.status === "installed" && !sameReceiptOwnership(receipt, receiptAt(config, Buffer.from(backup.receipt), "recovery snapshot"))) {
        throw new Error("Runtime receipt differs from its independent lifecycle snapshot");
      }
    } else {
      backup = witness?.after || witness?.before;
      if (backup) { receipt = receiptAt(config, Buffer.from(backup.receipt), "recovery snapshot"); authority = backup.sha256; }
      else retain(receiptFile, "No runtime receipt and no independent lifecycle snapshot.", "Do not adopt files by directory name. Preserve partial copies; use explicit setup only after inspecting unrelated files.");
    }
  } catch (error) {
    retain(receiptFile, error.message, "Keep the damaged/mismatched receipt unchanged. Compare it with a verified backup and restore it manually before re-planning.", true);
  }

  // Diagnose integration metadata with its existing, strict path/owner validator.
  // Recovery never edits agent settings or invents their lost ownership tokens.
  try {
    const integrationFile = path.join(config.locations.stateDir, "integrations.json");
    const entry = observe(integrationFile);
    if (entry.state === "file") integrationStatus(config, env, { enforcePaths: true });
    if (witness?.phase !== "complete" && witness) retain(integrationFile,
      `The explicit ${witness.operation} did not finish all lifecycle checkpoints.`,
      `After reviewing recovery, rerun clean-development ${witness.operation} with the original agent/config-home choices. No native settings are edited by recover.`);
  } catch (error) { retain(path.join(config.locations.stateDir, "integrations.json"), error.message,
    "Preserve agent configuration and the receipt. Restore a verified receipt backup or resolve the named config-home/ownership mismatch manually."); }

  // Bounded top-level reporting only: names never grant ownership or deletion.
  try {
    if (directory(config.locations.runtimeDir)) {
      const dir = fs.opendirSync(config.locations.runtimeDir);
      try {
        let count = 0;
        let entry;
        while ((entry = dir.readSync()) !== null) {
          if (++count > 128) throw new Error("Recovery runtime listing exceeded 128 entries");
          const file = path.join(config.locations.runtimeDir, entry.name);
          if (file !== receipt?.versionRoot) retain(file, "Inactive or unreceipted runtime entry; not adopted or removed.", "Keep it for inspection. An explicit uninstall can evaluate its own archived receipts; a familiar name is not ownership evidence.");
        }
      } finally { dir.closeSync(); }
    }
  } catch (error) { retain(config.locations.runtimeDir, error.message, "Inspect the directory without following substituted links.", true); }
  if (!receipt || plan.blocked) return finish();

  const interruptedUninstall = witness?.operation === "uninstall" && witness.phase !== "complete";
  if (receipt.status === "uninstalled" || interruptedUninstall) {
    if (interruptedUninstall && live.state === "file" && receipt.status !== "uninstalled"
      && (!witness.before || !sameReceiptOwnership(receipt, receiptAt(config, Buffer.from(witness.before.receipt), "uninstall snapshot")))) {
      retain(receiptFile, "The active receipt changed since uninstall started.", "Review the competing installation; no uninstall state will be inferred.", true);
      return finish();
    }
    const tombstone = receipt.status === "uninstalled" ? (live.state === "file" ? live.bytes : Buffer.from(backup.receipt))
      : Buffer.from(`${JSON.stringify({ ...receipt, status: "uninstalled", removedAt: witness.startedAt,
        recovery: { transactionId: witness.transactionId, disposition: "interrupted-uninstall-retained" } }, null, 2)}\n`);
    if (live.state === "absent" || receipt.status !== "uninstalled") add(receiptFile, tombstone, live, "restore-tombstone",
      "Preserve explicit uninstall intent without deleting files or enabling automatic activation.", 40, authority);
    retain(receipt.versionRoot, "Uninstall intent/tombstone prohibits reinstalling runtime files and launchers.",
      "Rerun explicit uninstall to evaluate remaining owned files. Recovery itself performs no artifact deletion.");
    return finish();
  }

  let rootIdentity;
  try { rootIdentity = directory(receipt.versionRoot); }
  catch (error) {
    retain(receipt.versionRoot, error.message, "Restore the original canonical version directory; recovery never follows directory aliases.", true);
    return finish();
  }
  if (!rootIdentity) {
    retain(receipt.versionRoot, "Receipted runtime directory is missing.", "Restore the original volume/directory. Recovery will not create a new version root or switch destinations.", true);
    return finish();
  }
  if (backup?.rootIdentity && !equal(rootIdentity, backup.rootIdentity)) {
    retain(receipt.versionRoot, "Runtime directory was replaced since the independent snapshot.", "Restore the original directory, then re-plan; copied marker bytes do not prove physical identity.", true);
    return finish();
  }
  const markerFile = path.join(receipt.versionRoot, MARKER);
  let marker;
  try {
    marker = observe(markerFile);
    if (marker.state === "absent") {
      if (!backup?.marker || !backup.rootIdentity || !equal(rootIdentity, backup.rootIdentity)) throw new Error("Missing marker has no independently corroborated exact backup");
      add(markerFile, backup.marker, marker, "restore-marker", "Restore exact marker bytes from the independent snapshot in the same physical runtime directory.", 0, authority);
    } else if (!markerMatches(receipt, marker.bytes)) throw new Error("Runtime marker and receipt do not match");
  } catch (error) {
    retain(markerFile, error.message, "Do not edit/replace the mismatched marker. Restore verified original evidence or inspect manually.", true);
    return finish();
  }

  let payloadReady = true;
  for (const record of receipt.runtimeFiles) {
    if (record.path === markerFile) continue;
    try {
      const current = observe(record.path);
      if (current.state === "file") {
        if (current.sha256 !== record.sha256) {
          payloadReady = false;
          retain(record.path, "Runtime file differs from its receipted SHA-256; left unchanged.", "Preserve local changes and compare against the exact installed package before manual restoration.");
        }
        continue;
      }
      const source = path.join(packageRoot(), path.relative(receipt.versionRoot, record.path));
      const replacement = observe(source);
      if (replacement.sha256 !== record.sha256) throw new Error("The running package cannot supply these exact receipted bytes");
      const previousCount = plan.actions.length;
      add(record.path, replacement.bytes, current, "restore-runtime-file", "Create an absent file only; its hash must match the receipt and the trusted running package.", 10, authority, replacement.mode, receipt.versionRoot);
      if (previousCount === plan.actions.length) payloadReady = false;
    } catch (error) {
      payloadReady = false;
      retain(record.path, error.message, "Use the exact package matching this receipt, or restore the original parent directory. No download, source execution or overwrite is attempted.");
    }
  }

  const expected = new Map(launcherSpecifications(receipt.versionRoot, config.locations.binDir, receipt.node).specifications.map((entry) => [entry.path, entry]));
  const saved = new Map((backup?.launchers || []).map((entry) => [entry.path, entry]));
  const desired = new Map((witness?.intent.launchers || []).map((entry) => [entry.path, entry.sha256]));
  const canRollback = witness && ["setup", "update"].includes(witness.operation) && witness.phase === "started"
    && witness.before && sameReceiptOwnership(receipt, receiptAt(config, Buffer.from(witness.before.receipt), "update snapshot")) && witness.before.marker
    && equal(witness.before.rootIdentity, rootIdentity);
  for (const record of receipt.ownedFiles) {
    try {
      const current = observe(record.path);
      if (current.state === "file" && current.sha256 === record.sha256) {
        if (process.platform !== "win32" && !(current.mode & 0o111)) retain(record.path,
          "Receipted launcher bytes match, but executable permissions were changed.", "Review the permissions manually; recovery does not silently chmod a modified existing file.");
        continue;
      }
      if (!payloadReady) throw new Error("Runtime payload has unresolved modifications or unavailable files; launchers are not republished");
      const content = saved.get(record.path) || expected.get(record.path);
      if (!content || content.sha256 !== record.sha256) throw new Error("Exact receipted launcher bytes are unavailable");
      const knownIntermediate = current.state === "file" && canRollback && saved.has(record.path)
        && current.sha256 === desired.get(record.path);
      if (current.state !== "absent" && !knownIntermediate) throw new Error("Launcher is modified or has no proof of being an interrupted publication");
      add(record.path, content.contents, current, knownIntermediate ? "restore-stale-launcher" : "restore-launcher",
        knownIntermediate ? "Roll back an exact journal-authorised intermediate launcher to its still-active receipt; no arbitrary script overwrite."
          : "Recreate an absent, receipted launcher without changing its Node path or arguments.", 20, authority, 0o755);
    } catch (error) { retain(record.path, error.message, "Preserve this file. Review it against the active receipt and lifecycle snapshot; after safe rollback, rerun the original explicit setup/update."); }
  }
  if (live.state === "absent") {
    if (payloadReady) add(receiptFile, backup.receipt, live, "restore-receipt", "Restore an absent receipt from an independent exact snapshot after corroborating the marker and physical runtime identity.", 30, authority);
    else retain(receiptFile, "Missing receipt is retained until unresolved runtime content is inspected.", "Resolve the named runtime-file issues before restoring the saved receipt.");
  }
  return finish();
}

export function planRecovery({ env = process.env } = {}) {
  return inspect(resolveConfig({ env, includeProject: false }), env).plan;
}

export async function applyRecovery({ env = process.env, apply = false, planId, lockTimeoutMs = 30_000 } = {}) {
  if (apply !== true) throw new Error("Recovery requires explicit apply: true (CLI: recover --apply --plan-id HASH)");
  if (typeof planId !== "string" || !HASH.test(planId)) throw new Error("Recovery requires the plan ID from a read-only recover invocation");
  let config = resolveConfig({ env, includeProject: false });
  const first = inspect(config, env).plan;
  if (first.planId !== planId) throw new Error("Recovery plan changed; run clean-development recover again and review the new plan ID");
  if (first.blocked) return { apply: true, planId, blocked: true, applied: [], retained: first.retained, retainedLocks: [] };
  if (!first.actions.length) return { apply: true, planId, blocked: false, applied: [], retained: first.retained, retainedLocks: [] };
  const locks = await acquireRecoveryLocks(config.locations.stateDir, { timeoutMs: lockTimeoutMs });
  const applied = [];
  let result;
  try {
    locks.assertHeld();
    config = resolveConfig({ env, includeProject: false });
    const locked = inspect(config, env).plan;
    if (locked.planId !== planId) throw new Error("Recovery plan changed while waiting for setup/runtime locks; re-plan before applying");
    for (const candidate of first.actions) {
      locks.assertHeld();
      const current = inspect(resolveConfig({ env, includeProject: false }), env);
      const verified = current.plan.actions.find((entry) => entry.id === candidate.id);
      if (current.plan.blocked || !verified || !equal(verified, candidate)) throw new Error(`Recovery candidate changed under lock: ${candidate.path}; re-plan. Earlier completed repairs remain recorded.`);
      applied.push({ kind: candidate.kind, ...publishRepair(candidate.path, current.payloads.get(candidate.id), {
        before: candidate.before, parent: candidate.parent, mode: candidate.mode, assertHeld: () => locks.assertHeld(),
        stagingDirectory: candidate.stagingDirectory, stagingParent: candidate.stagingParent
      }) });
    }
    const after = inspect(resolveConfig({ env, includeProject: false }), env).plan;
    result = { apply: true, planId, blocked: after.blocked, applied, retained: after.retained, retainedLocks: locks.retained };
  } catch (error) {
    error.recovery = { ...error.recovery, applied, retainedLocks: locks.retained };
    throw error;
  } finally { locks.release(); }
  return result;
}

export function formatRecovery(report) {
  if (report.apply) return JSON.stringify(report, null, 2);
  const lines = ["Clean Development recovery plan (read-only)", `Plan ID: ${report.planId}`,
    `Repairs: ${report.actions.length}; retained findings: ${report.retained.length}; blocked: ${report.blocked}`];
  const safe = (value) => JSON.stringify(String(value)).slice(1, -1).replace(/[\u007f-\u009f\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
  for (const action of report.actions) lines.push(`${action.kind}: ${JSON.stringify(action.path)}\n  ${safe(action.reason)}\n  Expected SHA-256: ${action.sha256}`);
  for (const item of report.retained) lines.push(`retain: ${JSON.stringify(item.path)}\n  ${safe(item.reason)}\n  Next: ${safe(item.next)}`);
  if (report.actions.length && !report.blocked) lines.push(`Apply only this reviewed state: clean-development recover --apply --plan-id ${report.planId}`);
  return lines.join("\n");
}
