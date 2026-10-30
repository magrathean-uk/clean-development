// Explicit, bounded protection for consumers/jobs that outlive a conversation. Not a job supervisor.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { stateDir } from "./conf.mjs";
import { canonicalPath, lstatOrNull, safeDirectory, strictlyBelow, writeFileAtomic } from "./fsutil.mjs";

const UUID = /^[a-f0-9-]{36}$/;
const dirFor = (env) => path.join(stateDir(env), "leases");
const historyFor = (env) => path.join(stateDir(env), "lease-history");
const overlaps = (a, b) => a === b || strictlyBelow(a, b) || strictlyBelow(b, a);

// Resolve existing parents without requiring the final output to exist. Do not follow a candidate leaf link.
export function canonicalLocation(p) {
  if (typeof p !== "string" || !path.isAbsolute(p) || p.includes("\0")) throw new Error("an absolute path is required");
  let parent = path.dirname(path.resolve(p)), suffix = [path.basename(p)];
  while (!lstatOrNull(parent)) { suffix.unshift(path.basename(parent)); parent = path.dirname(parent); }
  const real = canonicalPath(parent);
  if (!real) throw new Error(`cannot resolve path ownership: ${p}`);
  return path.join(real, ...suffix);
}

export function readLeases(env, now = Date.now()) {
  const dir = dirFor(env), leases = [], errors = [];
  if (!lstatOrNull(dir)) return { leases, errors };
  if (!safeDirectory(stateDir(env), dir)) return { leases, errors: ["unsafe lease registry"] };
  const names = fs.readdirSync(dir);
  if (names.length > 5000) return { leases, errors: ["lease registry exceeds inspection limit"] };
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.isSymbolicLink()) throw new Error("not a regular file");
      const l = JSON.parse(fs.readFileSync(file, "utf8"));
      if (l.schemaVersion !== 1 || !UUID.test(l.id) || name !== `${l.id}.json`
        || !(Number.isFinite(l.expiresAt) || (l.status === "held" && l.expiresAt === null && UUID.test(l.publicationId)) || l.status === "released")
        || !Array.isArray(l.paths) || !l.paths.length || l.paths.length > 64 || !l.paths.every((p) => typeof p === "string" && path.isAbsolute(p) && !p.includes("\0"))) throw new Error("invalid record");
      if ((l.status === "active" && l.expiresAt > now) || l.status === "held") leases.push(l);
      else if (!["active", "released"].includes(l.status)) throw new Error("invalid state");
    } catch (e) { errors.push(`${name}: ${e.message}`); }
  }
  return { leases, errors };
}

export function protections(env, now = Date.now()) {
  const { leases, errors } = readLeases(env, now);
  return { leases, errors, protect: (p) => errors.length > 0 || leases.some((l) => l.paths.some((scope) => overlaps(scope, canonicalLocation(p)))) };
}

function ttl(minutes) {
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) throw new Error("lease minutes must be 1..1440; renew explicitly for longer jobs");
  return minutes * 60000;
}

// The CLI holds the same lifecycle lock as cleanup while creating/renewing/releasing a lease.
export function createLease(conf, env, paths, { minutes = 60, owner = "manual job", now = Date.now(), dryRun = false, publicationId = null } = {}) {
  if (!conf.valid) throw new Error("invalid storage configuration");
  if (!paths.length || paths.length > 32) throw new Error("lease needs 1..32 explicit paths");
  if (typeof owner !== "string" || owner.length > 200) throw new Error("owner must be at most 200 characters");
  if (publicationId !== null && !UUID.test(publicationId)) throw new Error("invalid publication hold identity");
  const scopes = [...new Set(paths.flatMap((p) => [canonicalLocation(p), canonicalPath(p)].filter(Boolean)))];
  const id = randomUUID();
  const record = { schemaVersion: 1, id, status: publicationId ? "held" : "active", owner, paths: scopes, createdAt: now,
    expiresAt: publicationId ? null : now + ttl(minutes), ...(publicationId ? { publicationId } : {}) };
  if (!safeDirectory(stateDir(env), dirFor(env), { missingAnchor: true })) throw new Error("unsafe lease registry");
  if (dryRun) return { ...record, status: "preview", nextStatus: record.status };
  writeFileAtomic(path.join(dirFor(env), `${id}.json`), JSON.stringify(record, null, 2) + "\n", 0o600, { durable: true });
  return record;
}

export function updateLease(env, id, { release = false, minutes = 60, now = Date.now(), dryRun = false, recoveryConfirmed = false } = {}) {
  if (!UUID.test(id || "")) throw new Error("invalid lease ID");
  if (!safeDirectory(stateDir(env), dirFor(env))) throw new Error("unsafe lease registry");
  const active = path.join(dirFor(env), `${id}.json`), archived = path.join(historyFor(env), `${id}.json`);
  const file = lstatOrNull(active) ? active : archived, st = lstatOrNull(file);
  if (!st?.isFile() || st.isSymbolicLink()) throw new Error("lease missing or unsafe");
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  if (record.id !== id || record.schemaVersion !== 1 || !Array.isArray(record.paths) || !["active", "held", "released"].includes(record.status)
    || !(Number.isFinite(record.expiresAt) || (record.status === "held" && record.expiresAt === null && UUID.test(record.publicationId)) || record.status === "released")) throw new Error("invalid lease");
  if (record.status === "held" && (!release || !recoveryConfirmed)) throw new Error("publication hold requires --recovery-confirmed release only after its bytes are durably recovered/published");
  if (!release && (record.status !== "active" || record.expiresAt <= now)) throw new Error("expired/released lease cannot be renewed; acquire a new lease before using paths");
  record.status = release ? "released" : "active";
  if (!release) record.expiresAt = now + ttl(minutes);
  record.updatedAt = now;
  if (dryRun) return { ...record, status: "preview", nextStatus: record.status };
  if (release) {
    if (!safeDirectory(stateDir(env), historyFor(env), { missingAnchor: true })) throw new Error("unsafe lease history");
    // Archive first, remove the active projection second. A crash between them conservatively
    // retains protection, and explicit release can be retried. Routine publication never fills
    // the active-registry inspection limit with already released records.
    writeFileAtomic(archived, JSON.stringify(record, null, 2) + "\n", 0o600, { durable: true });
    if (file === active) fs.unlinkSync(active);
  } else writeFileAtomic(active, JSON.stringify(record, null, 2) + "\n", 0o600, { durable: true });
  return record;
}
