import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { run, sha256, sourceInventory, readPackage, auditPackage, isolatedReleaseEnvironment } from "./release-audit-lib.mjs";

const root = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  console.log("Usage: node scripts/audit-release.mjs --output <new-directory-outside-checkout> [--ref <commit>]\nRequires a clean Git checkout, local preceding-release tag, Git, Node and npm. Runs both prepack gates, audits two tarballs, tests the exact candidate's installation, and runs npm run test:package. No network or publication. Evidence is retained; exit 2 means package upgrade is blocked by a missing tag.");
  process.exit(0);
}
const options = new Map();
for (let i = 0; i < args.length; i += 2) {
  assert.ok(["--output", "--ref"].includes(args[i]) && args[i + 1] && !options.has(args[i]), "Invalid/repeated audit option; use --help");
  options.set(args[i], args[i + 1]);
}
assert.ok(options.has("--output"), "--output is required; use --help");
assert.notEqual(process.platform, "win32", "This release driver requires a POSIX npm CLI; native Windows release reproduction is not established");
const requestedOutput = path.resolve(options.get("--output"));
const output = path.join(fs.realpathSync(path.dirname(requestedOutput)), path.basename(requestedOutput));
assert.ok(path.relative(root, output).startsWith(`..${path.sep}`) || path.relative(root, output) === "..", "Evidence must be outside the source checkout");
fs.mkdirSync(output, { mode: 0o700 }); // exclusive; never replace an existing report
const lab = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clean-development-release-audit-")));
const control = path.join(lab, "control");
fs.mkdirSync(control);
const controlEnv = isolatedReleaseEnvironment(control);
const redact = (text) => String(text).replaceAll(lab, "<lab>").replaceAll(root, "<source>").replaceAll(output, "<evidence>");
const write = (relative, value) => fs.writeFileSync(path.join(output, relative), typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
const invocationUmask = process.umask(0o022);
const report = { schema: 1, status: "failed", source: null, builds: [], comparison: null, install: null, packageLifecycle: null };
let complete = false;
try {
  const git = (args, cwd = root, env = controlEnv) => run("git", args, { cwd, env }).trim();
  assert.equal(git(["status", "--porcelain=v1", "--untracked-files=all"]), "", "Commit/stash source changes before auditing");
  const ref = options.get("--ref") || "HEAD";
  const commit = git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  const tree = git(["rev-parse", `${commit}^{tree}`]);
  const source = sourceInventory(root, controlEnv, commit);
  const publicSource = source.map(({ bytes, ...entry }) => entry);
  report.source = { commit, tree, gitVersion: git(["--version"]), trackedFiles: source.length, auditorCommit: git(["rev-parse", "HEAD"]), manifestSha256: sha256(JSON.stringify(publicSource)) };
  write("source-inventory.json", publicSource);

  const npmLink = (process.env.PATH || "").split(path.delimiter).map((part) => path.join(part, "npm"))
    .find((file) => { try { return fs.statSync(file).isFile(); } catch { return false; } });
  assert.ok(npmLink, "npm is required");
  const npmCli = fs.realpathSync(npmLink);
  assert.equal(path.basename(npmCli), "npm-cli.js", "Select a standard Node-installed npm CLI on PATH");
  const npmVersion = run(process.execPath, [npmCli, "--version"], { cwd: control, env: controlEnv }).trim();
  report.toolchain = {
    platform: process.platform, arch: process.arch, node: process.version, npm: npmVersion,
    zlib: process.versions.zlib, auditorSha256: sha256(fs.readFileSync(fileURLToPath(import.meta.url))), auditorLibrarySha256: sha256(fs.readFileSync(path.join(root, "scripts/release-audit-lib.mjs"))), nodeSha256: sha256(fs.readFileSync(process.execPath)), npmCliSha256: sha256(fs.readFileSync(npmCli))
  };
  const npm = (args, cwd, env, log, timeout = 180_000) => {
    try {
      const result = run(process.execPath, [npmCli, ...args], { cwd, env, timeout, returnResult: true });
      if (log) write(log, redact(`$ npm ${args.join(" ")}\nexit: ${result.status}\n${result.stdout}\n${result.stderr}`));
      return result.stdout;
    } catch (error) {
      if (log) write(log, redact(`${error.result?.stdout || ""}\n${error.result?.stderr || ""}\n${error.result?.error?.message || ""}`));
      throw error;
    }
  };
  const canaries = [root, lab, os.homedir()];
  const lanes = [];
  for (const [index, name] of ["a", "b"].entries()) {
    const lane = path.join(lab, name);
    fs.mkdirSync(lane);
    const env = isolatedReleaseEnvironment(lane);
    env.TZ = index ? "Pacific/Honolulu" : "UTC";
    const checkout = path.join(lane, index ? "different checkout name" : "checkout");
    // No shared object store, inherited gitconfig, checkout filters or checkout hooks.
    const checkoutMask = process.umask(index ? 0o077 : 0o022);
    try {
      git(["-c", "core.hooksPath=/dev/null", "clone", "--no-hardlinks", "--no-checkout", "--quiet", root, checkout], control, env);
      git(["-c", "core.hooksPath=/dev/null", "-c", "core.autocrlf=false", "checkout", "--quiet", "--detach", commit], checkout, env);
    } finally { process.umask(checkoutMask); }
    const stamp = index ? 1_735_689_600 : 946_684_800;
    for (const entry of source) {
      const file = path.join(checkout, entry.path);
      assert.ok(fs.readFileSync(file).equals(entry.bytes), "Checkout differs from committed blob");
      fs.chmodSync(file, entry.mode === "100755" ? 0o755 : 0o644);
      fs.utimesSync(file, stamp, stamp);
    }
    assert.equal(git(["status", "--porcelain=v1", "--untracked-files=all"], checkout, env), "", "Build input checkout must be clean");
    const marker = `RELEASE_AUDIT_CANARY_${crypto.randomUUID()}`;
    canaries.push(marker);
    // Synthetic credentials/configuration outside the source must never be copied.
    for (const relative of ["home/.ssh/id_ed25519", "home/.aws/credentials", "agent-codex/auth.json", "agent-claude/settings.json"]) {
      const file = path.join(lane, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, relative.endsWith(".json") ? `${JSON.stringify({ releaseAuditCanary: marker })}\n` : `${marker}\n`, { mode: 0o600 });
    }
    const artifactDir = path.join(output, name);
    fs.mkdirSync(artifactDir, { mode: 0o700 });
    const oldMask = process.umask(0o022);
    try {
      // Ordinary npm pack: prepack really executes check + test in EACH checkout.
      npm(["pack", "--pack-destination", artifactDir], checkout, env, `${name}/prepack.log`, 240_000);
    } finally { process.umask(oldMask); }
    assert.equal(git(["status", "--porcelain=v1", "--untracked-files=all"], checkout, env), "", "Packing changed the checkout");
    const names = fs.readdirSync(artifactDir).filter((file) => file.endsWith(".tgz"));
    assert.equal(names.length, 1, "Expected exactly one npm tarball");
    const tarball = path.join(artifactDir, names[0]);
    const bytes = fs.readFileSync(tarball);
    const archive = readPackage(bytes);
    const audit = auditPackage(source, archive, canaries);
    write(`${name}/inventory.json`, audit.inventory);
    const build = { lane: name, artifact: `${name}/${names[0]}`, bytes: bytes.length, sha256: sha256(bytes), tarSha256: archive.tarSha256, gzipHeader: archive.gzipHeader, files: audit.inventory.length, prepack: "passed", cleanAfterPack: true, filesystemMtime: stamp, checkoutUmask: index ? "077" : "022", prepackUmask: "022", timezone: env.TZ };
    report.builds.push(build);
    lanes.push({ checkout, env, tarball, bytes, audit });
  }
  const [a, b] = lanes;
  report.comparison = { compressedEqual: a.bytes.equals(b.bytes), payloadInventoryEqual: JSON.stringify(a.audit.inventory) === JSON.stringify(b.audit.inventory), scope: "Same recorded OS/architecture/Node/npm/zlib; paths, mtimes, timezone, checkout umask, homes and caches varied; Git file modes and prepack umask 022 fixed." };
  assert.ok(report.comparison.compressedEqual && report.comparison.payloadInventoryEqual, "Tarballs are not byte-for-byte reproducible; retain both for comparison");
  write("source-to-package.json", a.audit.inventory.map(({ path, source, sourceBlob, sourceSha256, sha256, inclusion }) => ({ source, sourceBlob, sourceSha256, packagePath: `package/${path}`, packageSha256: sha256, inclusion, transform: "none; exact source bytes" })));
  write("excluded-files.json", a.audit.excluded);
  write("versions.json", { expected: a.audit.version, files: a.audit.versions, packageLockTopAndRoot: "matched", bugTemplate: "matched" });
  write("privacy.json", { ...a.audit.privacy, inputEnvironment: "explicit allowlist, no ambient credentials/configuration", syntheticHostFixtures: 8, sourceFilesCopiedFrom: "Git objects only", limitation: "No finite pattern scan proves absence of unknown/encoded secrets. Trusted source/toolchain required; HOME isolation is not a sandbox." });

  // Install the actual hashed artifact, not another pack or the source directory.
  const installRoot = path.join(lab, "install");
  fs.mkdirSync(installRoot);
  const installEnv = isolatedReleaseEnvironment(installRoot);
  installEnv.CLEAN_DEVELOPMENT_ROOT = path.join(installRoot, "managed");
  const prefix = path.join(installRoot, "prefix");
  npm(["install", "--prefix", prefix, "--no-audit", "--no-fund", a.tarball], installRoot, installEnv, "install.log");
  for (const name of ["CLEAN_DEVELOPMENT_DATA_HOME", "CLEAN_DEVELOPMENT_CONFIG_HOME", "CLEAN_DEVELOPMENT_ROOT"]) assert.equal(fs.existsSync(installEnv[name]), false, "npm installation must be inert");
  const binary = path.join(prefix, "node_modules", ".bin", "clean-development");
  assert.equal(run(binary, ["--version"], { cwd: installRoot, env: installEnv }).trim(), a.audit.version);
  run(process.execPath, ["--input-type=module", "--eval", "const p=await import('clean-development'); const a=await import('clean-development/api'); if(typeof p.default!=='function'||typeof a.planSession!=='function') throw Error('Bad exports');"], { cwd: prefix, env: installEnv });
  const codexFile = path.join(installEnv.CODEX_HOME, "config.toml");
  const original = "# unrelated release-audit sentinel\n";
  fs.writeFileSync(codexFile, original);
  const cli = (args) => JSON.parse(run(binary, [...args, "--json"], { cwd: installRoot, env: installEnv }));
  const setup = cli(["setup", "--agents", "codex"]);
  assert.equal(setup.runtime.version, a.audit.version);
  const launcher = path.join(installEnv.CLEAN_DEVELOPMENT_DATA_HOME, "bin", "clean-development");
  assert.equal(run(launcher, ["--version"], { cwd: installRoot, env: installEnv }).trim(), a.audit.version);
  assert.equal(cli(["status"]).runtime.status, "installed");
  const sentinel = path.join(installEnv.CLEAN_DEVELOPMENT_ROOT, "keep.txt");
  fs.writeFileSync(sentinel, "managed artifact must survive uninstall\n");
  const removed = cli(["uninstall"]);
  assert.equal(removed.runtime.retained.length, 0);
  assert.equal(fs.existsSync(launcher), false);
  assert.equal(fs.readFileSync(codexFile, "utf8"), original);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "managed artifact must survive uninstall\n");
  npm(["uninstall", "--prefix", prefix, "--no-audit", "--no-fund", "clean-development"], installRoot, installEnv, "npm-uninstall.log");
  assert.equal(fs.existsSync(binary), false);
  assert.equal(fs.existsSync(path.join(prefix, "node_modules", "clean-development")), false);
  report.install = { artifactSha256: report.builds[0].sha256, inertInstall: true, exports: "passed", setup: "passed", managedLauncherVersion: a.audit.version, uninstall: "passed", unrelatedConfigAndManagedArtifact: "unchanged", npmUninstall: "passed" };

  // Leave the existing package gate intact (including its real preceding-tag requirement).
  const verifier = fs.readFileSync(path.join(a.checkout, "scripts/verify-package.mjs"), "utf8");
  const previous = verifier.match(/const previousRelease = "([^"]+)";/)?.[1];
  assert.ok(previous, "Review changed preceding-release selection");
  let previousCommit = null;
  try { previousCommit = git(["rev-parse", "--verify", `${previous}^{commit}`], a.checkout, a.env); } catch { /* actual package command below must report the prerequisite */ }
  try {
    npm(["run", "test:package"], a.checkout, a.env, "package-lifecycle.log", 180_000);
    assert.ok(previousCommit, "Upgrade pass without a preceding release commit");
    report.packageLifecycle = { status: "passed", previousRelease: previous, previousCommit, command: "npm run test:package", boundary: "Real tagged preceding source packed locally, not registry-artifact equivalence or live-host acceptance." };
  } catch (error) {
    if (previousCommit) throw error;
    report.packageLifecycle = { status: "blocked", previousRelease: previous, previousCommit: null, reason: "Preceding-release Git tag unavailable; no synthetic substitute accepted.", command: "npm run test:package" };
  }
  report.status = report.packageLifecycle.status === "passed" ? "passed" : "blocked";
  write("SHA256SUMS", report.builds.map((build) => `${build.sha256}  ${build.artifact}\n`).join(""));
  write("report.json", report);
  console.log(`Release audit ${report.status}: ${output}`);
  process.exitCode = report.status === "passed" ? 0 : 2;
  complete = true;
} catch (error) {
  report.error = redact(error.message);
  write("report.json", report);
  console.error(`Release audit failed: ${report.error}\nEvidence: ${output}\nDisposable lab retained: ${lab}`);
  process.exitCode = 1;
} finally {
  // Only this invocation's freshly created disposable lab; never the checkout or evidence.
  process.umask(invocationUmask);
  if (complete) fs.rmSync(lab, { recursive: true, force: true });
}
