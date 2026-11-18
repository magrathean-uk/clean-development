import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { treeDigest } from "../runtime/lib/release.mjs";
import { sim, mk } from "./helpers.mjs";

test("release digest is identical for trees created under umask 022 and 077", () => {
  const s = sim({ mounted: false }), masks = [0o022, 0o077];
  const roots = masks.map((mask) => {
    const root = path.join(s.root, String(mask)), previous = process.umask(mask);
    try {
      fs.mkdirSync(path.join(root, "nested"), { recursive: true });
      fs.writeFileSync(path.join(root, "nested/data"), "same bytes");
      fs.writeFileSync(path.join(root, "tool"), "#!/bin/sh\n", { mode: 0o777 });
    } finally { process.umask(previous); }
    return root;
  });
  assert.notEqual(fs.statSync(path.join(roots[0], "tool")).mode, fs.statSync(path.join(roots[1], "tool")).mode);
  assert.equal(treeDigest(roots[0]), treeDigest(roots[1]));
  fs.chmodSync(path.join(roots[1], "nested"), 0o700);
  fs.chmodSync(path.join(roots[1], "nested/data"), 0o640);
  assert.equal(treeDigest(roots[0]), treeDigest(roots[1]));
});

test("release digest detects content, relative name and executable-bit changes", () => {
  const s = sim({ mounted: false }), root = path.join(s.root, "release");
  const file = mk(path.join(root, "data"), "before"), before = treeDigest(root);
  fs.writeFileSync(file, "after"); assert.notEqual(treeDigest(root), before);
  fs.writeFileSync(file, "before"); assert.equal(treeDigest(root), before);
  fs.chmodSync(file, 0o700); assert.notEqual(treeDigest(root), before);
  fs.chmodSync(file, 0o600); assert.equal(treeDigest(root), before);
  fs.renameSync(file, path.join(root, "renamed")); assert.notEqual(treeDigest(root), before);
});

test("release digest rejects a bundled file that would replace a runtime entry", () => {
  const s = sim({ mounted: false }), root = path.join(s.root, "release");
  const bundled = mk(path.join(s.root, "installer.mjs"));
  mk(path.join(root, "installer.mjs"));
  assert.throws(() => treeDigest(root, [bundled]), (error) => {
    assert.match(error.message, /duplicate release entry: installer\.mjs/);
    console.log(`negative release digest: ${error.message}`);
    return true;
  });
});

test("release digest rejects linked roots, linked entries and special files", () => {
  const s = sim({ mounted: false }), root = path.join(s.root, "release"), file = mk(path.join(root, "data"));
  const alias = path.join(s.root, "alias"); fs.symlinkSync(root, alias);
  assert.throws(() => treeDigest(alias), /not a real directory/);
  fs.symlinkSync(file, path.join(root, "linked"));
  assert.throws(() => treeDigest(root), /contains a symlink/);
  fs.unlinkSync(path.join(root, "linked"));
  assert.throws(() => treeDigest(file), /not a real directory/);
  const fifo = path.join(root, "fifo"), result = spawnSync("/usr/bin/mkfifo", [fifo], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.throws(() => treeDigest(root), /contains a special file/);
});
