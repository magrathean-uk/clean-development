import assert from "node:assert/strict";
import test from "node:test";
import { normalizeNpmPackReport } from "../scripts/npm-pack-report.mjs";

const report = { name: "clean-development", version: "0.0.0", filename: "clean-development-0.0.0.tgz", entryCount: 1, files: [{ path: "package.json" }] };

test("accepts npm 12's package-keyed pack report", () => {
  assert.deepEqual(normalizeNpmPackReport({ "clean-development": report }, "clean-development"), report);
});

test("accepts the one-element array printed by earlier npm releases", () => {
  assert.deepEqual(normalizeNpmPackReport([report], "clean-development"), report);
});

test("rejects reports that are ambiguous, for another package, or malformed", () => {
  assert.throws(() => normalizeNpmPackReport([report, report], "clean-development"), /exactly one report/);
  assert.throws(() => normalizeNpmPackReport([], "clean-development"), /exactly one report/);
  assert.throws(() => normalizeNpmPackReport({ other: report }, "clean-development"), /shape is invalid/);
  assert.throws(() => normalizeNpmPackReport({ "clean-development": report, other: report }, "clean-development"), /shape is invalid/);
  assert.throws(() => normalizeNpmPackReport(null, "clean-development"), /shape is invalid/);
  assert.throws(() => normalizeNpmPackReport("report", "clean-development"), /shape is invalid/);
  assert.throws(() => normalizeNpmPackReport({ "clean-development": { ...report, name: "other" } }, "clean-development"), /identity is invalid/);
  assert.throws(() => normalizeNpmPackReport([null], "clean-development"), /identity is invalid/);
  assert.throws(() => normalizeNpmPackReport({ "clean-development": [report] }, "clean-development"), /identity is invalid/);
});
