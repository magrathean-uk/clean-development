import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { resolveConfig } from "../src/config.js";
import { planSwiftpm } from "../src/swiftpm.js";

const cli = path.resolve("bin/clean-development.js");
const enabled = process.env.CLEAN_DEVELOPMENT_REAL_SWIFT === "1";
const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function files(root, relative = "", result = []) {
  if (!fs.existsSync(root)) return result;
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) files(root, name, result);
    else if (entry.isFile()) result.push(name);
  }
  return result;
}
function objects(root) {
  return Object.fromEntries(files(root).filter((file) => file.endsWith(".o") || path.basename(file) === "greeting")
    .map((file) => { const absolute = path.join(root, file); return [file, { sha256: hash(absolute), size: fs.statSync(absolute).size,
      mtimeNs: String(fs.statSync(absolute, { bigint: true }).mtimeNs) }]; }));
}
function packageFiles(directory, value) {
  for (const subdir of ["Sources/Greeting", "Sources/Hello", "Tests/GreetingTests"]) fs.mkdirSync(path.join(directory, subdir), { recursive: true });
  fs.writeFileSync(path.join(directory, "Package.swift"), `// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "GreetingFixture", products: [.executable(name: "greeting", targets: ["Hello"])],
  targets: [.target(name: "Greeting"), .executableTarget(name: "Hello", dependencies: ["Greeting"]),
    .testTarget(name: "GreetingTests", dependencies: ["Greeting"])])
`);
  fs.writeFileSync(path.join(directory, "Sources/Greeting/Greeting.swift"), `public func greeting() -> String { "${value}" }\n`);
  fs.writeFileSync(path.join(directory, "Sources/Hello/main.swift"), "import Greeting\nprint(greeting())\n");
  fs.writeFileSync(path.join(directory, "Tests/GreetingTests/GreetingTests.swift"), `import XCTest
@testable import Greeting
final class GreetingTests: XCTestCase { func testValue() { XCTAssertEqual(greeting(), "${value}") } }
`);
  fs.writeFileSync(path.join(directory, ".gitignore"), ".build/\n.swiftpm/\n*.zip\n");
}

test("REAL SwiftPM: build/test reuse, project switch, native precedence and retained deliverables", {
  skip: enabled ? false : "set CLEAN_DEVELOPMENT_REAL_SWIFT=1 to require the installed real Swift toolchain", timeout: 600000
}, async (t) => {
  assert.ok(["linux", "darwin"].includes(process.platform), "real fixture requires Linux/macOS with Swift, Git and unzip");
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cd-real-swiftpm-"))), identity = fs.statSync(root, { bigint: true });
  const home = path.join(root, "home"), retained = path.join(root, "retained"), storage = path.join(root, "disposable");
  const a = path.join(root, "A space", "checkout"), b = path.join(root, "B space", "checkout"), outputs = path.join(root, "deliverables");
  const nativeConfig = path.join(root, "native-config"), nativeSecurity = path.join(root, "native-security");
  for (const directory of [home, retained, storage, outputs, nativeConfig, nativeSecurity, path.join(root, "tmp")]) fs.mkdirSync(directory, { recursive: true });
  // Deliberately discard contributor credentials, preloads and Swift overrides.
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, CLEAN_DEVELOPMENT_HOME: home,
    CLEAN_DEVELOPMENT_CONFIG_HOME: path.join(root, "cd-config"), CLEAN_DEVELOPMENT_DATA_HOME: path.join(root, "cd-data"),
    XDG_CONFIG_HOME: path.join(home, "config"), XDG_CACHE_HOME: path.join(home, "cache"), XDG_DATA_HOME: path.join(home, "data"),
    TMPDIR: path.join(root, "tmp"), TMP: path.join(root, "tmp"), TEMP: path.join(root, "tmp"),
    GIT_CONFIG_GLOBAL: path.join(home, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", NO_COLOR: "1" };
  const nativePaths = ["--config-path", nativeConfig, "--security-path", nativeSecurity];
  const report = { schemaVersion: 1, kind: "real-swiftpm", status: "running", platform: process.platform, architecture: process.arch,
    node: process.version, swift: null, checks: [], observations: {}, limitations: [
      "Dependency-free packages; shared manifest-cache reuse, not downloaded dependency-cache acceptance.",
      "No Xcode, multi-root, plugin, cross-compilation or adversarial-filesystem acceptance.",
      "Durations are observations, not a benchmark. Test-lab teardown is separate from product retention."
    ] };
  let allPassed = false;
  function execute(command, args, { cwd = a, childEnv = env, expect = 0, label = args.slice(0, 2).join(" ") } = {}) {
    const start = performance.now();
    const result = spawnSync(command, args, { cwd, env: childEnv, encoding: "utf8", timeout: 120000, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 });
    report.checks.push({ label, exit: result.status, signal: result.signal, error: result.error?.code || null,
      durationMs: Math.round(performance.now() - start),
      stdoutSha256: crypto.createHash("sha256").update(result.stdout || "").digest("hex"),
      stderrSha256: crypto.createHash("sha256").update(result.stderr || "").digest("hex") });
    assert.equal(result.error, undefined, `${label}: ${result.error?.message}`);
    if (expect !== null) assert.equal(result.status, expect, `${label}: ${result.stderr}\n${result.stdout}`);
    return result;
  }
  const routed = (args, options = {}) => execute(process.execPath, [cli, "run", "--session", "session-only", "--", "swift", ...args], options);
  const native = (args, options = {}) => execute("swift", args, options);
  const buildArgs = (command = "build") => [command, ...nativePaths, "-j", "2"];
  const plan = (cwd = a) => planSwiftpm(["build"], { config: resolveConfig({ cwd, env }), cwd, env });
  function writeSettings(directory, optIn = true, relocate = true) {
    fs.writeFileSync(path.join(directory, ".clean-development.json"), JSON.stringify({ schemaVersion: 1,
      root: storage, tools: { swift: optIn }, ...(relocate ? { swiftpmWorkspaceRoot: retained } : {}) }));
  }
  function noDisposableProducts() {
    for (const directory of [path.join(storage, "builds"), path.join(storage, "scratch"), path.join(root, "cd-data/state/workspaces")]) assert.deepEqual(files(directory), []);
    for (const project of [a, b]) assert.equal(fs.existsSync(path.join(project, ".build")), false, "no local .build fallback");
  }
  async function phase(name, fn) {
    let failure;
    await t.test(name, () => { try { fn(); } catch (error) { failure = error; throw error; } });
    if (failure) throw failure; // Never publish a passed report after a failed child assertion.
  }
  try {
    packageFiles(a, "package-A"); writeSettings(a);
    report.swift = native(["--version"], { label: "real Swift version" }).stdout.trim(); assert.match(report.swift, /Swift version \d/);
    const git = (args) => execute("git", ["-c", "user.name=SwiftPM Fixture", "-c", "user.email=fixture@example.invalid", ...args], { label: `git ${args[0]}` });
    git(["init", "-q"]); git(["add", "."]); git(["commit", "-qm", "fixture"]);
    fs.mkdirSync(path.dirname(b)); git(["worktree", "add", "--detach", b, "HEAD"]);
    fs.writeFileSync(path.join(b, "Sources/Greeting/Greeting.swift"), 'public func greeting() -> String { "package-B" }\n');
    fs.writeFileSync(path.join(b, "Tests/GreetingTests/GreetingTests.swift"), fs.readFileSync(path.join(b, "Tests/GreetingTests/GreetingTests.swift"), "utf8").replaceAll("package-A", "package-B"));
    const names = ["Package.swift", ".clean-development.json", "Sources/Greeting/Greeting.swift", "Sources/Hello/main.swift", "Tests/GreetingTests/GreetingTests.swift"];
    const sourceHashes = (project) => Object.fromEntries(names.map((file) => [file, hash(path.join(project, file))]));
    const sources = { a: sourceHashes(a), b: sourceHashes(b) }, pa = plan(a), pb = plan(b);
    assert.notEqual(pa.workspace.id, pb.workspace.id);
    assert.equal(fs.existsSync(pa.scratch.path), false); assert.equal(fs.existsSync(pa.cache.path), false);
    await phase("cold build/test and warm reuse", () => {
      routed(buildArgs(), { label: "A cold build" });
      const bin = routed([...buildArgs(), "--show-bin-path"], { label: "A show-bin-path" }).stdout.trim();
      assert.ok(bin.startsWith(`${pa.scratch.path}${path.sep}`));
      const exe = path.join(bin, "greeting"); assert.ok(fs.statSync(exe).size > 0);
      assert.equal(execute(exe, [], { label: "execute actual A binary" }).stdout.trim(), "package-A");
      const cold = objects(pa.scratch.path); assert.ok(Object.keys(cold).some((file) => file.endsWith(".o")));
      routed(buildArgs(), { label: "A warm build" }); assert.deepEqual(objects(pa.scratch.path), cold);
      const xml = path.join(outputs, "qa results.xml");
      routed([...buildArgs("test"), "--parallel", "--xunit-output", xml], { label: "A cold test" });
      assert.match(fs.readFileSync(xml, "utf8"), /testsuite/);
      const tested = objects(pa.scratch.path);
      routed([...buildArgs("test"), "--skip-build"], { label: "A warm skip-build test" });
      assert.deepEqual(objects(pa.scratch.path), tested);
      const manifests = files(pa.cache.path).filter((file) => /manifest/i.test(file)); assert.ok(manifests.length > 0);
      report.observations.reusedObjectCount = Object.keys(cold).filter((file) => file.endsWith(".o")).length;
      report.observations.sharedManifestCacheFiles = manifests.length;
      report.observations.binaryASha256 = hash(exe); report.observations.xunitSha256 = hash(xml);
      noDisposableProducts();
    });
    await phase("A to B to A and nested package selection", () => {
      const before = objects(pa.scratch.path);
      routed([...buildArgs("test"), "--package-path", path.relative(a, b)], { label: "B tests selected from A" });
      const binB = routed(["build", ...nativePaths, `--package-path=${b}`, "--show-bin-path"], { label: "B show-bin-path" }).stdout.trim();
      assert.ok(binB.startsWith(`${pb.scratch.path}${path.sep}`));
      assert.equal(execute(path.join(binB, "greeting"), [], { label: "execute actual B binary" }).stdout.trim(), "package-B");
      const nestedDriver = path.join(root, "nested-driver.cjs");
      fs.writeFileSync(nestedDriver, `const {spawnSync}=require('node:child_process');
const result=spawnSync('swift',JSON.parse(process.argv[2]),{encoding:'utf8',timeout:60000});
if(result.error) throw result.error;
process.stdout.write(JSON.stringify({path:result.stdout.trim(),swiftPathEnvironment:process.env.SWIFTPM_BUILD_DIR||null}));
process.stderr.write(result.stderr);process.exit(result.status===null?1:result.status);\n`);
      const nestedResult = execute(process.execPath, [cli, "run", "--session", "session-only", "--", process.execPath,
        nestedDriver, JSON.stringify(["build", ...nativePaths, "--package-path", b, "--show-bin-path"])], { label: "nested process resolves B through installed Swift shim" });
      const nestedPath = JSON.parse(nestedResult.stdout); assert.equal(nestedPath.path, binB); assert.equal(nestedPath.swiftPathEnvironment, null);
      routed([...buildArgs("test"), "--skip-build"], { label: "return to A tests" }); assert.deepEqual(objects(pa.scratch.path), before);
      const nested = path.join(a, "Nested"); packageFiles(nested, "nested-package"); writeSettings(nested);
      const pn = plan(nested); assert.notEqual(pn.workspace.id, pa.workspace.id);
      routed(buildArgs("test"), { cwd: path.join(nested, "Sources"), label: "nested package test from descendant cwd" });
      assert.ok(files(pn.scratch.path).some((file) => file.endsWith(".o"))); assert.equal(fs.existsSync(path.join(nested, ".build")), false);
      report.observations.distinctPackageScratchDirectories = [pa.workspace.id, pb.workspace.id, pn.workspace.id];
      assert.deepEqual(sourceHashes(a), sources.a); assert.deepEqual(sourceHashes(b), sources.b); noDisposableProducts();
    });
    await phase("release binaries, archive bytes and explicit deliverables survive prune", () => {
      routed([...buildArgs(), "-c", "release"], { label: "A release build" });
      const bin = routed(["build", ...nativePaths, "-c", "release", "--show-bin-path"], { label: "release bin path" }).stdout.trim();
      assert.ok(bin.startsWith(`${pa.scratch.path}${path.sep}`)); const exe = path.join(bin, "greeting");
      assert.equal(execute(exe, [], { label: "execute release binary" }).stdout.trim(), "package-A");
      for (const name of ["native", "routed"]) fs.mkdirSync(path.join(outputs, name));
      // SwiftPM prefixes ZIP entries with the output basename. Compare the same
      // basename in different explicit directories, not differently named ZIPs.
      const directZip = path.join(outputs, "native", "source.zip"), routedZip = path.join(outputs, "routed", "source.zip");
      const archiveProject = path.join(root, "archive-control");
      // Use a standalone clone for archive comparison: SwiftPM 6.2.1's
      // non-repository archiver treats worktree .git files differently.
      git(["clone", "--no-hardlinks", a, archiveProject]);
      const archiveArgs = ["package", ...nativePaths, "--cache-path", path.join(root, "native-cache"), "archive-source"];
      native([...archiveArgs, "--output", directZip], { cwd: archiveProject, label: "native explicit source archive" });
      routed([...archiveArgs, "--output", path.relative(archiveProject, routedZip)], { cwd: archiveProject, label: "routed explicit source archive" });
      assert.ok(fs.statSync(directZip).size > 0); assert.equal(hash(directZip), hash(routedZip));
      const archiveNames = execute("unzip", ["-Z1", routedZip], { label: "archive inventory" }).stdout.trim().split(/\r?\n/);
      const archivedManifests = archiveNames.filter((name) => name === "Package.swift" || /^[^/]+\/Package\.swift$/.test(name));
      assert.equal(archivedManifests.length, 1);
      assert.equal(execute("unzip", ["-p", routedZip, archivedManifests[0]], { label: "archive manifest bytes" }).stdout, fs.readFileSync(path.join(a, "Package.swift"), "utf8"));
      native(archiveArgs, { cwd: archiveProject, label: "native default archive location" });
      const defaultZip = files(archiveProject).filter((file) => !file.includes(path.sep) && file.endsWith(".zip")); assert.equal(defaultZip.length, 1);
      const defaultHash = hash(path.join(archiveProject, defaultZip[0]));
      fs.renameSync(path.join(archiveProject, defaultZip[0]), path.join(outputs, "native-default-control.zip")); // fixture control, not product behaviour
      routed(archiveArgs, { cwd: archiveProject, label: "routed default archive location" });
      assert.equal(hash(path.join(archiveProject, defaultZip[0])), defaultHash);
      const before = objects(pa.scratch.path), delivered = Object.fromEntries(files(outputs).map((file) => [file, hash(path.join(outputs, file))]));
      execute(process.execPath, [cli, "prune", "--apply", "--older-than", "0", "--json"], { label: "explicit prune excludes all Swift products" });
      assert.deepEqual(objects(pa.scratch.path), before);
      assert.deepEqual(Object.fromEntries(files(outputs).map((file) => [file, hash(path.join(outputs, file))])), delivered);
      report.observations.releaseBinarySha256 = hash(exe); report.observations.archiveSha256 = hash(routedZip); noDisposableProducts();
    });
    await phase("native scratch/cache flags and environment precedence", () => {
      const explicit = path.join(root, "user scratch"), cache = path.join(root, "user cache"), envScratch = path.join(root, "env scratch");
      const args = ["build", ...nativePaths, "--scratch-path", explicit, "--cache-path", cache, "--show-bin-path"], before = objects(pa.scratch.path);
      assert.equal(routed(args, { label: "preserved scratch flag", childEnv: { ...env, CLEAN_DEVELOPMENT_FORCE: "1" } }).stdout,
        native(args, { label: "native scratch flag" }).stdout);
      const childEnv = { ...env, SWIFTPM_BUILD_DIR: envScratch, CLEAN_DEVELOPMENT_FORCE: "1" };
      const expected = native(args, { childEnv, label: "native environment precedence" }).stdout;
      assert.ok(expected.trim().startsWith(`${envScratch}${path.sep}`));
      assert.equal(routed(args, { childEnv, label: "preserved environment precedence" }).stdout, expected);
      const legacy = ["build", ...nativePaths, "--build-path", path.join(root, "legacy scratch"), "--scratch-path", explicit, "--cache-path", cache, "--show-bin-path"];
      assert.equal(routed(legacy, { label: "legacy alias with modern override" }).stdout, native(legacy, { label: "native legacy alias precedence" }).stdout);
      routed(["build", ...nativePaths, "--scratch-path", explicit, "--cache-path", cache, "-j", "2"], { label: "build to explicitly requested paths" });
      assert.ok(files(explicit).some((file) => file.endsWith(".o"))); assert.ok(files(cache).length > 0);
      assert.deepEqual(objects(pa.scratch.path), before); report.observations.nativePrecedenceMatched = true;
    });
    await phase("skip, disabled and cache-only modes leave native .build", () => {
      const before = objects(pa.scratch.path);
      for (const mode of ["skip", "disabled", "cache-only"]) {
        const project = path.join(root, mode); packageFiles(project, mode); writeSettings(project, mode !== "disabled", mode !== "cache-only");
        execute(process.execPath, [cli, "run", "--session", mode === "skip" ? "skip" : "session-only", "--", "swift", ...buildArgs(),
          ...(mode === "cache-only" ? [] : ["--cache-path", path.join(root, "control-cache")])], { cwd: project, label: `${mode} actual build` });
        assert.ok(files(path.join(project, ".build")).some((file) => file.endsWith(".o")));
        assert.equal(fs.existsSync(plan(project).scratch.path || path.join(retained, "not-created")), false);
      }
      assert.deepEqual(objects(pa.scratch.path), before); noDisposableProducts();
    });
    await phase("real compiler and test failures preserve nonzero status without fallback", () => {
      const broken = path.join(root, "broken"); packageFiles(broken, "broken"); writeSettings(broken);
      fs.writeFileSync(path.join(broken, "Sources/Greeting/Greeting.swift"), "this is not valid Swift\n");
      assert.notEqual(routed(buildArgs(), { cwd: broken, label: "real compiler failure", expect: null }).status, 0);
      assert.equal(fs.existsSync(path.join(broken, ".build")), false);
      fs.writeFileSync(path.join(broken, "Sources/Greeting/Greeting.swift"), 'public func greeting() -> String { "wrong" }\n');
      const result = routed(buildArgs("test"), { cwd: broken, label: "real test assertion failure", expect: null });
      assert.notEqual(result.status, 0); assert.match(result.stdout + result.stderr, /failed|failure/);
      assert.equal(fs.existsSync(path.join(broken, ".build")), false);
    });
    report.status = "passed"; allPassed = true;
  } finally {
    if (!allPassed) { report.status = "failed"; report.retainedFixture = root; }
    const evidence = process.env.CLEAN_DEVELOPMENT_SWIFT_EVIDENCE;
    if (evidence) { assert.ok(path.isAbsolute(evidence)); fs.writeFileSync(evidence, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 }); }
    t.diagnostic(JSON.stringify(report));
    if (allPassed) {
      const current = fs.lstatSync(root, { bigint: true });
      assert.ok(current.isDirectory() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino && fs.realpathSync.native(root) === root);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});
