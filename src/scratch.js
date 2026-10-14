import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { canonicalizePotentialPath } from "./platform.js";
import { repositoryManagedPaths } from "./routing-context.js";
import { writeJsonExclusive } from "./io.js";

function identity(directory) {
  const stat = fs.lstatSync(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || canonicalizePotentialPath(directory) !== directory) {
    throw new Error(`Scratch root is not a canonical real directory: ${directory}`);
  }
  fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

function same(left, right) { return left.dev === right.dev && left.ino === right.ino; }

/** Plan an explicit scratch allocation. No command, runtime, or config writes. */
export function planScratch({ config, cwd = process.cwd(), prefix = "verification" } = {}) {
  if (!config) throw new Error("scratch requires resolved configuration");
  if (typeof prefix !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(prefix)) {
    throw new Error("Invalid scratch prefix; use 1 to 64 letters, numbers, dots, underscores or hyphens, starting with a letter or number");
  }
  const root = path.resolve(config.scratchRoot);
  const result = { schemaVersion: 1, kind: "scratch-allocation", root, prefix,
    status: "available", reason: null, ownership: "no pruning authority; preserve evidence and deliverables" };
  if (config.enabled === false) return { ...result, status: "blocked", reason: "Project routing is disabled" };
  if (repositoryManagedPaths(cwd, config).length) {
    return { ...result, status: "blocked", reason: "Managed scratch must be outside the project" };
  }
  try { result.rootIdentity = identity(root); }
  catch (error) { result.status = "unavailable"; result.reason = `Selected scratch is unavailable: ${error.code || error.message}`; }
  return result;
}

/** Allocate beneath an existing selected root. Never recreate a missing base. */
export function createScratch(options = {}) {
  const plan = planScratch(options);
  if (plan.status !== "available") throw new Error(plan.reason);
  const directory = path.join(plan.root, `${plan.prefix}-${crypto.randomUUID()}`);
  fs.mkdirSync(directory, { mode: 0o700 });
  if (!same(plan.rootIdentity, identity(plan.root))) {
    throw new Error("Selected scratch root changed during allocation; retained uncertain output, no retry or fallback attempted");
  }
  const createdIdentity = identity(directory);
  const createdAt = new Date().toISOString();
  writeJsonExclusive(path.join(directory, ".clean-development-scratch.json"), {
    schemaVersion: 1, purpose: "explicit scratch allocation", createdAt,
    root: plan.root, rootIdentity: plan.rootIdentity, identity: createdIdentity
  }, { expectedParent: createdIdentity });
  if (!same(plan.rootIdentity, identity(plan.root)) || !same(createdIdentity, identity(directory))) {
    throw new Error("Selected scratch changed during marker publication; retained uncertain output");
  }
  return { ...plan, status: "created", path: directory, createdAt };
}
