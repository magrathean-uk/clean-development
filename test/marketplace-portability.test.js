import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { withoutCleanDevelopmentEnvironment } from "../scripts/harness-utils.mjs";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cd bundle & contract ")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const relative of ["bin", "src", "integrations", "hooks", "schemas", ".claude-plugin", "claude-skills",
    "package.json", "LICENSE", "SUPPORT.md", "PRIVACY.md", "TERMS.md", "SECURITY.md", "docs/verification.md", "scripts/build-marketplace.mjs"]) {
    const target = path.join(root, relative); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(path.join(sourceRoot, relative), target, { recursive: true });
  }
  const env = withoutCleanDevelopmentEnvironment();
  for (const key of Object.keys(env)) if (["NODE_OPTIONS", "NODE_PATH"].includes(key.toUpperCase())) delete env[key];
  const run = (args = []) => spawnSync(process.execPath, [path.join(root, "scripts", "build-marketplace.mjs"), ...args], {
    cwd: root, env, encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024
  });
  return { root, bundle: path.join(root, "marketplace", "claude"), run };
}

test("bundle generation and read-only verification agree on nested native paths", (t) => {
  const item = fixture(t);
  const missing = item.run(["--check"]);
  assert.notEqual(missing.status, 0); assert.equal(fs.existsSync(item.bundle), false);
  const built = item.run(); assert.equal(built.status, 0, built.stderr);
  const checked = item.run(["--check"]); assert.equal(checked.status, 0, checked.stderr);
  assert.deepEqual(fs.readFileSync(path.join(item.bundle, "docs", "verification.md")), fs.readFileSync(path.join(item.root, "docs", "verification.md")));
});

test("a stale bundle is diagnosed without writes and is refreshed only explicitly", (t) => {
  const item = fixture(t);
  assert.equal(item.run().status, 0);
  const source = path.join(item.root, "src", "constants.js");
  const target = path.join(item.bundle, "src", "constants.js");
  const original = fs.readFileSync(target); fs.appendFileSync(source, "\n// fixture change\n");
  const checked = item.run(["--check"]);
  assert.notEqual(checked.status, 0); assert.match(checked.stderr, /Stale bundle file/);
  assert.deepEqual(fs.readFileSync(target), original);
  const updated = item.run(); assert.equal(updated.status, 0, updated.stderr);
  assert.deepEqual(fs.readFileSync(target), fs.readFileSync(source));
});

test("unrecognised bundle entries block regeneration without deleting user files", (t) => {
  const item = fixture(t); assert.equal(item.run().status, 0);
  const unknown = path.join(item.bundle, "docs", "operator.txt"); fs.writeFileSync(unknown, "retain");
  for (const args of [[], ["--check"]]) {
    const result = item.run(args); assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unexpected bundle file/); assert.equal(fs.readFileSync(unknown, "utf8"), "retain");
  }
});

test("bundle verification rejects symlinked documentation instead of following it", (t) => {
  const item = fixture(t); assert.equal(item.run().status, 0);
  const file = path.join(item.bundle, "docs", "verification.md");
  const outside = path.join(item.root, "outside.txt"); fs.writeFileSync(outside, "retain"); fs.unlinkSync(file);
  try { fs.symlinkSync(outside, file); }
  catch (error) { if (process.platform === "win32" && error.code === "EPERM") return t.skip("symlink privilege unavailable"); throw error; }
  const result = item.run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /symlinks/);
  assert.equal(fs.readFileSync(outside, "utf8"), "retain"); assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
});
