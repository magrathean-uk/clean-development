// Deliberately synthetic host transport. Never call an installed model host.
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
function main() {
  if (process.argv.length < 3) return;
  const argv = process.argv.slice(2), root = fs.realpathSync(process.env.CD_CODEX_LAB), item = JSON.parse(fs.readFileSync(path.join(root, "lab.json"), "utf8"));
  assert.equal(item.backend, "fixture"); assert.equal(item.root, root);
  const option = (name) => argv[argv.indexOf(name) + 1];
  const name = option("--fixture-case"), event = argv[0], requestedLogin = option("--fixture-login") === "true";
  assert.match(name || "", /^[a-z][a-z0-9-]*$/); assert.ok(["startup", "resume", "fork", "subagent", "cwd-change"].includes(event));
  const env = { ...process.env }, config = fs.readFileSync(path.join(item.env.CODEX_HOME, "config.toml"), "utf8");
  let section = "", allowLogin = true;
  for (const line of config.split(/\r?\n/)) {
    if (/^\[/.test(line)) { section = line.trim(); continue; }
    if (section === "" && /^allow_login_shell\s*=\s*false/.test(line)) allowLogin = false;
    const setting = /^(PATH|CLEAN_DEVELOPMENT_SESSION_MODE|CLEAN_DEVELOPMENT_ACTIVE)\s*=\s*(".*")\s*$/.exec(line);
    if (section === "[shell_environment_policy.set]" && setting) env[setting[1]] = JSON.parse(setting[2]);
  }
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "-c") continue;
    const value = argv[++index]; if (value === "allow_login_shell=false") allowLogin = false;
    const setting = /^shell_environment_policy\.set\.(CLEAN_DEVELOPMENT_SESSION_MODE)=(".*")$/.exec(value);
    if (setting) env[setting[1]] = JSON.parse(setting[2]);
  }
  // A fixed synthetic tool substrate goes after the native-policy PATH; shims
  // still resolve first. It is not persisted into the host config.
  if (!env.PATH.split(path.delimiter).includes(item.tools)) env.PATH += `${path.delimiter}${item.tools}`;
  env.CD_CODEX_FIXTURE_STATUS = option("--fixture-status");
  const hostFile = path.join(item.evidence, `${name}-host.json`);
  fs.writeFileSync(hostFile, JSON.stringify({ layer: "fixture-only", event: `synthetic-${event}`, requestedLogin, allowLogin, argv,
    inheritedMode: process.env.CLEAN_DEVELOPMENT_SESSION_MODE || null, childMode: env.CLEAN_DEVELOPMENT_SESSION_MODE || null }), { flag: "wx", mode: 0o600 });
  const script = `if shopt -q login_shell; then export CD_CODEX_ACTUAL_LOGIN=true; else export CD_CODEX_ACTUAL_LOGIN=false; fi; exec ${quote(process.execPath)} ${quote(path.join(__dirname, "child.cjs"))} observe ${quote(name)}`;
  let result;
  if (event === "subagent" && !process.env.CD_CODEX_SYNTHETIC_SUBAGENT) {
    const childArgs = argv.map((arg, index) => index === 0 ? "startup" : arg === name ? `${name}-child` : arg);
    result = spawnSync(process.execPath, [__filename, ...childArgs], { cwd: process.cwd(), env: { ...env, CD_CODEX_SYNTHETIC_SUBAGENT: "1" }, stdio: "inherit" });
    for (const layer of ["shell", "tool"]) fs.renameSync(path.join(item.evidence, `${name}-child-${layer}.json`), path.join(item.evidence, `${name}-${layer}.json`));
  } else result = spawnSync("/bin/bash", ["--noprofile", "--norc", ...(requestedLogin && allowLogin ? ["-l"] : []), "-c", script], { cwd: process.cwd(), env, stdio: "inherit" });
  if (result.error) throw result.error; process.exitCode = result.status ?? 1;
}
if (require.main === module) main();
