import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSizeScanner, measureDirectory } from "../src/measurement.js";

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "clean-development-size-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function symlink(t, target, link, type = "dir") {
  try { fs.symlinkSync(target, link, type); return true; }
  catch (error) { if (error.code === "EPERM" && process.platform === "win32") { t.skip("symlink privilege required"); return false; } throw error; }
}

test("scanner measures regular-file metadata without opening file contents", (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "nested"));
  fs.writeFileSync(path.join(root, "one"), "abc");
  fs.writeFileSync(path.join(root, "nested", "two"), "12345");
  t.mock.method(fs, "readFileSync", () => assert.fail("measurement must not read contents"));
  const result = measureDirectory(root);
  assert.equal(result.status, "complete");
  assert.equal(result.logicalBytes, 8);
  assert.equal(result.files, 2);
  assert.equal(result.directories, 2);
  assert.equal(result.entriesVisited, 3);
  assert.equal(result.issueCount, 0);
  assert.doesNotThrow(() => JSON.stringify(result));
});

test("empty and missing roots are different, and non-directories are unsafe", (t) => {
  const root = fixture(t);
  assert.equal(measureDirectory(root).logicalBytes, 0);
  const missing = measureDirectory(path.join(root, "absent"));
  assert.equal(missing.status, "missing");
  assert.equal(missing.logicalBytes, null);
  assert.equal(missing.allocatedBytes, null);
  fs.writeFileSync(path.join(root, "file"), "abc");
  assert.equal(measureDirectory(path.join(root, "file")).status, "unsafe");
});

test("hard links count as logical file names but allocated blocks are deduplicated", (t) => {
  const root = fixture(t);
  const file = path.join(root, "file");
  fs.writeFileSync(file, "a".repeat(100));
  fs.linkSync(file, path.join(root, "hardlink"));
  const stat = fs.statSync(file);
  const result = measureDirectory(root);
  assert.equal(result.status, "complete");
  assert.equal(result.logicalBytes, 200);
  assert.equal(result.hardlinkDuplicates, 1);
  assert.equal(result.allocatedBytes, process.platform === "win32" ? null : stat.blocks * 512);
});

test("sparse-file logical length is independent from allocated blocks", (t) => {
  const root = fixture(t);
  const file = path.join(root, "sparse");
  fs.writeFileSync(file, "x");
  fs.truncateSync(file, 16 * 1024 * 1024);
  const result = measureDirectory(root);
  assert.equal(result.logicalBytes, 16 * 1024 * 1024);
  assert.equal(result.allocatedBytes, process.platform === "win32" ? null : fs.statSync(file).blocks * 512);
});

test("leaf and ancestor symlink roots are refused; links inside a real root are skipped", (t) => {
  const root = fixture(t);
  const data = path.join(root, "data");
  const outside = path.join(root, "outside");
  fs.mkdirSync(data); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret"), "not counted");
  if (!symlink(t, outside, path.join(data, "link"))) return;
  assert.equal(measureDirectory(data).logicalBytes, 0);
  assert.equal(measureDirectory(data).symlinksSkipped, 1);
  assert.equal(measureDirectory(path.join(data, "link")).status, "unsafe");
  fs.mkdirSync(path.join(outside, "nested"));
  assert.equal(measureDirectory(path.join(data, "link", "nested")).status, "unsafe");
});

test("entry limits and a shared scanner bound work across roots", (t) => {
  const root = fixture(t);
  const a = path.join(root, "a"), b = path.join(root, "b");
  fs.mkdirSync(a); fs.mkdirSync(b);
  for (let i = 0; i < 5; i += 1) fs.writeFileSync(path.join(a, String(i)), "x");
  fs.writeFileSync(path.join(b, "file"), "1234");
  const scanner = createSizeScanner({ maxEntries: 2 });
  const first = scanner.measure(a);
  assert.equal(first.status, "partial");
  assert.equal(first.entriesVisited, 2);
  assert.equal(first.logicalBytes, 2);
  assert.equal(scanner.measure(a), first, "exact repeated roots reuse the same observation");
  const second = scanner.measure(b);
  assert.equal(second.status, "partial");
  assert.equal(second.entriesVisited, 0);
  assert.ok(second.issues.some((issue) => issue.code === "entry-limit"));
});

test("zero time budget does no filesystem work and invalid budgets are rejected", (t) => {
  const root = fixture(t);
  const mock = t.mock.method(fs, "lstatSync", () => assert.fail("budget exhausted before stat"));
  const result = measureDirectory(root, { maxDurationMs: 0 });
  assert.equal(result.status, "partial");
  assert.equal(result.entriesVisited, 0);
  assert.equal(result.issues[0].code, "time-limit");
  mock.mock.restore();
  for (const value of [-1, NaN, Infinity, 1.5, "2", Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createSizeScanner({ maxEntries: value }), /non-negative safe integer/);
    assert.throws(() => createSizeScanner({ maxDurationMs: value }), /non-negative safe integer/);
  }
});

test("unreadable roots are unknown, not empty", (t) => {
  const root = fixture(t);
  t.mock.method(fs, "lstatSync", () => { throw Object.assign(new Error("private detail"), { code: "EACCES" }); });
  const result = measureDirectory(root);
  assert.equal(result.status, "unavailable");
  assert.equal(result.logicalBytes, null);
  assert.doesNotMatch(JSON.stringify(result), /private detail/);
});

test("partial permission failures and disappeared entries do not become exact totals", (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "denied"));
  fs.writeFileSync(path.join(root, "vanished"), "abcd");
  fs.writeFileSync(path.join(root, "kept"), "123");
  const open = fs.opendirSync, lstat = fs.lstatSync;
  t.mock.method(fs, "opendirSync", (file, ...args) => {
    if (String(file) === path.join(root, "denied")) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return open(file, ...args);
  });
  t.mock.method(fs, "lstatSync", (file, ...args) => {
    if (String(file) === path.join(root, "vanished")) throw Object.assign(new Error("gone"), { code: "ENOENT" });
    return lstat(file, ...args);
  });
  const result = measureDirectory(root);
  assert.equal(result.status, "partial");
  assert.equal(result.logicalBytes, 3);
  assert.deepEqual(new Set(result.issues.map((issue) => issue.code)), new Set(["EACCES", "ENOENT"]));
});

test("different devices are not traversed", (t) => {
  const root = fixture(t);
  const child = path.join(root, "mounted"); fs.mkdirSync(child);
  fs.writeFileSync(path.join(child, "data"), "abc");
  const lstat = fs.lstatSync;
  t.mock.method(fs, "lstatSync", (file, ...args) => {
    const stat = lstat(file, ...args);
    if (String(file) === child) stat.dev += typeof stat.dev === "bigint" ? 1n : 1;
    return stat;
  });
  const result = measureDirectory(root);
  assert.equal(result.status, "partial");
  assert.equal(result.logicalBytes, 0);
  assert.equal(result.issues[0].code, "different-device");
});

test("a directory replaced at open is detected before its entries are consumed", (t) => {
  const root = fixture(t);
  const data = path.join(root, "data"), child = path.join(data, "child"), outside = path.join(root, "outside");
  fs.mkdirSync(child, { recursive: true }); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret"), "must not count");
  const open = fs.opendirSync;
  let swapped = false, closed = false;
  t.mock.method(fs, "opendirSync", (file, ...args) => {
    if (String(file) !== child || swapped) return open(file, ...args);
    swapped = true;
    fs.renameSync(child, path.join(data, "old-child"));
    if (!symlink(t, outside, child)) return open(path.join(data, "old-child"), ...args);
    const handle = open(file, ...args);
    return { readSync() { assert.fail("must revalidate before reading entries"); }, closeSync() { closed = true; handle.closeSync(); } };
  });
  const result = measureDirectory(data);
  assert.equal(result.status, "partial");
  assert.equal(result.logicalBytes, 0);
  assert.equal(closed, true);
  assert.ok(result.issues.some((issue) => issue.code === "DIRECTORY_CHANGED"));
});

test("unsupported allocation metadata and unsafe integer totals are explicit", (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "huge"), "x");
  const lstat = fs.lstatSync;
  t.mock.method(fs, "lstatSync", (file, ...args) => {
    const stat = lstat(file, ...args);
    if (path.basename(String(file)) === "huge") { stat.size = BigInt(Number.MAX_SAFE_INTEGER) + 1n; stat.blocks = undefined; }
    return stat;
  });
  const result = measureDirectory(root);
  assert.equal(result.status, "partial");
  assert.equal(result.logicalBytes, null);
  assert.equal(result.allocatedBytes, null);
  assert.equal(result.issues[0].code, "logical-size-overflow");
});

test("issues are capped even when a directory contains many failing entries", (t) => {
  const root = fixture(t);
  for (let i = 0; i < 35; i += 1) fs.writeFileSync(path.join(root, `file-${i}`), "x");
  const lstat = fs.lstatSync;
  t.mock.method(fs, "lstatSync", (file, ...args) => {
    if (path.basename(String(file)).startsWith("file-")) throw Object.assign(new Error("fixture"), { code: "EIO" });
    return lstat(file, ...args);
  });
  const result = measureDirectory(root);
  assert.equal(result.issueCount, 35);
  assert.equal(result.issues.length, 20);
});
