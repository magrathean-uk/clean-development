// Disposable acceptance observer, not production routing. Never log the full environment.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");

const keys = [
  "PATH", "HOME", "CLAUDE_CONFIG_DIR", "CLEAN_DEVELOPMENT_SESSION_MODE", "CLEAN_DEVELOPMENT_ACTIVE",
  "CLEAN_DEVELOPMENT_SESSION_ENV", "CLEAN_DEVELOPMENT_RESOLVED_ROOT", "CLEAN_DEVELOPMENT_WORKSPACE_ID",
  "CLEAN_DEVELOPMENT_WORKSPACE", "CLEAN_DEVELOPMENT_CARGO_TARGET_DIR", "CARGO_TARGET_DIR",
  "npm_config_cache", "UV_CACHE_DIR", "ACCEPTANCE_KEEP"
];
function selectedEnvironment() {
  return Object.fromEntries(keys.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
}
function inside(root, file) {
  const rel = path.relative(root, path.resolve(file));
  assert.ok(rel && !rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel), `Outside lab: ${file}`);
  // Refuse existing symlinks instead of following them into someone's storage.
  let current = path.resolve(file);
  while (current !== root) {
    try { assert.equal(fs.lstatSync(current).isSymbolicLink(), false, `Symlink in lab path: ${current}`); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    current = path.dirname(current);
  }
}
function main() {
  const [mode, caseName] = process.argv.slice(2);
  if (!mode) return; // Harmless if a test runner discovers this support file.
  if (mode === "environment") { console.log(JSON.stringify(selectedEnvironment())); return; }
  const root = fs.realpathSync(process.env.CLAUDE_ACCEPTANCE_ROOT);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "lab.json"), "utf8"));
  assert.equal(manifest.root, root);
  const name = mode === "cargo" ? process.env.CLAUDE_ACCEPTANCE_CASE : caseName;
  assert.match(name || "", /^[a-z][a-z0-9-]*$/);
  inside(root, process.cwd());
  function save(suffix, value) {
    const file = path.join(root, "evidence", `${name}-${suffix}.json`);
    inside(root, file);
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }
  if (mode === "cargo") {
    const args = process.argv.slice(3);
    assert.deepEqual(args, ["build", "--offline"], "Only the dependency-free fixture build is allowed");
    const target = process.env.CARGO_TARGET_DIR || path.join(process.cwd(), "target");
    inside(root, target);
    const artifact = path.join(target, "debug", "claude_acceptance_fixture");
    const record = { layer: "tool-child", backend: manifest.backend, cwd: process.cwd(), argv: args,
      nonce: process.env.CLAUDE_ACCEPTANCE_NONCE, env: selectedEnvironment(), target, artifact };
    save("cargo-start", record);
    if (manifest.backend === "fixture") {
      fs.mkdirSync(path.dirname(artifact), { recursive: true });
      fs.writeFileSync(artifact, record.nonce, { mode: 0o600 });
      record.exitCode = 0;
      record.signal = null;
    } else {
      const result = spawnSync(manifest.cargo, args, { env: process.env, cwd: process.cwd(), stdio: "inherit" });
      if (result.error) throw result.error;
      record.exitCode = result.status;
      record.signal = result.signal;
      process.exitCode = result.status ?? 1;
    }
    save("cargo", record);
    return;
  }
  assert.equal(mode, "observe");
  const nonce = randomUUID();
  const resolved = spawnSync("/bin/sh", ["-c", "command -v cargo"], { encoding: "utf8" });
  assert.equal(resolved.status, 0, resolved.stderr);
  save("shell", { layer: "shell-child", backend: manifest.backend, cwd: process.cwd(),
    nonce, env: selectedEnvironment(), cargoCommand: resolved.stdout.trim() });
  const result = spawnSync("cargo", ["build", "--offline"], {
    cwd: process.cwd(), stdio: "inherit",
    env: { ...process.env, CLAUDE_ACCEPTANCE_CASE: name, CLAUDE_ACCEPTANCE_NONCE: nonce }
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
if (require.main === module) main();
module.exports = { keys, selectedEnvironment, inside };
