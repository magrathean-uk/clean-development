import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { isolatedEnvironment } from "../scripts/harness-utils.mjs";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const packageJson = JSON.parse(fs.readFileSync(path.join(sourceRoot, "package.json"), "utf8"));

function fixture(t) {
  // npm 10.5's generated .cmd uses unquoted SET dp0=%~dp0: an ampersand in
  // its install prefix fails inside npm's wrapper before our CLI can execute.
  // Keep that prefix plain on Windows; retain adversarial source/cwd names and
  // the managed-launcher argv/cwd checks without bypassing npm's real .cmd.
  const prefix = process.platform === "win32" ? "clean-development-package-test-" : "clean-development package & = é-test-";
  const temporary = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "source & = é");
  fs.mkdirSync(root);
  for (const relative of [...packageJson.files, "package.json", "scripts/verify-package.mjs", "scripts/harness-utils.mjs", "scripts/npm-pack-report.mjs"]) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(path.join(sourceRoot, relative), target, { recursive: true });
  }
  const env = isolatedEnvironment(temporary);
  for (const name of Object.keys(env)) {
    if (/^(npm_config_|git_)/i.test(name) || ["NODE_PATH", "NODE_TEST_CONTEXT"].includes(name)) delete env[name];
  }
  for (const name of ["HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "APPDATA", "LOCALAPPDATA"]) {
    env[name] = path.join(temporary, name.toLowerCase());
    fs.mkdirSync(env[name]);
  }
  const npmrc = path.join(temporary, "npmrc");
  fs.writeFileSync(npmrc, "");
  const globalNpmrc = path.join(temporary, "global-npmrc");
  fs.writeFileSync(globalNpmrc, "");
  Object.assign(env, {
    npm_config_cache: path.join(temporary, "npm-cache"),
    npm_config_userconfig: npmrc,
    npm_config_globalconfig: globalNpmrc,
    npm_config_offline: "true",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(temporary, "gitconfig")
  });
  const run = (command, args) => spawnSync(command, args, {
    cwd: root, env, encoding: "utf8", timeout: 60000, maxBuffer: 2 * 1024 * 1024
  });
  const git = (args) => {
    const result = run("git", args);
    assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  };
  // Synthetic history tests the verifier, NOT compatibility with the real release.
  // Never create or replace a release tag in the contributor's checkout.
  const manifest = path.join(root, "package.json");
  const constants = path.join(root, "src", "constants.js");
  const originalManifest = fs.readFileSync(manifest, "utf8");
  const originalConstants = fs.readFileSync(constants, "utf8");
  fs.writeFileSync(manifest, JSON.stringify({ ...packageJson, version: "0.2.0" }));
  fs.writeFileSync(constants, originalConstants.replace(`VERSION = "${packageJson.version}"`, 'VERSION = "0.2.0"'));
  git(["init", "--quiet"]);
  git(["add", "."]);
  git(["-c", "user.name=Package Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Synthetic package fixture, not a release"]);
  git(["-c", "tag.gpgsign=false", "tag", "v0.2.0"]);
  fs.writeFileSync(manifest, originalManifest);
  fs.writeFileSync(constants, originalConstants);
  return { root, run: () => run(process.execPath, [path.join(root, "scripts", "verify-package.mjs")]) };
}

// Native host execution is required: POSIX success does not establish Windows
// .cmd acceptance. The verifier also checks argv/cwd through installed tool shims.
test("package verification exercises installed tool shims", async (t) => {
  const item = fixture(t);
  await t.test("a complete tarball passes the synthetic lifecycle fixture", () => {
    const result = item.run();
    assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
    assert.match(result.stdout, /Verified clean-development-/);
  });
  await t.test("an npmignore rule cannot hide the tool-shim entry point", () => {
    const ignore = path.join(item.root, "bin", ".npmignore");
    fs.writeFileSync(ignore, "clean-development-shim.js\n");
    try {
      const result = item.run();
      assert.notEqual(result.status, 0, "verifier accepted a tarball without the installed tool-shim entry point");
      assert.match(result.stderr, /tarball is missing bin\/clean-development-shim\.js/);
    } finally {
      fs.unlinkSync(ignore);
    }
  });
  await t.test("an included but broken tool shim cannot pass on receipts alone", () => {
    const shim = path.join(item.root, "bin", "clean-development-shim.js");
    fs.writeFileSync(shim, "#!/usr/bin/env node\nprocess.exitCode = 86;\n");
    const result = item.run();
    assert.notEqual(result.status, 0, "verifier accepted an installed tool shim that exits unsuccessfully");
    assert.match(result.stderr, /cargo.*failed:/);
  });
});
