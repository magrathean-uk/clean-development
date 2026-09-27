import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A separate opt-in boundary: never read normal routing configuration or expose
// its shims, state, ownership receipts or previously shared caches to the child.
const BOOTSTRAP = fileURLToPath(new URL("./strict-bootstrap.sh", import.meta.url));
const SYSTEM_ROOTS = ["/usr", "/bin", "/sbin", "/lib", "/lib64"];
const UTILITIES = ["/usr/bin/env", "/usr/bin/unshare", "/usr/bin/setpriv", "/usr/bin/bash",
  "/usr/bin/mount", "/usr/bin/mkdir", "/usr/bin/touch", "/usr/bin/ln", "/usr/bin/tini", "/usr/sbin/chroot"];
const SIGNALS = ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM", "SIGUSR1", "SIGUSR2", "SIGALRM", "SIGPIPE", "SIGWINCH"];
const CONTROL_ENV = Object.freeze({ PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" });
const KEYS = new Set(["version", "sources", "managed", "toolchains", "artifacts", "env"]);
const RESERVED = new Set(["CLEAN_DEVELOPMENT_STRICT_WORK", "BASHOPTS", "BASH_VERSINFO", "EUID", "PPID", "SHELLOPTS", "UID", "PWD", "OLDPWD", "SHLVL", "_"]);
const inside = (root, value) => value === root || value.startsWith(`${root}/`);
const overlap = (a, b) => inside(a, b) || inside(b, a);
const fail = (message) => { throw new Error(`Experimental strict mode: ${message}`); };

function directory(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0") || path.normalize(value) !== value) {
    fail(`${label} must be an absolute normalised path`);
  }
  const stat = fs.lstatSync(value);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(value) !== value) fail(`${label} must be a canonical real directory: ${value}`);
  return value;
}
function list(value, label, required = false) {
  if (!Array.isArray(value) || (required && !value.length) || value.length > 32) fail(`${label} must be an array of ${required ? "1–32" : "0–32"} directories`);
  return value.map((item) => directory(item, label));
}
function assertNoSpecialFiles(roots) {
  let count = 0;
  const visit = (file) => {
    if (++count > 100000) fail("source inventory exceeds 100000 entries; split/review the declared source roots");
    const stat = fs.lstatSync(file);
    if (stat.isDirectory()) for (const entry of fs.readdirSync(file)) visit(path.join(file, entry));
    else if (!stat.isFile() && !stat.isSymbolicLink()) fail(`source contains a socket, device or FIFO: ${file}`);
  };
  roots.forEach(visit);
}
function mountPoints() {
  return fs.readFileSync("/proc/self/mountinfo", "utf8").trim().split("\n").map((line) =>
    line.split(" ")[4].replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8))));
}

export function planStrict(policy, { cwd = process.cwd(), home = os.userInfo().homedir, platform = process.platform } = {}) {
  if (platform !== "linux") fail("Linux is required; there is no unsandboxed fallback");
  if (!policy || typeof policy !== "object" || Array.isArray(policy) || policy.version !== 1) fail("policy version must be 1");
  for (const key of Object.keys(policy)) if (!KEYS.has(key)) fail(`unknown policy key: ${key}`);
  const sources = list(policy.sources, "sources", true);
  const managed = directory(policy.managed, "managed");
  const toolchains = list(policy.toolchains ?? [], "toolchains");
  const artifacts = list(policy.artifacts ?? [], "artifacts");
  const roots = [...sources, managed, ...toolchains, ...artifacts];
  const forbidden = ["/", "/home", "/root", "/tmp", "/var", "/opt", "/mnt", "/media", home];
  for (const root of roots) {
    if (forbidden.includes(root) || ["/etc", "/proc", "/sys", "/dev", "/run", ...SYSTEM_ROOTS].some((base) => overlap(base, root))) {
      fail(`broad, system or reserved root cannot be declared: ${root}`);
    }
  }
  for (let i = 0; i < roots.length; i++) for (let j = i + 1; j < roots.length; j++) {
    if (overlap(roots[i], roots[j])) fail(`declared roots overlap: ${roots[i]} and ${roots[j]}`);
  }
  const current = directory(fs.realpathSync.native(cwd), "cwd");
  if (!sources.some((root) => inside(root, current))) fail("cwd must be inside a declared read-only source root");
  for (const root of artifacts) if (fs.readdirSync(root).length) fail(`artifact destinations must be empty dedicated directories: ${root}`);
  for (const root of [managed, ...artifacts]) {
    const stat = fs.statSync(root);
    if (stat.uid !== process.getuid() || (stat.mode & 0o022)) fail(`writable roots must be owned by this user and not group/world-writable: ${root}`);
    for (let current = root; ; current = path.dirname(current)) {
      try {
        fs.lstatSync(path.join(current, ".clean-development-owned.json"));
        fail(`writable root is inside a normally prunable build: ${root}`);
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (current === path.dirname(current)) break;
    }
  }
  fs.accessSync(managed, fs.constants.W_OK | fs.constants.X_OK);
  for (const root of artifacts) fs.accessSync(root, fs.constants.W_OK | fs.constants.X_OK);
  for (const point of mountPoints()) {
    if (roots.some((root) => point !== root && inside(root, point))) fail(`nested mount is not supported: ${point}`);
  }
  assertNoSpecialFiles(sources);
  const environment = policy.env ?? {};
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) fail("env must be an object of explicit string values");
  for (const [key, value] of Object.entries(environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.includes("\0") || RESERVED.has(key)) fail(`invalid or reserved environment key/value: ${key}`);
  }
  return { version: 1, backend: "linux-user-mount-pid-namespaces", cwd: current,
    sources, managed, toolchains, artifacts, env: { ...environment } };
}

function readPolicy(file) {
  if (typeof file !== "string" || !file) fail("--policy is required; no policy is discovered or inherited");
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) fail("policy must be a regular non-symlink JSON file no larger than 64 KiB");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function prerequisites() {
  if (process.getuid() === 0 || process.getuid() !== process.geteuid()) fail("run as an ordinary non-root Linux user, not root or a set-ID launcher");
  for (const file of UTILITIES) {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022)) fail(`required system utility is not root-owned and protected: ${file}`);
    fs.accessSync(file, fs.constants.X_OK);
  }
}
function spawnStrict(args, cwd, environment) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = childProcess.spawn("/usr/bin/setpriv", args, { cwd, env: CONTROL_ENV, stdio: ["inherit", "inherit", "inherit", "pipe", "pipe"], detached: true });
    } catch (error) { reject(error); return; }
    let failure, controlFailure, ready = false, cancelled;
    child.stdio[4].on("error", (error) => { controlFailure ??= error; });
    child.stdio[4].once("data", (bytes) => {
      if (bytes.toString() === "R") ready = true;
      else { failure = new Error("Strict bootstrap readiness protocol failed"); try { process.kill(-child.pid, "SIGKILL"); } catch {} }
    });
    // Environment values never become host-visible command-line arguments.
    // Only the trusted in-jail bootstrap reads this FD, then closes it.
    child.stdio[3].on("error", (error) => { controlFailure = error; });
    child.stdio[3].end(Buffer.from(Object.entries(environment).map(([key, value]) => `${key}=${value}\0`).join("")));
    const handlers = new Map();
    for (const signal of SIGNALS) {
      const handler = () => {
        if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
        // The unshare waiter ignores these signals; the namespace's Tini init
        // resets them and relays each one to the workload's own process group.
        // Before the trusted handoff, ignored setup signals must not be lost.
        // Abort that incomplete namespace instead of later launching a workload.
        if (!ready) cancelled ??= signal;
        try { process.kill(-child.pid, ready ? signal : "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") failure ??= error; }
      };
      handlers.set(signal, handler); process.on(signal, handler);
    }
    child.on("error", (error) => { failure ??= error; });
    child.once("close", (code, signal) => {
      for (const [name, handler] of handlers) process.removeListener(name, handler);
      if (code === 0 && !ready) failure ??= new Error("Strict bootstrap did not establish its execution handoff");
      if (failure || (code === 0 && controlFailure)) reject(failure || controlFailure);
      else if (cancelled) resolve(128 + os.constants.signals[cancelled]);
      else resolve(code ?? 128 + (os.constants.signals[signal] || 1));
    });
  });
}

export async function runStrict(options, command) {
  if (options.experimental !== true) fail("--experimental is required on every invocation");
  if (!Array.isArray(command) || !command.length || command.some((arg) => typeof arg !== "string" || arg.includes("\0")) || !command[0]) fail("a literal command argv is required after --");
  const policy = readPolicy(options.policy);
  const plan = planStrict(policy);
  if (options["dry-run"]) {
    // Deliberately omit command bodies and environment values from the review.
    const { env, ...review } = plan;
    console.log(JSON.stringify({ ...review, environmentKeys: Object.keys(env), execution: "not-tested", deletion: "none" }, null, 2));
    return 0;
  }
  prerequisites();
  // Recheck immediately before creating storage. This is not an atomic defence
  // against another hostile process outside the sandbox replacing host paths.
  planStrict(policy);
  const run = fs.mkdtempSync(path.join(plan.managed, "strict-"));
  fs.chmodSync(run, 0o700);
  const rootfs = path.join(run, "rootfs"), work = path.join(run, "work");
  fs.mkdirSync(rootfs, { mode: 0o700 }); fs.mkdirSync(work, { mode: 0o700 });
  for (const name of ["home", "tmp", "cache", "config", "data", "cargo-home", "cargo-target", "go-build", "go-mod", "go", "npm"]) fs.mkdirSync(path.join(work, name), { mode: 0o700 });
  const env = { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", HOME: path.join(work, "home"),
    TMPDIR: path.join(work, "tmp"), XDG_CACHE_HOME: path.join(work, "cache"), XDG_CONFIG_HOME: path.join(work, "config"),
    XDG_DATA_HOME: path.join(work, "data"), CARGO_HOME: path.join(work, "cargo-home"), CARGO_TARGET_DIR: path.join(work, "cargo-target"),
    GOCACHE: path.join(work, "go-build"), GOMODCACHE: path.join(work, "go-mod"), GOPATH: path.join(work, "go"),
    npm_config_cache: path.join(work, "npm"), ...plan.env, CLEAN_DEVELOPMENT_STRICT_WORK: work };
  const mounts = [];
  for (const root of SYSTEM_ROOTS.filter((root) => fs.existsSync(root))) mounts.push(["ro", fs.realpathSync.native(root), root]);
  for (const root of [...plan.sources, ...plan.toolchains]) mounts.push(["ro", root, root]);
  for (const root of [work, ...plan.artifacts]) mounts.push(["rw", root, root]);
  const ignored = SIGNALS.map((name) => name.slice(3)).join(",");
  const args = ["--pdeathsig", "KILL", "--no-new-privs", "/usr/bin/bash", "--noprofile", "--norc", "-c",
    '[[ $PPID == "$1" ]] || exit 125; shift; exec -- "$@"', "strict-parent", String(process.pid), "/usr/bin/env", `--ignore-signal=${ignored}`, "--",
    "/usr/bin/unshare", "--user", "--map-root-user", "--mount", "--pid", "--net", "--ipc", "--uts",
    "--propagation", "private", "--fork", "--kill-child=KILL", "--", "/usr/bin/bash", "--noprofile", "--norc", BOOTSTRAP,
    rootfs, plan.cwd, work, String(mounts.length), ...mounts.flat(), String(Object.keys(env).length),
    "--", ...command];
  // No fallback, export, uninstall, pruning, or automatic cleanup on any path.
  return spawnStrict(args, plan.cwd, env);
}
