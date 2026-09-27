import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { explainCommand, formatExplanation } from "../src/explain.js";
import { isolatedEnvironment } from "../scripts/harness-utils.mjs";

const warning = "Native cache inspection covers only leading recognised options";
function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cd-cache-warnings-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "project"); fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, "package.json"), '{"private":true}\n');
  return { root, cwd, env: isolatedEnvironment(root) };
}

for (const tool of ["npm", "uv"]) {
  test(`${tool}: empty cache inspection retains JSON evidence without a human warning`, (t) => {
    const item = fixture(t);
    for (const args of [[], ["install"], ["run", "script", "--cache=PRIVATE"], ["--unknown", "PRIVATE"], ["--", "--cache=PRIVATE"]]) {
      const before = fs.readdirSync(item.root, { recursive: true }).sort();
      const report = explainCommand(tool, args, item);
      assert.deepEqual(report.routing.nativeCacheOptions.declarations, []);
      assert.equal(report.routing.nativeCacheOptions.observed, false);
      assert.equal(report.limitations.some((line) => line.startsWith(warning)), false);
      assert.equal(formatExplanation(report).includes(warning), false);
      assert.doesNotMatch(JSON.stringify(report), /PRIVATE/);
      assert.deepEqual(fs.readdirSync(item.root, { recursive: true }).sort(), before);
    }
  });
  test(`${tool}: recognised valid and malformed cache options keep the scope warning`, (t) => {
    const item = fixture(t), option = tool === "npm" ? "--cache" : "--cache-dir";
    for (const args of [[option, "relative-cache"], [option], [`${option}=`]]) {
      const report = explainCommand(tool, args, item);
      assert.equal(report.routing.nativeCacheOptions.declarations.length, 1);
      assert.equal(report.limitations.filter((line) => line.startsWith(warning)).length, 1);
      assert.equal(formatExplanation(report).includes(warning), true);
    }
  });
}

test("uv temporary-cache aliases keep their native-cache scope warning", (t) => {
  const item = fixture(t);
  for (const option of ["--no-cache", "--no-cache-dir", "-n"]) {
    const report = explainCommand("uv", [option, "cache", "dir"], item);
    assert.equal(report.routing.nativeCacheOptions.declarations[0].effect, "temporary-cache");
    assert.equal(report.limitations.filter((line) => line.startsWith(warning)).length, 1);
  }
});

test("skip does not inspect native options or emit the scope warning", (t) => {
  const report = explainCommand("npm", ["--cache=PRIVATE"], { ...fixture(t), mode: "skip" });
  assert.equal(report.routing.nativeCacheOptions, undefined);
  assert.equal(report.limitations.some((line) => line.startsWith(warning)), false);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE/);
});
