import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { Lab, assertInside, assertOutput, assertUnchanged, executable, inventory, write } from "./cache-correctness/harness.mjs";
import { runToolLab } from "./cache-correctness/run.mjs";

for (const [tool, requirements] of Object.entries({ cargo: ["cargo", "rustc", "git"], go: ["go", "git", "python3"], npm: ["npm", "git"], uv: ["uv", "git", "python3"] })) {
  test(`REAL CACHE CORRECTNESS: ${tool}`, { timeout: 600000 }, async (t) => {
    if (process.platform === "win32") return t.skip("POSIX process-group interruption fixture; native Windows is not certified");
    const missing = requirements.filter((name) => !executable(name));
    if (missing.length) return t.skip(`real tool unavailable: ${missing.join(", ")}; not a cache correctness pass`);
    const report = await runToolLab(tool);
    t.diagnostic(JSON.stringify({ tool, status: report.status, versions: report.versions, scenarios: report.scenarios,
      assertions: report.assertions.length, commands: report.commands.length, error: report.error, evidenceRoot: report.evidenceRoot }));
    assert.equal(report.status, "passed", `${report.error?.message || report.status}; retained evidence: ${report.evidenceRoot}`);
  });
}

test("content oracle rejects stale, cross-project, empty and extra output even after exit zero", () => {
  const expected = "A|source02|flag1|dep2\n";
  for (const bad of ["A|source01|flag1|dep2\n", "B|source02|flag1|dep2\n", "A|source02|flag0|dep2\n", "A|source02|flag1|dep1\n", "", `${expected}extra\n`]) {
    assert.throws(() => assertOutput(bad, expected), /stale output or cross-project contamination/);
  }
  assert.doesNotThrow(() => assertOutput(expected, expected));
});

test("source oracle detects bytes, modes, links and unexpected empty directories", (t) => {
  const lab = new Lab("oracle"); t.after(() => lab.remove());
  const root = path.join(lab.root, "sources"), file = path.join(root, "source.txt");
  write(file, "one"); const before = inventory(root);
  write(file, "two"); assert.throws(() => assertUnchanged(before, root), /unplanned source write/);
  write(file, "one"); assertUnchanged(before, root);
  fs.mkdirSync(path.join(root, "target")); assert.throws(() => assertUnchanged(before, root), /unplanned source write/);
  fs.rmdirSync(path.join(root, "target"));
  fs.chmodSync(file, 0o700); assert.throws(() => assertUnchanged(before, root), /unplanned source write/);
  fs.chmodSync(file, before["./source.txt"].mode);
  if (process.platform !== "win32") {
    fs.symlinkSync(file, path.join(root, "alias")); const linked = inventory(root);
    fs.unlinkSync(path.join(root, "alias")); fs.symlinkSync(lab.root, path.join(root, "alias"));
    assert.throws(() => assertUnchanged(linked, root), /unplanned source write/);
  }
});

test("artifact oracle rejects missing, empty and out-of-root files", (t) => {
  const lab = new Lab("artifact-oracle"); t.after(() => lab.remove());
  const root = path.join(lab.root, "artifacts"), good = path.join(root, "binary"); write(good, "real bytes");
  assertInside(root, good);
  assert.throws(() => assertInside(root, path.join(root, "absent")));
  write(good, ""); assert.throws(() => assertInside(root, good), /missing\/empty artifact/);
  assert.throws(() => assertInside(root, path.join(lab.root, ".lab-owner")), /artifact outside selected root/);
});

test("lab isolates configuration, ambient overrides and credentials", (t) => {
  const lab = new Lab("environment-oracle"); t.after(() => lab.remove());
  for (const key of ["CARGO_TARGET_DIR", "GOCACHE", "GOMODCACHE", "UV_CACHE_DIR", "NPM_CONFIG_CACHE", "OPENAI_API_KEY", "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN", "NODE_OPTIONS", "CLEAN_DEVELOPMENT_SESSION_MODE", "CLEAN_DEVELOPMENT_SESSION_ENV"]) assert.equal(Object.hasOwn(lab.env, key), false, key);
  for (const key of ["HOME", "CLEAN_DEVELOPMENT_DATA_HOME", "CLEAN_DEVELOPMENT_CONFIG_HOME", "CLEAN_DEVELOPMENT_ROOT", "TMPDIR", "GIT_CONFIG_GLOBAL"]) assert.ok(lab.env[key].startsWith(`${lab.root}${path.sep}`), key);
});

test("inventories and explicit tool selection fail closed", (t) => {
  const lab = new Lab("bounds-oracle"); t.after(() => lab.remove());
  write(path.join(lab.root, "sources/file"), "bytes");
  assert.throws(() => inventory(path.join(lab.root, "sources"), { maxEntries: 1 }), /entry bound/);
  assert.throws(() => inventory(path.join(lab.root, "sources"), { maxBytes: 1 }), /byte bound/);
  return assert.rejects(() => runToolLab("not-a-tool"), /Unknown real-tool/);
});
