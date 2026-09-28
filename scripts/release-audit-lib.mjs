import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";
import { spawnSync } from "node:child_process";

export const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const order = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const utf8 = new TextDecoder("utf-8", { fatal: true });
const MAX_BYTES = 64 * 1024 * 1024;

export function run(command, args, { returnResult = false, ...options } = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8", timeout: 180_000, maxBuffer: MAX_BYTES, ...options
  });
  if (result.error || result.status !== 0) {
    const error = new Error(`Command failed: ${path.basename(command)} ${args[0] || ""} (status ${result.status}, signal ${result.signal || "none"})`);
    error.result = result;
    throw error;
  }
  return returnResult ? result : result.stdout;
}

export function safeRelative(value) {
  assert.equal(typeof value, "string", "Path must be a string");
  assert.ok(value.length && !/[\\\x00-\x1f\x7f:]/u.test(value), "Unsafe archive/source path");
  assert.ok(value.split("/").every((part) => part && part !== "." && part !== ".."), "Non-canonical archive/source path");
  return value;
}

// Read the archive itself, not npm's self-reported pack list. Do not extract it.
// Deliberately reject links, devices, global PAX and unknown formats/metadata.
export function readPackage(buffer) {
  assert.ok(buffer.length <= MAX_BYTES, "Compressed archive exceeds audit limit");
  assert.equal(buffer.subarray(0, 4).toString("hex"), "1f8b0800", "Gzip flags must not carry host metadata");
  assert.equal(buffer.readUInt32LE(4), 0, "Gzip timestamp must be zero");
  const deflate = inflateRawSync(buffer.subarray(10), { info: true, maxOutputLength: MAX_BYTES });
  assert.equal(deflate.engine.bytesWritten + 18, buffer.length, "Only one gzip member with no trailing data is allowed");
  const tar = gunzipSync(buffer, { maxOutputLength: MAX_BYTES });
  assert.equal(tar.length % 512, 0, "Truncated tar block");
  const entries = [];
  const seen = new Set();
  let pax = null;
  let ended = false;
  const field = (block, start, size) => {
    const bytes = block.subarray(start, start + size);
    const end = bytes.indexOf(0);
    return utf8.decode(end < 0 ? bytes : bytes.subarray(0, end));
  };
  const number = (block, start, size) => {
    const raw = field(block, start, size).trim();
    assert.match(raw, /^[0-7]*$/, "Unsupported tar numeric field");
    const value = Number.parseInt(raw || "0", 8);
    assert.ok(Number.isSafeInteger(value), "Invalid tar integer");
    return value;
  };
  for (let offset = 0; offset < tar.length;) {
    const block = tar.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) {
      assert.ok(tar.length - offset >= 1024 && tar.subarray(offset).every((byte) => byte === 0), "Invalid tar terminator/trailing data");
      ended = true;
      break;
    }
    const checksum = [...block].reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);
    assert.equal(number(block, 148, 8), checksum, "Invalid tar checksum");
    assert.equal(field(block, 257, 6), "ustar", "Unsupported tar format");
    const size = number(block, 124, 12);
    assert.ok(size <= MAX_BYTES && offset + 512 + Math.ceil(size / 512) * 512 <= tar.length, "Truncated tar body");
    const bytes = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    const type = field(block, 156, 1);
    if (type === "x") {
      assert.equal(pax, null, "Repeated PAX header");
      pax = {};
      for (let cursor = 0; cursor < bytes.length;) {
        const space = bytes.indexOf(32, cursor);
        assert.ok(space > cursor, "Invalid PAX record");
        const lengthText = bytes.subarray(cursor, space).toString("ascii");
        assert.match(lengthText, /^[1-9][0-9]*$/, "Invalid PAX length");
        const end = cursor + Number(lengthText);
        assert.ok(end <= bytes.length && end > space + 2 && bytes[end - 1] === 10, "Truncated PAX record");
        const record = utf8.decode(bytes.subarray(space + 1, end - 1));
        const separator = record.indexOf("=");
        assert.ok(separator > 0, "Invalid PAX key");
        const key = record.slice(0, separator);
        assert.ok(["path", "size", "mtime"].includes(key) && !Object.hasOwn(pax, key), "Unreviewed PAX metadata");
        pax[key] = record.slice(separator + 1);
        cursor = end;
      }
      continue;
    }
    assert.ok(type === "0" || type === "", "Archive must contain only regular files");
    assert.equal(field(block, 157, 100), "", "Unexpected link target");
    const prefix = field(block, 345, 155);
    const name = pax?.path ?? `${prefix ? `${prefix}/` : ""}${field(block, 0, 100)}`;
    safeRelative(name);
    assert.ok(name.startsWith("package/"), "Archive entry outside package/");
    const relative = safeRelative(name.slice(8));
    // Case collisions are also unsafe for a package installed on common macOS/Windows filesystems.
    const collisionKey = relative.normalize("NFC").toLowerCase();
    assert.ok(!seen.has(collisionKey), "Duplicate/colliding archive path");
    seen.add(collisionKey);
    if (pax?.size !== undefined) assert.equal(pax.size, String(size), "PAX size mismatch");
    const mtime = pax?.mtime === undefined ? number(block, 136, 12) : Number(pax.mtime);
    assert.ok(Number.isSafeInteger(mtime) && mtime >= 0, "Invalid archive time");
    entries.push({
      path: relative, bytes, size, mode: number(block, 100, 8),
      uid: number(block, 108, 8), gid: number(block, 116, 8),
      uname: field(block, 265, 32), gname: field(block, 297, 32), mtime,
      pax: pax || {}, sha256: sha256(bytes)
    });
    assert.ok(entries.length <= 20_000, "Archive exceeds file-count limit");
    pax = null;
  }
  assert.ok(ended && pax === null && entries.length > 0, "Incomplete/empty archive");
  return { tar, gzipHeader: buffer.subarray(0, 10).toString("hex"), tarSha256: sha256(tar), entries: entries.sort((a, b) => order(a.path, b.path)) };
}

export function sourceInventory(root, env, ref = "HEAD") {
  const records = run("git", ["ls-tree", "-rz", "--full-tree", ref], { cwd: root, env }).split("\0").filter(Boolean);
  return records.map((record) => {
    const tab = record.indexOf("\t");
    const [mode, type, blob] = record.slice(0, tab).split(" ");
    const relative = safeRelative(record.slice(tab + 1));
    assert.ok(type === "blob" && ["100644", "100755"].includes(mode), "Release source must contain only regular tracked files");
    const bytes = run("git", ["cat-file", "blob", blob], { cwd: root, env, encoding: null });
    return { path: relative, mode, blob, size: bytes.length, sha256: sha256(bytes), bytes };
  }).sort((a, b) => order(a.path, b.path));
}

const PRIVATE_RULES = [
  ["private-key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ["aws-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["npm-token", /\bnpm_[A-Za-z0-9]{30,}\b/],
  ["npm-auth", /(?:_authToken|_auth|_password)\s*=\s*(?!\$\{)[^\s#;]+/],
  ["private-home-path", /(?:\/Users\/|\/home\/|[A-Za-z]:[\\/]Users[\\/])[^\s/\\"'<>]+/],
  ["embedded-url-credential", /https?:\/\/[^\s/@:]+:[^\s/@]+@/]
];
export function scanPrivate(entries, canaries = []) {
  const findings = [];
  for (const entry of entries) {
    const text = entry.bytes.toString("utf8");
    for (const [rule, expression] of PRIVATE_RULES) if (expression.test(text)) findings.push({ path: entry.path, rule });
    for (const value of canaries) {
      if (value && (entry.bytes.includes(Buffer.from(value)) || entry.path.includes(value))) {
        findings.push({ path: entry.path, rule: "host-canary-or-private-path" });
        break;
      }
    }
  }
  return findings;
}

function forbiddenFile(relative) {
  return /^(?:scripts|test|marketplace|\.github)\//.test(relative)
    || /(?:^|\/)(?:\.git|node_modules|\.ssh|\.aws|\.azure|\.gnupg|\.codex|\.claude)(?:\/|$)/i.test(relative)
    || /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.npmrc|\.yarnrc(?:\.yml)?|\.clean-development\.json|\.DS_Store|npm-debug\.log|credentials(?:\.json)?|id_rsa|id_ed25519)$/i.test(relative)
    || /\.(?:pem|p12|pfx|key|tgz|zip|log)$/i.test(relative)
    || /^\.(?:opencode\/(?:opencode\.jsonc?|auth\.json)|pi\/(?:settings\.json|auth\.json))$/i.test(relative);
}

function packagingRules(packageJson) {
  assert.ok(Array.isArray(packageJson.files) && packageJson.files.length, "An explicit package files allowlist is required");
  assert.ok(!packageJson.dependencies && !packageJson.devDependencies && !packageJson.optionalDependencies
    && !packageJson.bundleDependencies && !packageJson.bundledDependencies && !packageJson.workspaces,
  "Dependency/workspace packaging needs a separate reviewed policy");
  return packageJson.files.map((entry) => {
    assert.equal(typeof entry, "string");
    assert.ok(!/[!*?{}[\]]/.test(entry), "Glob package rules need an explicit audit policy");
    return safeRelative(entry.replace(/\/$/, "")) + (entry.endsWith("/") ? "/" : "");
  });
}

function versionValue(relative, bytes) {
  const text = bytes.toString("utf8");
  if (relative === "src/constants.js") return text.match(/VERSION\s*=\s*["']([^"']+)["']/)?.[1];
  if (relative.endsWith(".yaml")) return text.match(/^version:\s*([^\s#]+)/m)?.[1];
  const value = JSON.parse(text);
  return relative.endsWith("marketplace.json") ? value.plugins?.[0]?.version : value.version;
}

export function auditPackage(source, archive, canaries = []) {
  const inputs = new Map(source.map((entry) => [entry.path, entry]));
  const members = new Map(archive.entries.map((entry) => [entry.path, entry]));
  const json = (relative) => JSON.parse(inputs.get(relative).bytes);
  const packageJson = json("package.json");
  const rules = packagingRules(packageJson);
  const ruleFor = (relative) => relative === "package.json" ? "npm mandatory package.json"
    : ["README.md", "LICENSE"].includes(relative) ? "npm mandatory documentation"
    : rules.find((rule) => rule.endsWith("/") ? relative.startsWith(rule) : relative === rule);
  const expected = source.filter((entry) => ruleFor(entry.path));
  const expectedNames = new Set(expected.map((entry) => entry.path));
  const excluded = source.filter((entry) => !expectedNames.has(entry.path)).map(({ bytes, ...entry }) => ({
    ...entry,
    reason: entry.path === "package-lock.json" ? "npm excludes package-lock.json; source version checked"
      : entry.path.startsWith("marketplace/") ? "separate generated distribution; outside npm files allowlist"
      : "source-only; outside npm files allowlist"
  }));
  assert.deepEqual([...members.keys()].sort(order), [...expectedNames].sort(order), "Tar members differ from independent tracked-source allowlist");
  const inventory = archive.entries.map((entry) => {
    assert.ok(!forbiddenFile(entry.path), `Forbidden configuration/credential/artifact path: ${entry.path}`);
    const input = inputs.get(entry.path);
    assert.ok(entry.bytes.equals(input.bytes), `Source/package bytes differ: ${entry.path}`);
    const expectedMode = input.mode === "100755" ? 0o755 : 0o644;
    assert.equal(entry.mode, expectedMode, `Unexpected package mode: ${entry.path}`);
    assert.equal(entry.uid, 0, "Archive contains host uid");
    assert.equal(entry.gid, 0, "Archive contains host gid");
    assert.equal(entry.uname, "", "Archive contains host user");
    assert.equal(entry.gname, "", "Archive contains host group");
    const { bytes, ...metadata } = entry;
    return { ...metadata, mode: entry.mode.toString(8), source: input.path, sourceBlob: input.blob, sourceSha256: input.sha256, inclusion: ruleFor(entry.path) };
  });
  const findings = [...scanPrivate(archive.entries, canaries), ...scanPrivate([{ path: "<tar-metadata-and-payload>", bytes: archive.tar }], canaries)];
  assert.deepEqual(findings, [], "Private-material scan failed (only paths/rule IDs are reported)");
  const bump = json(".version-bump.json");
  const version = packageJson.version;
  assert.equal(bump.version, version, "Version registry mismatch");
  assert.equal(new Set(bump.files).size, bump.files.length, "Duplicate version registry entry");
  const versions = bump.files.map((relative) => {
    const entry = inputs.get(safeRelative(relative));
    assert.ok(entry, "Missing registered version file");
    const sourceVersion = versionValue(relative, entry.bytes);
    assert.equal(sourceVersion, version, `Source version mismatch: ${relative}`);
    const packageVersion = members.has(relative) ? versionValue(relative, members.get(relative).bytes) : null;
    if (packageVersion !== null) assert.equal(packageVersion, version, `Package version mismatch: ${relative}`);
    return { path: relative, sourceVersion, packageVersion, packaged: members.has(relative) };
  });
  const lock = json("package-lock.json");
  assert.equal(lock.version, version, "Lockfile top-level version mismatch");
  assert.equal(lock.packages?.[""]?.version, version, "Lockfile root-package version mismatch");
  const bug = inputs.get(".github/ISSUE_TEMPLATE/bug.yml").bytes.toString("utf8");
  assert.equal(bug.match(/id:\s*version\s*\n[\s\S]*?placeholder:\s*["']?([^"'\s#]+)["']?/)?.[1], version, "Bug template version mismatch");
  assert.ok(!["preinstall", "install", "postinstall", "prepare"].some((hook) => packageJson.scripts?.[hook]), "Unreviewed installation lifecycle hook");
  return { version, inventory, excluded, versions, privacy: { findings, rules: PRIVATE_RULES.map(([id]) => id), canaryCount: canaries.length, limitation: "Pattern and canary checks are not a proof of absence of all possible secrets." } };
}

// No ambient tokens, NODE_OPTIONS, routing, proxy, Git or npm configuration.
// HOME isolation is not a filesystem sandbox; reviewed source still executes.
export function isolatedReleaseEnvironment(root, inherited = process.env) {
  const env = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
    if (inherited[key]) env[key] = inherited[key];
  }
  for (const directory of ["home", "tmp", "npm-cache", "config", "data", "cache", "agent-codex", "agent-claude", "agent-grok", "cargo-home"]) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
  for (const file of ["npmrc", "global-npmrc", "gitconfig"]) fs.writeFileSync(path.join(root, file), "", { flag: "wx", mode: 0o600 });
  return {
    ...env, HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"),
    TMPDIR: path.join(root, "tmp"), TMP: path.join(root, "tmp"), TEMP: path.join(root, "tmp"),
    XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache"),
    CLEAN_DEVELOPMENT_HOME: path.join(root, "home"), CLEAN_DEVELOPMENT_DATA_HOME: path.join(root, "product-data"),
    CLEAN_DEVELOPMENT_CONFIG_HOME: path.join(root, "product-config"),
    CODEX_HOME: path.join(root, "agent-codex"), CLAUDE_CONFIG_DIR: path.join(root, "agent-claude"), GROK_HOME: path.join(root, "agent-grok"),
    CARGO_HOME: path.join(root, "cargo-home"),
    npm_config_userconfig: path.join(root, "npmrc"), npm_config_globalconfig: path.join(root, "global-npmrc"),
    npm_config_cache: path.join(root, "npm-cache"), npm_config_offline: "true", npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"), GIT_TERMINAL_PROMPT: "0",
    TZ: "UTC", LC_ALL: "C", LANG: "C", CI: "1"
  };
}
