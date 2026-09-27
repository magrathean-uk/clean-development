import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Operator-driven Codex App protocol. Never launches Codex CLI or certifies GUI
// provenance from an environment variable, a subprocess ancestor, or an exit 0.
const self = fileURLToPath(import.meta.url);
const repository = path.resolve(path.dirname(self), "../..");
const cli = path.join(repository, "bin/clean-development.js");
const kind = "codex-app-acceptance-fixture";
const policies = ["allow", "deny-data", "deny-managed"];
const stages = ["initial", "native-skip", "routed", "nested-cwd", "changed-cwd", "worktree", "routed-skip", "resumed", "sandbox"];
const sourceFiles = ["Cargo.toml", "Cargo.lock", "src/main.rs"];
const observedKeys = ["HOME", "CODEX_HOME", "CLEAN_DEVELOPMENT_HOME", "CLEAN_DEVELOPMENT_CONFIG_HOME", "CLEAN_DEVELOPMENT_DATA_HOME", "CLEAN_DEVELOPMENT_SESSION_MODE", "CARGO_HOME", "CARGO_TARGET_DIR", "CARGO_BUILD_TARGET_DIR", "CD_APP_ACCEPTANCE_EPOCH", "PATH"];
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
function write(file, contents) {
  fs.writeFileSync(file, contents, { flag: "wx", mode: 0o600 });
}
function writeJson(file, value) { write(file, `${JSON.stringify(value, null, 2)}\n`); }
function execute(command, args, cwd, env, timeout = 120_000) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout, maxBuffer: 2 * 1024 * 1024 });
  return { command, args, cwd, exitCode: result.status, signal: result.signal, error: result.error?.code || null, stdout: result.stdout || "", stderr: result.stderr || "" };
}
function checked(command, args, cwd, env) {
  const result = execute(command, args, cwd, env, 30_000);
  assert.equal(result.error, null, JSON.stringify(result));
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  return result.stdout.trim();
}
function executable(name, env = process.env) {
  for (const directory of String(env.PATH || "").split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, name);
    try { fs.accessSync(candidate, fs.constants.X_OK); if (fs.statSync(candidate).isFile()) return candidate; } catch { /* absent */ }
  }
  return null;
}
function identity() {
  const top = execute("git", ["rev-parse", "--show-toplevel"], repository, process.env, 10_000);
  const exact = top.exitCode === 0 && fs.realpathSync(top.stdout.trim()) === fs.realpathSync(repository);
  const head = exact ? execute("git", ["rev-parse", "--verify", "HEAD"], repository, process.env, 10_000) : null;
  const files = ["package.json", ...["src", "bin"].flatMap((directory) => fs.readdirSync(path.join(repository, directory)).filter((name) => name.endsWith(".js")).map((name) => `${directory}/${name}`))].sort();
  return {
    commit: head?.exitCode === 0 ? head.stdout.trim() : null,
    runtimeFingerprint: sha(files.map((name) => `${name}\0${sha(fs.readFileSync(path.join(repository, name)))}\n`).join("")),
    fingerprintScope: "package.json and direct src/*.js, bin/*.js contents; not entire Git tree",
    fixtureSha256: sha(fs.readFileSync(self))
  };
}
function preflight(bundle) {
  const result = {
    kind, at: new Date().toISOString(), source: identity(),
    machine: { platform: process.platform, arch: process.arch, release: os.release(), node: process.version },
    app: null, cargo: executable("cargo"), rustc: executable("rustc"),
    appAcceptance: "BLOCKED", reasons: ["No independently reviewed isolated App session/transcript is attached."]
  };
  if (process.platform === "darwin" && bundle) {
    const plist = path.join(fs.realpathSync(bundle), "Contents/Info.plist");
    const value = (key) => checked("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist], repository, process.env);
    const binary = path.join(path.dirname(plist), "MacOS", value("CFBundleExecutable"));
    result.app = { bundle: fs.realpathSync(bundle), version: value("CFBundleShortVersionString"), build: value("CFBundleVersion"), binary, binarySha256: sha(fs.readFileSync(binary)) };
    result.machine.osVersion = checked("/usr/bin/sw_vers", ["-productVersion"], repository, process.env);
  } else result.reasons.push("No installed macOS App bundle supplied on an accessible macOS host; CLI version is not an App version.");
  if (!result.cargo || !result.rustc) result.reasons.push("An installed offline Rust toolchain is unavailable on PATH.");
  return result;
}
function environment(root, ambient = process.env) {
  const tools = [process.execPath, ...["git", "cargo", "rustc"].map((name) => executable(name, ambient)).filter(Boolean)];
  const env = {
    PATH: [...new Set([...tools.map((file) => path.dirname(file)), "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(path.delimiter),
    HOME: path.join(root, "home"), SHELL: "/bin/bash", LANG: "C", TMPDIR: path.join(root, "tmp"),
    CLEAN_DEVELOPMENT_HOME: path.join(root, "home"), CLEAN_DEVELOPMENT_DATA_HOME: path.join(root, "data"), CLEAN_DEVELOPMENT_CONFIG_HOME: path.join(root, "config"),
    CODEX_HOME: path.join(root, "codex"), CLAUDE_CONFIG_DIR: path.join(root, "claude"), GROK_HOME: path.join(root, "grok"),
    XDG_CONFIG_HOME: path.join(root, "xdg-config"), XDG_DATA_HOME: path.join(root, "xdg-data"), XDG_CACHE_HOME: path.join(root, "xdg-cache"),
    CARGO_HOME: path.join(root, "cargo-home"), CARGO_NET_OFFLINE: "true", RUSTUP_AUTO_INSTALL: "0",
    RUSTUP_HOME: ambient.RUSTUP_HOME || path.join(os.homedir(), ".rustup"),
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"), GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Acceptance fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Acceptance fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid"
  };
  return env; // Deliberately do not spread ambient credentials, npm state or routing.
}
function tree(directory) {
  if (!fs.existsSync(directory)) return {};
  const files = {}, pending = [directory];
  let entries = 0, bytes = 0;
  while (pending.length) {
    const current = pending.pop();
    assert.ok(++entries <= 10_000, "Fixture inventory limit exceeded; not a complete scan");
    const stat = fs.lstatSync(current);
    assert.ok(!stat.isSymbolicLink(), `Refusing symlink in fixture inventory: ${current}`);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) pending.push(path.join(current, entry));
    } else {
      assert.ok(stat.isFile(), "Only regular fixture files may be inventoried");
      bytes += stat.size;
      assert.ok(bytes <= 256 * 1024 * 1024, "Fixture hash budget exceeded; not a complete inventory");
      const hash = crypto.createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
      const fd = fs.openSync(current, "r");
      try { let count; while ((count = fs.readSync(fd, buffer)) > 0) hash.update(buffer.subarray(0, count)); }
      finally { fs.closeSync(fd); }
      files[path.relative(directory, current)] = { bytes: stat.size, sha256: hash.digest("hex"), mtimeMs: stat.mtimeMs };
    }
  }
  return files;
}
function snapshotSources(lab) {
  return Object.fromEntries(Object.entries(lab.projects).map(([name, directory]) => [name,
    Object.fromEntries(sourceFiles.map((file) => [file, sha(fs.readFileSync(path.join(directory, file)))]))]));
}
function records(lab) {
  const directory = path.join(lab.root, "data/state/workspaces");
  if (!fs.existsSync(directory)) return [];
  assert.ok(fs.readdirSync(directory).length <= 100, "Unexpected registry size");
  return fs.readdirSync(directory).sort().map((file) => {
    const target = path.join(directory, file);
    assert.ok(fs.lstatSync(target).isFile(), "Non-regular registry entry");
    return { sha256: sha(fs.readFileSync(target)), ...json(target) };
  });
}
function load(root) {
  root = path.resolve(root);
  assert.equal(fs.realpathSync(root), root, "Use the canonical fixture root, not a symlink");
  const marker = path.join(root, "fixture.json");
  assert.ok(fs.lstatSync(marker).isFile(), "Fixture marker must be regular");
  const lab = json(marker);
  assert.equal(lab.kind, kind); assert.equal(lab.root, root); assert.ok(policies.includes(lab.policy));
  assert.equal(lab.uid, process.getuid?.() ?? null, "Run as the same disposable OS account that prepared the fixture");
  for (const directory of ["home", "data", "config", "codex", "managed", "forbidden", "projects"]) {
    assert.equal(fs.realpathSync(path.join(root, directory)), path.join(root, directory), "Fixture directory was replaced");
  }
  for (const project of Object.values(lab.projects)) {
    assert.ok(inside(path.join(root, "projects"), project)); assert.equal(fs.realpathSync(project), project);
  }
  assert.deepEqual(identity(), lab.source, "Source/fixture changed since preparation; use a fresh lab");
  return lab;
}
function prepare(requested, policy) {
  assert.ok(process.platform !== "win32", "Preparation requires macOS or Linux; this is a macOS App protocol");
  assert.ok(policies.includes(policy), "Policy must be allow, deny-data or deny-managed");
  assert.ok(path.isAbsolute(requested), "Output must be absolute");
  assert.equal(fs.realpathSync(path.dirname(requested)), path.dirname(requested), "Output parent must be canonical");
  assert.ok(!inside(repository, requested) && requested !== repository, "Keep lab outside the source checkout");
  fs.mkdirSync(requested, { mode: 0o700 }); // Exclusive; no reuse or recursive deletion.
  const root = fs.realpathSync(requested), env = environment(root);
  for (const dir of ["home", "tmp", "data", "config", "codex", "claude", "grok", "xdg-config", "xdg-data", "xdg-cache", "cargo-home", "managed", "forbidden", "projects"]) fs.mkdirSync(path.join(root, dir), { mode: 0o700 });
  write(path.join(root, "gitconfig"), "");
  const projects = {};
  const manifest = '[package]\nname = "cd_app_fixture"\nversion = "0.0.0"\nedition = "2021"\n';
  const lock = 'version = 3\n\n[[package]]\nname = "cd_app_fixture"\nversion = "0.0.0"\n';
  for (const name of ["a", "b", "native-skip", "routed-skip", "sandbox"]) {
    const project = projects[name] = path.join(root, "projects", name);
    fs.mkdirSync(project); fs.mkdirSync(path.join(project, "src"));
    write(path.join(project, "Cargo.toml"), manifest); write(path.join(project, "Cargo.lock"), lock);
    write(path.join(project, "src/main.rs"), 'fn main() { println!("fixture=42"); }\n#[test] fn addition() { assert_eq!(40 + 2, 42); }\n');
    checked("git", ["-c", "init.defaultBranch=fixture", "init", "-q"], project, env);
    checked("git", ["add", "--", ...sourceFiles], project, env);
    checked("git", ["-c", "commit.gpgsign=false", "commit", "-qm", "Disposable offline App fixture"], project, env);
  }
  projects.worktree = path.join(root, "projects", "worktree");
  checked("git", ["worktree", "add", "--detach", projects.worktree, "HEAD"], projects.a, env);
  const writableRoots = [...Object.values(projects), env.CARGO_HOME, env.TMPDIR,
    ...(policy === "deny-data" ? [] : [env.CLEAN_DEVELOPMENT_DATA_HOME]),
    ...(policy === "deny-managed" ? [] : [path.join(root, "managed")])];
  write(path.join(root, "codex/config.toml"), `approval_policy = "never"\nsandbox_mode = "workspace-write"\n\n[sandbox_workspace_write]\nnetwork_access = false\nexclude_tmpdir_env_var = true\nexclude_slash_tmp = true\nwritable_roots = ${JSON.stringify(writableRoots)}\n`);
  const setup = execute(process.execPath, [cli, "setup", "--root", path.join(root, "managed"), "--agents", "codex", "--json"], projects.a, env, 30_000);
  writeJson(path.join(root, "setup.json"), setup);
  assert.equal(setup.error, null); assert.equal(setup.exitCode, 0, setup.stderr);
  const receipt = json(path.join(root, "data/state/integrations.json"));
  assert.ok(receipt.integrations.some((entry) => entry.agent === "codex" && entry.mode === "native-shell-environment"), "Setup fell back to CLI: not native App acceptance");
  const lab = { kind, schemaVersion: 1, root, policy, uid: process.getuid?.() ?? null, preparedAt: new Date().toISOString(), source: identity(), projects, env, writableRoots, appAcceptance: "NOT_RUN" };
  lab.sources = snapshotSources(lab);
  lab.configSha256 = sha(fs.readFileSync(path.join(root, "codex/config.toml")));
  writeJson(path.join(root, "fixture.json"), lab);
  const assignments = Object.entries(env).map(([key, value]) => `${key}=${quote(value)}`).join(" ");
  write(path.join(root, "launch.sh"), `#!/bin/sh
set -eu
[ "$#" -eq 3 ] && [ "$1" = --disposable-desktop-account ] || { echo 'Require --disposable-desktop-account ABS_APP_EXECUTABLE EPOCH(1|2)' >&2; exit 2; }
[ "$(uname -s)" = Darwin ] || { echo 'macOS App launch only; do not substitute Codex CLI' >&2; exit 2; }
case "$2" in /*.app/Contents/MacOS/*) ;; *) echo 'Use the actual installed App executable' >&2; exit 2 ;; esac
case "$3" in 1|2) ;; *) exit 2 ;; esac
# This acknowledgement is NOT OS isolation: the operator must establish a fresh
# desktop account/VM and close its existing App processes first. No auto-kill.
exec /usr/bin/env -i ${assignments} CD_APP_ACCEPTANCE_EPOCH="$3" "$2"
`);
  fs.chmodSync(path.join(root, "launch.sh"), 0o700);
  return { root, policy, projects, writableRoots, source: lab.source, appAcceptance: "NOT_RUN", next: "Read docs/codex-app-acceptance.md; do not use Codex CLI as a substitute." };
}
function selectedEnvironment() { return Object.fromEntries(observedKeys.map((key) => [key, process.env[key] ?? null])); }
function ensureEnvironment(lab) {
  const homes = { HOME: "home", CODEX_HOME: "codex", CLEAN_DEVELOPMENT_HOME: "home", CLEAN_DEVELOPMENT_DATA_HOME: "data", CLEAN_DEVELOPMENT_CONFIG_HOME: "config", CARGO_HOME: "cargo-home" };
  for (const [key, directory] of Object.entries(homes)) assert.equal(process.env[key], path.join(lab.root, directory), `Unexpected ${key}; refusing to run against non-fixture configuration`);
  assert.ok(Object.values(lab.projects).some((project) => process.cwd() === project || process.cwd() === path.join(project, "src")), "Child command must stay in a generated fixture project");
  for (const key of ["CLEAN_DEVELOPMENT_ROOT", "CLEAN_DEVELOPMENT_BUILD_ROOT", "CLEAN_DEVELOPMENT_CACHE_ROOT", "CLEAN_DEVELOPMENT_SCRATCH_ROOT", "CARGO_TARGET_DIR", "CARGO_BUILD_TARGET_DIR"]) assert.equal(process.env[key], undefined, `Unexpected override ${key}`);
  assert.equal(sha(fs.readFileSync(path.join(lab.root, "codex/config.toml"))), lab.configSha256, "Host configuration changed; do not silently accept a different policy");
}
function expectedCwd(lab, stage) {
  return stage === "nested-cwd" ? path.join(lab.projects.a, "src") : lab.projects[stage === "changed-cwd" ? "b" : stage] || lab.projects.a;
}
function cargoResult(lab) {
  ensureEnvironment(lab);
  const version = execute("cargo", ["--version"], process.cwd(), process.env, 10_000);
  const result = execute("cargo", ["test", "--offline", "--locked", "--message-format=json"], process.cwd(), process.env);
  return { environment: selectedEnvironment(), version, ...result };
}
function probe(lab, name) {
  const file = path.join(lab.root, name, `.app-acceptance-${crypto.randomUUID()}`);
  try { write(file, "sandbox write probe\n"); return { name, file, writable: true, error: null }; }
  catch (error) { return { name, file, writable: false, error: error.code }; }
}
function artifactEvidence(stdout, allowedRoot) {
  const result = [];
  for (const line of stdout.split(/\r?\n/)) {
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.reason !== "compiler-artifact" || !message.executable || message.profile?.test !== true || message.target?.name !== "cd_app_fixture") continue;
    const file = message.executable;
    assert.ok(path.isAbsolute(file) && inside(allowedRoot, file) && inside(allowedRoot, fs.realpathSync(file)), "Artifact escaped the intended fixture destination");
    const stat = fs.lstatSync(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0, "Cargo artifact must be a non-empty real file");
    result.push({ file: fs.realpathSync(file), bytes: stat.size, sha256: sha(fs.readFileSync(file)), fresh: message.fresh });
  }
  return result;
}
function inspect(lab, report) {
  const checks = [], check = (name, pass) => checks.push({ name, pass: Boolean(pass) });
  const { stage } = report, skip = ["native-skip", "routed-skip"].includes(stage), denied = stage === "sandbox" && lab.policy !== "allow";
  check("native shell resolves the recorded stable cargo shim", report.shellCargo === path.join(lab.root, "data/bin/cargo"));
  check("native shell resolves the recorded stable CLI", report.shellCli === path.join(lab.root, "data/bin/clean-development"));
  check("native entry defaults to skip", report.environment.CLEAN_DEVELOPMENT_SESSION_MODE === "skip");
  check("launch epoch is fresh (resumed requires second launch)", report.environment.CD_APP_ACCEPTANCE_EPOCH === (stage === "resumed" ? "2" : "1"));
  check("source fixture files unchanged", JSON.stringify(snapshotSources(lab)) === JSON.stringify(lab.sources));
  check("no project config persistence", Object.values(lab.projects).every((project) => !fs.existsSync(path.join(project, ".clean-development.json"))));
  const routedProjects = [lab.projects.a, lab.projects.b, lab.projects.worktree, lab.projects.sandbox];
  check("no target in any routed project or nested cwd", [...routedProjects, path.join(lab.projects.a, "src")].every((project) => !fs.existsSync(path.join(project, "target"))));
  if (stage === "initial") return checks;
  check("installed Cargo and rustc respond before the build", report.toolVersions.every((item) => item.exitCode === 0 && !item.error && !item.signal));
  check("child completed without timeout/output limit/signal", report.command.error === null && report.command.signal === null);
  check(denied ? "denied route fails instead of falling back" : "Cargo test succeeds", denied ? report.command.exitCode !== null && report.command.exitCode !== 0 : report.command.exitCode === 0);
  if (denied) check("failure reports a permission boundary", /EACCES|EPERM|permission denied|operation not permitted|read.only file/i.test(`${report.command.stderr}\n${report.child?.stderr || ""}`));
  if (skip) {
    check("skip leaves managed artifacts unchanged", JSON.stringify(report.managedBefore) === JSON.stringify(tree(path.join(lab.root, "managed"))));
    check("skip leaves workspace ownership records unchanged", JSON.stringify(report.recordsBefore) === JSON.stringify(records(lab)));
  }
  if (!denied) {
    check("real Cargo reported a test executable", report.artifacts.length > 0);
    check("each artifact is in the intended destination", report.artifacts.every((item) => inside(skip ? path.join(expectedCwd(lab, stage), "target") : path.join(lab.root, "managed/builds"), item.file)));
    check("child received the intended session choice", report.child?.environment.CLEAN_DEVELOPMENT_SESSION_MODE === (skip ? "skip" : "session-only"));
    check("child has no static Cargo target override", report.child?.environment.CARGO_TARGET_DIR === null && report.child?.environment.CARGO_BUILD_TARGET_DIR === null);
    if (!skip) {
      const workspace = stage === "nested-cwd" ? lab.projects.a : expectedCwd(lab, stage);
      const matches = records(lab).filter((entry) => entry.workspace === workspace);
      check("exact workspace ownership record exists", matches.length === 1);
      if (matches.length === 1) {
        const record = matches[0];
        assert.equal(path.dirname(record.path), path.join(lab.root, "managed/builds"));
        const marker = json(path.join(record.path, ".clean-development-owned.json"));
        check("artifact path and independent ownership marker agree", report.artifacts.every((item) => inside(record.path, item.file)) && marker.owner === "clean-development" && marker.ownershipId === record.ownershipId && marker.workspaceId === record.workspaceId && marker.workspace === workspace);
        report.ownedTarget = record.path;
      }
    }
  }
  if (stage === "sandbox") for (const item of report.probes) {
    const deniedProbe = item.name === "forbidden" || (lab.policy === "deny-data" && item.name === "data") || (lab.policy === "deny-managed" && item.name === "managed");
    check(`sandbox ${item.name}: ${deniedProbe ? "denied" : "writable"}`, deniedProbe ? !item.writable && ["EACCES", "EPERM", "EROFS"].includes(item.error) : item.writable);
  }
  return checks;
}
function sample(root, stage, shellCargo, shellCli) {
  assert.ok(stages.includes(stage), "Unknown stage");
  const lab = load(root); ensureEnvironment(lab);
  assert.equal(fs.realpathSync(process.cwd()), expectedCwd(lab, stage), "Run from the specified App shell cwd; the fixture never fixes cwd");
  const outDir = path.join(process.cwd(), ".app-acceptance");
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  assert.equal(fs.realpathSync(outDir), outDir, "Evidence directory was replaced by a symlink");
  const file = path.join(outDir, `${stage}.json`);
  assert.ok(!fs.existsSync(file), "Evidence exists; retain it and use a fresh fixture instead of overwriting");
  const report = { kind, stage, policy: lab.policy, at: new Date().toISOString(), source: lab.source,
    invocation: { executable: process.execPath, argv: process.argv.slice(1), cwd: process.cwd(), pid: process.pid, ppid: process.ppid },
    environment: selectedEnvironment(), shellCargo, shellCli,
    appAcceptance: "NOT_ESTABLISHED: App transcript and host/version review required", checks: [], artifacts: [] };
  try {
    assert.equal(shellCargo, executable("cargo"), "Shell resolution differs from PATH lookup");
    assert.equal(shellCli, executable("clean-development"), "Shell CLI resolution differs from PATH lookup");
    assert.equal(shellCargo, path.join(lab.root, "data/bin/cargo"), "No native shim in initial App PATH; do not repair PATH");
    assert.equal(shellCli, path.join(lab.root, "data/bin/clean-development"));
    assert.equal(process.env.CLEAN_DEVELOPMENT_SESSION_MODE, "skip", "Native mode is not skip");
    report.managedBefore = tree(path.join(lab.root, "managed")); report.recordsBefore = records(lab);
    if (stage !== "initial") {
      report.toolVersions = ["cargo", "rustc"].map((tool) => execute(tool, ["--version"], process.cwd(), process.env, 10_000));
      assert.ok(report.toolVersions.every((item) => item.exitCode === 0 && !item.error && !item.signal), "Offline Rust toolchain unavailable; not sandbox acceptance");
      if (stage === "sandbox") report.probes = ["data", "managed", "forbidden"].map((name) => probe(lab, name));
      const child = [process.execPath, self, stage === "routed-skip" ? "_skip" : "_cargo", root];
      const command = stage === "native-skip" ? execute(child[0], child.slice(1), process.cwd(), process.env)
        : execute(shellCli, ["run", "--session", "session-only", "--", ...child], process.cwd(), process.env);
      report.command = command;
      if (command.exitCode === 0 && command.error === null) {
        report.child = JSON.parse(command.stdout);
        // Unwrap the helper result: a failed Cargo process must not be hidden by
        // the outer Node helper's successful JSON emission.
        report.command = { ...command, exitCode: report.child.exitCode, error: report.child.error, signal: report.child.signal };
        report.artifacts = artifactEvidence(report.child.stdout, ["native-skip", "routed-skip"].includes(stage) ? path.join(process.cwd(), "target") : path.join(lab.root, "managed/builds"));
      }
    }
    report.checks = inspect(lab, report);
  } catch (error) { report.failure = String(error.message).slice(0, 4000); }
  report.mechanicalPass = !report.failure && report.checks.length > 0 && report.checks.every((check) => check.pass);
  writeJson(file, report);
  return { ...report, evidenceFile: file };
}
function verify(root) {
  const lab = load(root), required = lab.policy === "allow" ? stages : ["initial", "sandbox"];
  const results = required.map((stage) => {
    const file = path.join(expectedCwd(lab, stage), ".app-acceptance", `${stage}.json`);
    if (!fs.existsSync(file)) return { stage, status: "BLOCKED", reason: "No App-shell observation" };
    const report = json(file);
    const matches = report.kind === kind && report.stage === stage && report.policy === lab.policy
      && JSON.stringify(report.source) === JSON.stringify(lab.source)
      && report.invocation?.cwd === expectedCwd(lab, stage);
    return { stage, status: report.mechanicalPass && matches ? "MECHANICAL_PASS_ONLY" : "FAIL", evidenceFile: file, sha256: sha(fs.readFileSync(file)) };
  });
  let worktreeDistinct = null, nestedSame = null, resumedSame = null;
  const target = (stage) => json(path.join(expectedCwd(lab, stage), ".app-acceptance", `${stage}.json`)).ownedTarget;
  if (lab.policy === "allow" && results.every((item) => item.status === "MECHANICAL_PASS_ONLY")) {
    const independentTargets = ["routed", "worktree", "changed-cwd"].map(target);
    worktreeDistinct = independentTargets.every((value) => typeof value === "string" && inside(path.join(lab.root, "managed/builds"), value)) && new Set(independentTargets).size === 3;
    nestedSame = target("routed") === target("nested-cwd"); resumedSame = target("routed") === target("resumed");
  }
  const sourceUnchanged = JSON.stringify(snapshotSources(lab)) === JSON.stringify(lab.sources);
  const noLocalTargets = [lab.projects.a, lab.projects.b, lab.projects.worktree, lab.projects.sandbox, path.join(lab.projects.a, "src")].every((directory) => !fs.existsSync(path.join(directory, "target")));
  return { kind, source: lab.source, policy: lab.policy, results, worktreeDistinct, nestedSame, resumedSame, sourceUnchanged, noLocalTargets,
    mechanicalPass: sourceUnchanged && noLocalTargets && results.every((item) => item.status === "MECHANICAL_PASS_ONLY") && (lab.policy !== "allow" || (worktreeDistinct && nestedSame && resumedSame)),
    appAcceptance: "NOT_ESTABLISHED: manually review actual App version, isolation, invocation/transcripts, restart and sandbox evidence; CLI/package-loader runs never count" };
}
async function selfTests() {
  test("App protocol preparation stays in disposable paths and uses a genuine Git worktree", { skip: process.platform === "win32" }, () => {
    const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cd-app-selftest-")));
    try {
      const root = path.join(parent, "lab"); prepare(root, "allow"); const lab = load(root);
      assert.equal(fs.statSync(root).mode & 0o777, 0o700);
      assert.ok(fs.lstatSync(path.join(lab.projects.worktree, ".git")).isFile());
      const common = (cwd) => checked("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd, lab.env);
      assert.equal(common(lab.projects.a), common(lab.projects.worktree));
      assert.notEqual(common(lab.projects.a), common(lab.projects.b));
      assert.match(fs.readFileSync(path.join(root, "codex/config.toml"), "utf8"), /CLEAN_DEVELOPMENT_SESSION_MODE = "skip"/);
      const launch = fs.readFileSync(path.join(root, "launch.sh"), "utf8");
      assert.match(launch, /env -i/); assert.ok(!launch.includes("\\n"), "No literal backslash-n separators in shell arguments");
      checked("/bin/sh", ["-n", path.join(root, "launch.sh")], root, lab.env);
      const emptySuccess = inspect(lab, {
        stage: "routed", environment: { CLEAN_DEVELOPMENT_SESSION_MODE: "skip", CD_APP_ACCEPTANCE_EPOCH: "1" },
        shellCargo: path.join(root, "data/bin/cargo"), shellCli: path.join(root, "data/bin/clean-development"),
        command: { exitCode: 0, error: null, signal: null }, toolVersions: [{ exitCode: 0 }], artifacts: [],
        child: { environment: { CLEAN_DEVELOPMENT_SESSION_MODE: "session-only", CARGO_TARGET_DIR: null, CARGO_BUILD_TARGET_DIR: null } }
      });
      assert.ok(emptySuccess.some((item) => item.name === "real Cargo reported a test executable" && !item.pass));
      assert.ok(!lab.env.PATH.split(path.delimiter).includes(path.join(root, "data/bin")), "App launch must not pre-inject shims");
      assert.deepEqual(snapshotSources(lab), lab.sources);
      const report = verify(root); assert.equal(report.mechanicalPass, false);
      assert.ok(report.results.every((item) => item.status === "BLOCKED"));
      assert.match(report.appAcceptance, /NOT_ESTABLISHED/);
      assert.throws(() => prepare(root, "allow"), /EEXIST/);
      assert.throws(() => prepare(path.join(parent, "bad"), "danger-full-access"));
      assert.ok(!fs.existsSync(path.join(parent, "bad")));
    } finally { fs.rmSync(parent, { recursive: true, force: true }); }
  });
  test("denied profiles omit only their intended root and never silently accept copied evidence", { skip: process.platform === "win32" }, () => {
    const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cd-app-denied-")));
    try {
      for (const policy of ["deny-data", "deny-managed"]) {
        const root = path.join(parent, policy); prepare(root, policy); const lab = load(root);
        const omitted = path.join(root, policy === "deny-data" ? "data" : "managed");
        const allowed = path.join(root, policy === "deny-data" ? "managed" : "data");
        assert.ok(!lab.writableRoots.includes(omitted)); assert.ok(lab.writableRoots.includes(allowed));
        assert.ok(!lab.writableRoots.some((entry) => entry === root || entry === path.join(root, "forbidden")));
        const config = fs.readFileSync(path.join(root, "codex/config.toml"), "utf8");
        assert.ok(config.includes(`writable_roots = ${JSON.stringify(lab.writableRoots)}`));
        const out = path.join(lab.projects.a, ".app-acceptance"); fs.mkdirSync(out);
        const evidence = path.join(out, "initial.json");
        // Deliberately synthetic evidence: it must not pass merely because it says true.
        writeJson(evidence, { kind, stage: "initial", policy, source: lab.source, mechanicalPass: true,
          invocation: { cwd: "/different/lab" } });
        assert.equal(verify(root).results[0].status, "FAIL");
        const report = json(evidence); report.invocation.cwd = lab.projects.a; report.source.fixtureSha256 = "wrong revision";
        fs.writeFileSync(evidence, JSON.stringify(report));
        assert.equal(verify(root).results[0].status, "FAIL");
        assert.match(verify(root).appAcceptance, /NOT_ESTABLISHED/);
        fs.mkdirSync(path.join(lab.projects.a, "target"));
        assert.equal(verify(root).noLocalTargets, false);
      }
    } finally { fs.rmSync(parent, { recursive: true, force: true }); }
  });
  test("launch environment discards ambient routing and credentials", () => {
    const env = environment("/fixture", { PATH: "/usr/bin", CARGO_TARGET_DIR: "/real/target", CLEAN_DEVELOPMENT_ROOT: "/real/storage", CODEX_HOME: "/real/codex", OPENAI_API_KEY: "do-not-copy", npm_execpath: "/real/npm" });
    for (const key of ["CARGO_TARGET_DIR", "CLEAN_DEVELOPMENT_ROOT", "OPENAI_API_KEY", "npm_execpath"]) assert.equal(env[key], undefined);
    assert.equal(env.CODEX_HOME, path.join("/fixture", "codex"));
  });
  test("missing App version is blocked, never replaced with CLI version", () => {
    const report = preflight(); assert.equal(report.app, null); assert.equal(report.appAcceptance, "BLOCKED");
    assert.ok(report.reasons.length > 0);
  });
  test("unconfined canary success is not evidence of sandbox denial", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cd-app-probe-")));
    try {
      fs.mkdirSync(path.join(root, "forbidden"));
      const result = probe({ root }, "forbidden"); assert.equal(result.writable, true);
      assert.ok(fs.existsSync(result.file)); // Retain probe evidence; no permission simulation.
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  test("artifact success requires a real, non-empty executable in the expected root", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cd-app-artifact-")));
    try {
      assert.deepEqual(artifactEvidence('{"reason":"build-finished","success":true}\n', root), []);
      const file = path.join(root, "test-binary"); write(file, "");
      const message = JSON.stringify({ reason: "compiler-artifact", executable: file, profile: { test: true }, target: { name: "cd_app_fixture" }, fresh: false });
      assert.throws(() => artifactEvidence(message, root), /non-empty/);
      fs.writeFileSync(file, "synthetic fixture data, not Cargo/App evidence");
      assert.equal(artifactEvidence(message, root).length, 1);
      assert.deepEqual(artifactEvidence(message.replace('"test":true', '"test":false'), root), []);
      assert.throws(() => artifactEvidence(message, path.join(root, "other")), /escaped/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  test("same-size managed-file changes cannot appear unchanged", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cd-app-hash-")));
    try {
      const file = path.join(root, "value"); write(file, "old"); const before = tree(root);
      fs.writeFileSync(file, "new"); assert.notDeepEqual(tree(root), before);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  test("inventory fails closed on symlinks rather than claiming complete evidence", { skip: process.platform === "win32" }, () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cd-app-symlink-")));
    try { fs.symlinkSync(os.tmpdir(), path.join(root, "link")); assert.throws(() => tree(root), /symlink/); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}
const help = `Usage (macOS/Linux preparation; actual App acceptance requires an isolated desktop):
  node test/lab/codex-app-acceptance.mjs preflight [ABS_CODEX_APP_BUNDLE]
  node test/lab/codex-app-acceptance.mjs prepare ABS_NEW_DIRECTORY allow|deny-data|deny-managed
  node test/lab/codex-app-acceptance.mjs sample LAB STAGE "$(command -v cargo)" "$(command -v clean-development)"
  node test/lab/codex-app-acceptance.mjs verify LAB
  node test/lab/codex-app-acceptance.mjs self-test
Stages: ${stages.join(", ")}
Read docs/codex-app-acceptance.md before launching a GUI. No automatic launch or cleanup.
Exit 0: mechanical checks only; exit 1: failed/blocked checks; exit 2: usage/setup failure.`;
async function main(args) {
  const [command, ...rest] = args;
  if (!command || command === "--help") { console.log(help); return; }
  if (command === "self-test" && rest.length === 0) { await selfTests(); return; }
  let result;
  if (command === "preflight" && rest.length <= 1) { result = preflight(rest[0]); process.exitCode = 1; }
  else if (command === "prepare" && rest.length === 2) result = prepare(...rest);
  else if (command === "sample" && rest.length === 4) { result = sample(...rest); if (!result.mechanicalPass) process.exitCode = 1; }
  else if (command === "verify" && rest.length === 1) { result = verify(rest[0]); if (!result.mechanicalPass) process.exitCode = 1; }
  else if (["_cargo", "_skip"].includes(command) && rest.length === 1) {
    const lab = load(rest[0]); ensureEnvironment(lab);
    if (command === "_cargo") result = cargoResult(lab);
    else {
      const run = execute(executable("clean-development"), ["run", "--session", "skip", "--", process.execPath, self, "_cargo", lab.root], process.cwd(), process.env);
      result = run.exitCode === 0 && run.error === null ? JSON.parse(run.stdout) : run;
    }
  } else throw new Error(help);
  console.log(JSON.stringify(result, null, 2));
}
if (process.env.NODE_TEST_CONTEXT) await selfTests();
else try { await main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 2; }
