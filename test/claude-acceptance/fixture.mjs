import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const cli = path.join(repository, "bin/clean-development.js");
export const observer = path.join(repository, "test/claude-acceptance/child.cjs");
export const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
export const cases = ["before-setup", "after-setup", "session-only", "skip", "disabled", "cwd-change", "resume", "fork", "subagent", "uninstall"];
export function execute(command, args, { cwd = repository, env, input, stdin, timeout = 20000 } = {}) {
  const result = spawnSync(command, args, { cwd, env, input, stdio: stdin === undefined ? "pipe" : [stdin, "pipe", "pipe"], encoding: "utf8", timeout, maxBuffer: 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command}: ${result.stderr || result.stdout}`);
  return result;
}
export function product(item, args, env = item.env, cwd = item.projects.normal) {
  return execute(process.execPath, [cli, ...args], { env, cwd });
}
export function sourceIdentity() {
  const git = (args) => execute("git", args).stdout.trim();
  return { commit: git(["rev-parse", "HEAD"]), tree: git(["rev-parse", "HEAD^{tree}"]),
    dirty: Boolean(git(["status", "--porcelain"])),
    productSha256: Object.fromEntries(["hooks/session-start", "integrations/claude/hooks.json", "src/integrations.js"]
      .map((file) => [file, createHash("sha256").update(fs.readFileSync(path.join(repository, file))).digest("hex")])) };
}
export function makeFixture({ backend = "fixture", cargo = null } = {}) {
  assert.ok(["fixture", "live"].includes(backend));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clean-development-claude-acceptance-")));
  const projects = Object.fromEntries(["normal", "other", "disabled"].map((name) => [name, path.join(root, `project ${name} \u00e9`)]));
  for (const directory of ["home", "claude", "tools", "evidence", "tmp", "cargo-home", "rustup-home"]) fs.mkdirSync(path.join(root, directory));
  const env = {
    PATH: [path.join(root, "tools"), path.dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
    HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"),
    TMPDIR: path.join(root, "tmp"), TMP: path.join(root, "tmp"), TEMP: path.join(root, "tmp"),
    XDG_CONFIG_HOME: path.join(root, "xdg-config"), XDG_DATA_HOME: path.join(root, "xdg-data"), XDG_CACHE_HOME: path.join(root, "xdg-cache"),
    CLEAN_DEVELOPMENT_HOME: path.join(root, "home"), CLEAN_DEVELOPMENT_DATA_HOME: path.join(root, "data"),
    CLEAN_DEVELOPMENT_CONFIG_HOME: path.join(root, "config"), CLAUDE_CONFIG_DIR: path.join(root, "claude"),
    CARGO_HOME: path.join(root, "cargo-home"), RUSTUP_HOME: path.join(root, "rustup-home"), RUSTUP_AUTO_INSTALL: "0",
    CARGO_NET_OFFLINE: "true", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "home", ".gitconfig"),
    UV_CACHE_DIR: path.join(root, "independent uv cache"), CLAUDE_ACCEPTANCE_ROOT: root,
    DISABLE_AUTOUPDATER: "1", DISABLE_UPDATES: "1", LANG: "C.UTF-8", TERM: "dumb"
  };
  for (const project of Object.values(projects)) {
    fs.mkdirSync(path.join(project, "src"), { recursive: true });
    fs.writeFileSync(path.join(project, "package.json"), '{"name":"claude-acceptance","private":true}\n');
    fs.writeFileSync(path.join(project, "Cargo.toml"), '[package]\nname = "claude_acceptance_fixture"\nversion = "0.1.0"\nedition = "2021"\n');
    fs.writeFileSync(path.join(project, "Cargo.lock"), 'version = 3\n\n[[package]]\nname = "claude_acceptance_fixture"\nversion = "0.1.0"\n');
    fs.writeFileSync(path.join(project, "src", "main.rs"), 'fn main() { println!("claude-acceptance-artifact"); }\n');
  }
  fs.writeFileSync(path.join(projects.disabled, ".clean-development.json"), '{"schemaVersion":1,"enabled":false}\n');
  const item = { root, env, projects, backend, cargo, bin: path.join(root, "data", "bin"), managed: path.join(root, "managed") };
  // An unrelated, observable user hook must survive setup and uninstall.
  const command = 'printf \'export ACCEPTANCE_KEEP="unrelated-hook"\\n\' >> "$CLAUDE_ENV_FILE"';
  item.originalSettings = { hooks: { SessionStart: [{ matcher: "startup|resume|fork", hooks: [{ type: "command", command }] }] } };
  fs.writeFileSync(path.join(env.CLAUDE_CONFIG_DIR, "settings.json"), `${JSON.stringify(item.originalSettings, null, 2)}\n`);
  fs.writeFileSync(path.join(root, "tools", "cargo"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(observer)} cargo "$@"\n`, { mode: 0o755 });
  const protectedFiles = Object.values(projects).flatMap((p) => ["package.json", "Cargo.toml", "Cargo.lock", "src/main.rs", ...(p === projects.disabled ? [".clean-development.json"] : [])].map((f) => path.join(p, f)));
  item.protected = Object.fromEntries(protectedFiles.map((p) => [p, fs.readFileSync(p, "utf8")]));
  fs.writeFileSync(path.join(root, "lab.json"), `${JSON.stringify({ ...item, source: sourceIdentity() }, null, 2)}\n`, { mode: 0o600 });
  return item;
}
export function loadFixture(root) {
  const canonical = fs.realpathSync(root);
  assert.equal(path.resolve(root), canonical, "Lab root must not be a symlink");
  assert.equal(path.dirname(canonical), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(canonical).startsWith("clean-development-claude-acceptance-"));
  const item = JSON.parse(fs.readFileSync(path.join(canonical, "lab.json"), "utf8"));
  assert.equal(item.root, canonical);
  assert.equal(item.env.CLAUDE_ACCEPTANCE_ROOT, canonical);
  assert.ok(["fixture", "live"].includes(item.backend));
  for (const file of Object.keys(item.protected)) assert.ok(file.startsWith(`${canonical}${path.sep}`));
  const expected = { HOME: "home", USERPROFILE: "home", CLEAN_DEVELOPMENT_HOME: "home", CLAUDE_CONFIG_DIR: "claude",
    CLEAN_DEVELOPMENT_DATA_HOME: "data", CLEAN_DEVELOPMENT_CONFIG_HOME: "config", CARGO_HOME: "cargo-home", RUSTUP_HOME: "rustup-home",
    XDG_CONFIG_HOME: "xdg-config", XDG_DATA_HOME: "xdg-data", XDG_CACHE_HOME: "xdg-cache",
    TMPDIR: "tmp", TMP: "tmp", TEMP: "tmp", UV_CACHE_DIR: "independent uv cache" };
  for (const [key, relative] of Object.entries(expected)) assert.equal(item.env[key], path.join(canonical, relative), `Changed lab path: ${key}`);
  assert.equal(item.managed, path.join(canonical, "managed"));
  assert.equal(item.bin, path.join(canonical, "data", "bin"));
  for (const name of ["normal", "other", "disabled"]) assert.equal(item.projects[name], path.join(canonical, `project ${name} é`));
  for (const target of [...Object.values(item.projects), ...Object.values(expected).map((p) => path.join(canonical, p)), item.managed]) {
    let current = target;
    while (current !== canonical) {
      try { assert.equal(fs.lstatSync(current).isSymbolicLink(), false, `Symlink in lab: ${current}`); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      current = path.dirname(current);
    }
  }
  return item;
}
export function destroyFixture(item) { loadFixture(item.root); fs.rmSync(item.root, { recursive: true, force: true }); }
export function intact(item) {
  for (const [file, content] of Object.entries(item.protected)) assert.equal(fs.readFileSync(file, "utf8"), content, file);
  for (const name of ["normal", "other"]) assert.equal(fs.existsSync(path.join(item.projects[name], ".clean-development.json")), false);
}
export function setup(item) {
  product(item, ["setup", "--root", item.managed, "--agents", "claude", "--json"]);
  const settings = JSON.parse(fs.readFileSync(path.join(item.env.CLAUDE_CONFIG_DIR, "settings.json"), "utf8"));
  assert.deepEqual(settings.hooks.SessionStart[0], item.originalSettings.hooks.SessionStart[0]);
  assert.equal(settings.hooks.SessionStart.length, 2);
  return settings;
}
export function hook(item, { env = item.env, cwd = item.projects.normal, source = "startup", generic = false, environmentFile = path.join(item.root, "session.env") } = {}) {
  const input = JSON.stringify({ hook_event_name: source === "cwd-change" ? "CwdChanged" : "SessionStart",
    ...(source === "cwd-change" ? { old_cwd: item.projects.normal, new_cwd: cwd } : { source }), cwd, session_id: "fixture-not-a-Claude-session" });
  const hookEnv = { ...env, CLAUDE_ENV_FILE: environmentFile, CLAUDE_PLUGIN_ROOT: repository };
  // Some hooks intentionally exit without reading stdin. A disposable input file
  // supplies the real event bytes without introducing a parent pipe's EPIPE race.
  const inputFile = `${environmentFile}.input.json`;
  fs.writeFileSync(inputFile, input, { mode: 0o600 });
  const invoke = (args) => {
    const stdin = fs.openSync(inputFile, "r");
    try { return execute("/bin/sh", args, { env: hookEnv, cwd, stdin }); }
    finally { fs.closeSync(stdin); }
  };
  if (generic) invoke([path.join(repository, "hooks/session-start")]);
  else {
    const settings = JSON.parse(fs.readFileSync(path.join(item.env.CLAUDE_CONFIG_DIR, "settings.json"), "utf8"));
    const matches = settings.hooks.SessionStart.filter((entry) => new RegExp(`^(?:${entry.matcher})$`).test(source));
    for (const entry of matches) for (const h of entry.hooks) invoke(["-c", h.command]);
  }
  return environmentFile;
}
export function observedEnvironment(item, envFile, env = item.env, cwd = item.projects.normal) {
  return JSON.parse(execute("/bin/sh", ["-c", `. ${quote(envFile)}; exec ${quote(process.execPath)} ${quote(observer)} environment`], { env, cwd }).stdout);
}
export function routedParent(item) {
  const result = product(item, ["run", "--session", "session-only", "--", process.execPath, observer, "environment"]);
  return { ...item.env, ...JSON.parse(result.stdout) };
}
export function observe(item, name, { env = item.env, cwd = item.projects.normal, envFile = null, session = null } = {}) {
  assert.match(name, /^[a-z][a-z0-9-]*$/);
  if (session) product(item, ["run", "--session", session, "--", process.execPath, observer, "observe", name], env, cwd);
  else execute("/bin/sh", ["-c", `${envFile ? `. ${quote(envFile)}; ` : ""}exec ${quote(process.execPath)} ${quote(observer)} observe ${quote(name)}`], { env, cwd });
  return evidence(item, name);
}
export function evidence(item, name) {
  const read = (suffix) => JSON.parse(fs.readFileSync(path.join(item.root, "evidence", `${name}-${suffix}.json`), "utf8"));
  const shell = read("shell"), cargo = read("cargo");
  assert.equal(shell.backend, item.backend);
  assert.equal(cargo.backend, item.backend);
  assert.equal(cargo.exitCode, 0, "Build child failed");
  assert.equal(cargo.signal, null);
  assert.equal(typeof shell.nonce, "string");
  assert.equal(shell.nonce, cargo.nonce);
  assert.equal(shell.cwd, cargo.cwd);
  assert.deepEqual(cargo.argv, ["build", "--offline"]);
  assert.equal(cargo.env.UV_CACHE_DIR, item.env.UV_CACHE_DIR, "Independent override changed");
  assert.equal(fs.existsSync(cargo.artifact), true, "Child did not create its artifact");
  assert.ok(fs.realpathSync(cargo.artifact).startsWith(`${item.root}${path.sep}`), "Artifact escaped the disposable lab");
  assert.ok(fs.lstatSync(cargo.artifact).isFile(), "Artifact is not a regular file");
  if (item.backend === "fixture") assert.equal(fs.readFileSync(cargo.artifact, "utf8"), cargo.nonce);
  return { shell, cargo };
}
export function evaluate(item, name, { routed, shellClean = !routed, cwd = item.projects.normal } = {}) {
  try {
    const value = evidence(item, name);
    assert.equal(value.shell.cwd, cwd);
    if (routed) {
      assert.equal(value.shell.cargoCommand, path.join(item.bin, "cargo"));
      assert.ok(value.cargo.target.startsWith(`${item.managed}${path.sep}`));
      assert.equal(value.cargo.env.CLEAN_DEVELOPMENT_SESSION_MODE, "session-only");
      assert.equal(fs.existsSync(path.join(cwd, "target")), false, "Unexpected project-local target");
    } else {
      assert.equal(value.cargo.env.CARGO_TARGET_DIR, undefined);
      assert.equal(value.cargo.env.npm_config_cache, undefined);
      assert.equal(value.cargo.target, path.join(cwd, "target"));
    }
    if (shellClean) {
      assert.equal(value.shell.env.npm_config_cache, undefined, "Shell child retained a managed npm cache in pass-through mode");
      assert.equal(value.shell.env.CARGO_TARGET_DIR, undefined);
    }
    intact(item);
    return { status: "passed", layer: item.backend === "fixture" ? "fixture-only" : "live-candidate", name };
  } catch (error) {
    return { status: "failed", layer: item.backend === "fixture" ? "fixture-only" : "live-candidate", name, reason: error.message };
  }
}
export function preflight(item) {
  const inspect = (name) => {
    const r = spawnSync(name, ["--version"], { env: item.env, cwd: item.projects.normal, encoding: "utf8", timeout: 5000, maxBuffer: 65536 });
    return { command: name, argv: ["--version"], available: !r.error && r.status === 0, version: r.status === 0 ? r.stdout.trim() : null,
      error: r.error?.code || (r.status !== 0 ? `exit ${r.status}: ${r.stderr.trim()}` : null) };
  };
  // Never probe the deliberately fake Cargo wrapper as a real installed tool.
  const cleanEnv = { ...item.env, PATH: item.env.PATH.split(":").filter((p) => p !== path.join(item.root, "tools")).join(":") };
  const original = item.env; item.env = cleanEnv;
  try {
    const claude = inspect(item.claude || "claude"), cargo = inspect(item.cargo || "cargo"), rustc = inspect(item.env.RUSTC || "rustc");
    const ready = claude.available && cargo.available && rustc.available;
    let fork = null;
    if (claude.available) {
      const help = spawnSync(item.claude || "claude", ["--help"], { env: item.env, cwd: item.projects.normal, encoding: "utf8", timeout: 5000, maxBuffer: 65536 });
      fs.writeFileSync(path.join(item.root, "evidence", "claude-help.txt"), help.stdout || "");
      if (!help.error && help.status === 0) fork = help.stdout.includes("--fork-session");
    }
    const result = { source: sourceIdentity(), machine: { platform: process.platform, arch: process.arch, release: os.release(), node: process.version },
      claude, cargo, rustc, capabilities: { fork, subagents: "requires-host-verification" }, liveAcceptance: "not-run", cases: cases.map((name) => ({ name,
        status: ready ? "not-run" : "blocked",
        reason: ready ? "Requires actual host execution and child evidence" : "Claude, Cargo and/or rustc unavailable in isolated environment" })) };
    fs.writeFileSync(path.join(item.root, "evidence", "preflight.json"), `${JSON.stringify(result, null, 2)}\n`);
    return result;
  } finally { item.env = original; }
}
