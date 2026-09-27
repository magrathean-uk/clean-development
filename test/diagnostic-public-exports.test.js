import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as formatters from "../src/diagnostic-formatters.js";
import { formatExplanation } from "../src/explain.js";
import { formatStorageStatus } from "../src/status.js";
import { formatProbe } from "../src/probe.js";
import { isolatedEnvironment } from "../scripts/harness-utils.mjs";

const cli = fileURLToPath(new URL("../bin/clean-development.js", import.meta.url));

test("existing public modules expose the shared pure formatter implementations", () => {
  assert.equal(formatExplanation, formatters.formatExplanation);
  assert.equal(formatStorageStatus, formatters.formatStorageStatus);
  assert.equal(formatProbe, formatters.formatProbe);
});

test("public status CLI escapes direction/line controls but JSON retains exact paths", (t) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cd-render-contract-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = isolatedEnvironment(root);
  env.CLEAN_DEVELOPMENT_ROOT = path.join(root, "managed\u061c\u200e\u200f\u2028\u2029data");
  const before = fs.readdirSync(root).sort();
  const run = (args) => {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout;
  };
  const text = run(["status", "--workspaces"]);
  assert.doesNotMatch(text, /[\u061c\u200e\u200f\u2028\u2029]/u);
  assert.ok(text.includes("\\u2028"));
  const json = JSON.parse(run(["status", "--workspaces", "--json"]));
  assert.equal(json.root, env.CLEAN_DEVELOPMENT_ROOT);
  assert.deepEqual(fs.readdirSync(root).sort(), before);
  assert.equal(fs.existsSync(env.CLEAN_DEVELOPMENT_ROOT), false);
});
