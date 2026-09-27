import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { auditPackage, isolatedReleaseEnvironment, readPackage, run, scanPrivate, sha256, sourceInventory } from "../scripts/release-audit-lib.mjs";

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clean-development-audit-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = isolatedReleaseEnvironment(root, { PATH: process.env.PATH, npm_config_registry: "must-not-inherit", GH_TOKEN: "not-a-real-token", NODE_OPTIONS: "--throw-deprecation" });
  const source = path.join(root, "source");
  fs.mkdirSync(source);
  const write = (name, contents) => {
    fs.mkdirSync(path.dirname(path.join(source, name)), { recursive: true });
    fs.writeFileSync(path.join(source, name), contents);
    fs.chmodSync(path.join(source, name), 0o644); // Git regular-file input, independent of the invoking umask.
  };
  write("package.json", `${JSON.stringify({ name: "release-audit-fixture", version: "1.0.1", type: "module", files: ["src/", "docs/", ".opencode/"], scripts: {} }, null, 2)}\n`);
  write("package-lock.json", JSON.stringify({ version: "1.0.1", packages: { "": { version: "1.0.1" } } }));
  write(".version-bump.json", JSON.stringify({ version: "1.0.1", files: ["package.json", "package-lock.json", "src/constants.js"] }));
  write(".github/ISSUE_TEMPLATE/bug.yml", "id: version\nattributes:\n  placeholder: 1.0.1\n");
  write("src/constants.js", 'export const VERSION = "1.0.1";\n');
  write("src/index.js", "export const answer = 42;\n");
  write("docs/example.md", "Reviewed documentation.\n");
  write("README.md", "Release audit fixture, not a preceding release.\n");
  write(".npmrc", "audit=false\n");
  write("test-only.txt", "Source-only fixture\n");
  run("git", ["-c", "init.defaultBranch=main", "init", "--quiet", source], { env });
  const git = (args) => run("git", args, { cwd: source, env });
  const commit = () => { git(["add", "."]); git(["-c", "user.name=Audit Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "Synthetic audit input, not a release"]); };
  commit();
  const pack = (name) => {
    const directory = path.join(root, name);
    fs.mkdirSync(directory);
    run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory], { cwd: source, env });
    const filename = fs.readdirSync(directory).find((name) => name.endsWith(".tgz"));
    return readPackage(fs.readFileSync(path.join(directory, filename)));
  };
  return { root, source, env, write, commit, pack, inventory: () => sourceInventory(source, env) };
}

// An independent tiny tar writer for malformed-header tests, not the audit reader.
function tar(entries) {
  const blocks = [];
  for (const item of entries) {
    const data = Buffer.from(item.text || "");
    const block = Buffer.alloc(512);
    block.write(item.name);
    const octal = (value, start, length) => block.write(`${value.toString(8).padStart(length - 1, "0")}\0`, start, length, "ascii");
    octal(0o644, 100, 8); octal(0, 108, 8); octal(0, 116, 8); octal(data.length, 124, 12); octal(499162500, 136, 12);
    block.fill(32, 148, 156);
    block.write(item.type || "0", 156);
    if (item.link) block.write(item.link, 157);
    block.write("ustar\0", 257); block.write("00", 263);
    const sum = [...block].reduce((a, b) => a + b, 0);
    block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(block, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

const posix = { skip: process.platform === "win32" ? "Real npm CLI fixture requires POSIX; reader/unit controls are platform-independent" : false };

test("release audit reads actual npm tarball bytes and accounts for every source file", posix, (t) => {
  const f = fixture(t);
  const source = f.inventory();
  const archive = f.pack("first");
  const result = auditPackage(source, archive, [f.root, "HOST_CANARY_not_in_package"]);
  assert.equal(result.inventory.length, 5);
  assert.equal(result.inventory.length + result.excluded.length, source.length);
  assert.ok(result.excluded.some((file) => file.path === ".npmrc"));
  assert.ok(result.excluded.some((file) => file.path === "package-lock.json"));
  assert.ok(result.inventory.every((file) => file.sha256 === file.sourceSha256));
  assert.deepEqual(result.inventory.map((file) => file.path), [...result.inventory.map((file) => file.path)].sort());
  for (const file of source) fs.utimesSync(path.join(f.source, file.path), 42, 42);
  const second = f.pack("second");
  assert.equal(second.tarSha256, archive.tarSha256);
  assert.deepEqual(auditPackage(source, second).inventory, result.inventory);
});

test("release audit rejects a real npm pack's injected host config and omitted runtime file", posix, async (t) => {
  const f = fixture(t);
  const source = f.inventory();
  await t.test("untracked configuration in a broad npm files directory is not release input", () => {
    f.write(".opencode/opencode.json", '{"secret":"DISPOSABLE_HOST_CONFIG_CANARY"}\n');
    const archive = f.pack("injected");
    assert.ok(archive.entries.some((entry) => entry.path === ".opencode/opencode.json"));
    assert.throws(() => auditPackage(source, archive), /Tar members differ/);
    fs.unlinkSync(path.join(f.source, ".opencode/opencode.json"));
  });
  await t.test("nested npmignore must not silently omit committed code", () => {
    f.write("src/.npmignore", "index.js\n");
    const archive = f.pack("omitted");
    assert.ok(!archive.entries.some((entry) => entry.path === "src/index.js"));
    assert.throws(() => auditPackage(source, archive), /Tar members differ/);
  });
});

test("release audit fails closed for source/package substitutions and version drift", posix, async (t) => {
  const f = fixture(t);
  const source = f.inventory();
  const archive = f.pack("control");
  const sourceCopy = () => source.map((entry) => ({ ...entry, bytes: Buffer.from(entry.bytes) }));
  const archiveCopy = () => ({ ...archive, entries: archive.entries.map((entry) => ({ ...entry, bytes: Buffer.from(entry.bytes) })) });
  await t.test("changed payload bytes", () => {
    const modified = archiveCopy();
    modified.entries.find((entry) => entry.path === "src/index.js").bytes[0] ^= 1;
    assert.throws(() => auditPackage(source, modified), /Source\/package bytes differ/);
  });
  for (const [field, value] of [["mode", 0o777], ["uid", 1234], ["gid", 1234], ["uname", "private-user"], ["gname", "private-group"]]) {
    await t.test(`unexpected ${field}`, () => {
      const modified = archiveCopy();
      modified.entries[0][field] = value;
      assert.throws(() => auditPackage(source, modified), /Unexpected package mode|Archive contains host/);
    });
  }
  await t.test("source-only lock root is still version-checked", () => {
    const modified = sourceCopy();
    const lock = modified.find((entry) => entry.path === "package-lock.json");
    lock.bytes = Buffer.from(JSON.stringify({ version: "1.0.1", packages: { "": { version: "1.0.0" } } }));
    assert.throws(() => auditPackage(modified, archive), /root-package version mismatch/);
  });
  await t.test("source-only registry drift", () => {
    const modified = sourceCopy();
    const bump = modified.find((entry) => entry.path === ".version-bump.json");
    bump.bytes = Buffer.from(bump.bytes.toString().replace('"version":"1.0.1"', '"version":"1.0.0"'));
    assert.throws(() => auditPackage(modified, archive), /Version registry mismatch/);
  });
});

test("tar reader rejects ambiguous and unsafe archives without extracting anything", async (t) => {
  assert.equal(readPackage(tar([{ name: "package/file.txt", text: "hi" }])).entries[0].sha256, sha256("hi"));
  for (const name of ["../outside", "/package/absolute", "package/../escape", "package/a//b", "package/a\\b", "package/C:drive"]) {
    await t.test(name, () => assert.throws(() => readPackage(tar([{ name }]))));
  }
  for (const type of ["1", "2", "3", "5", "g", "L"]) {
    await t.test(`reject type ${type}`, () => assert.throws(() => readPackage(tar([{ name: "package/entry", type, link: "target" }]))));
  }
  await t.test("duplicate/colliding names", () => assert.throws(() => readPackage(tar([{ name: "package/file" }, { name: "package/FILE" }]))));
  await t.test("truncated gzip", () => assert.throws(() => readPackage(tar([{ name: "package/file" }]).subarray(0, 30))));
  await t.test("additional gzip member", () => assert.throws(() => readPackage(Buffer.concat([tar([{ name: "package/file" }]), gzipSync(Buffer.alloc(0))])), /Only one gzip member/));
  await t.test("gzip filename/metadata flag", () => {
    const archive = tar([{ name: "package/file" }]); archive[3] = 8;
    assert.throws(() => readPackage(archive), /Gzip flags/);
  });
  await t.test("gzip timestamp", () => {
    const archive = tar([{ name: "package/file" }]); archive.writeUInt32LE(123, 4);
    assert.throws(() => readPackage(archive), /Gzip timestamp/);
  });
  await t.test("bad tar checksum", () => {
    const archive = readPackage(tar([{ name: "package/file" }])); archive.tar[0] ^= 1;
    assert.throws(() => readPackage(gzipSync(archive.tar)), /checksum/);
  });
  await t.test("trailing nonzero tar data", () => {
    const archive = readPackage(tar([{ name: "package/file" }])); archive.tar[archive.tar.length - 1] = 1;
    assert.throws(() => readPackage(gzipSync(archive.tar)), /terminator/);
  });
  await t.test("unreviewed PAX metadata", () => assert.throws(() => readPackage(tar([{ name: "PaxHeader", type: "x", text: "14 uname=user\n" }, { name: "package/file" }]))));
});

test("privacy scan reports rule IDs, never credential values", () => {
  const fake = "ghp_" + "A".repeat(36);
  const findings = scanPrivate([{ path: "payload.txt", bytes: Buffer.from(`${fake}\n/home/private-machine-user/work\nHOST_CANARY\n`) }], ["HOST_CANARY"]);
  assert.deepEqual(findings.map((item) => item.rule), ["github-token", "private-home-path", "host-canary-or-private-path"]);
  assert.ok(!JSON.stringify(findings).includes(fake));
  assert.deepEqual(scanPrivate([{ path: "normal.txt", bytes: Buffer.from("ordinary source") }]), []);
});

test("release environment excludes ambient credentials, routing and npm/Git overrides", (t) => {
  const f = fixture(t);
  for (const key of ["GH_TOKEN", "NODE_OPTIONS", "npm_config_registry", "CARGO_TARGET_DIR"]) assert.equal(f.env[key], undefined);
  assert.equal(f.env.npm_config_offline, "true");
  assert.ok(f.env.HOME.startsWith(f.root));
  assert.ok(f.env.npm_config_userconfig.startsWith(f.root));
  assert.equal(f.env.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(f.env.CLEAN_DEVELOPMENT_ROOT, undefined, "Build checks must be free to select their own disposable storage roots");
});

test("release driver provides commands without side effects on help", () => {
  const script = fileURLToPath(new URL("../scripts/audit-release.mjs", import.meta.url));
  const text = run(process.execPath, [script, "--help"]);
  assert.match(text, /--output/);
  assert.match(text, /preceding-release tag/);
});

test("tracked host configuration still fails the independent release policy", posix, (t) => {
  const f = fixture(t);
  f.write(".opencode/opencode.json", '{"theme":"local-only"}\n');
  f.commit();
  assert.throws(() => auditPackage(f.inventory(), f.pack("tracked-config")), /Forbidden configuration/);
});

test("matching committed bytes do not bypass the credential and private-path gate", posix, async (t) => {
  const f = fixture(t);
  for (const [name, value] of [["credential", "npm_" + "B".repeat(36)], ["host-path", "/home/" + "private-machine/work"]]) {
    await t.test(name, () => {
      f.write("docs/example.md", value);
      f.commit();
      assert.throws(() => auditPackage(f.inventory(), f.pack(name)), /Private-material scan failed/);
    });
  }
});

test("tar reader accepts length-checked Unicode local PAX paths", () => {
  const target = `package/${"long-directory/".repeat(8)}caf\u00e9.txt`;
  const value = `path=${target}\n`;
  let length = Buffer.byteLength(value) + 3;
  while (length !== Buffer.byteLength(`${length} ${value}`)) length = Buffer.byteLength(`${length} ${value}`);
  const archive = readPackage(tar([{ name: "PaxHeader", type: "x", text: `${length} ${value}` }, { name: "package/placeholder", text: "payload" }]));
  assert.equal(archive.entries[0].path, target.slice(8));
  assert.equal(archive.entries[0].bytes.toString(), "payload");
});
