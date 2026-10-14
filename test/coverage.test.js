import assert from "node:assert/strict";
import test from "node:test";
import { toolCoverage } from "../src/coverage.js";

const config = { enabled: true, cacheRoot: "/managed/cache", buildRoot: "/managed/builds", tools: { swift: false } };

test("coverage makes disabled Swift and cache-only native output explicit", () => {
  const rows = toolCoverage(config, { detected: ["swift", "npm", "unknown"] });
  assert.deepEqual(rows.map((row) => row.tool), ["swift", "npm"]);
  assert.equal(rows[0].enabled, false); assert.equal(rows[0].reason, "opt-in-required");
  assert.equal(rows[0].outputs[1].destination, "native package .build");
  assert.equal(rows[1].behavior, "cache-only"); assert.equal(rows[1].nativeOutputRemains, true);
});

test("retained Swift output and managed Cargo output have separate ownership", () => {
  const rows = toolCoverage({ ...config, tools: { swift: true }, swiftpmWorkspaceRoot: "/retained/swift" }, { detected: ["swift", "cargo"] });
  assert.equal(rows[0].enabled, true); assert.equal(rows[0].nativeOutputRemains, false);
  assert.equal(rows[0].outputs[1].destination, "/retained/swift"); assert.equal(rows[0].pruning, "none");
  assert.equal(rows[1].behavior, "managed-build"); assert.match(rows[1].pruning, /marker-verified/);
});

test("a disabled project overrides all tool opt-ins", () => {
  assert.ok(toolCoverage({ ...config, enabled: false, tools: { swift: true } }).every((row) => !row.enabled && row.reason === "project-disabled"));
});
