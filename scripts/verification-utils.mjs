import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { windowsBatchInvocation } from "../src/runtime.js";

export const SMOKE_TOOLS = Object.freeze(["cargo", "go", "npm", "uv"]);
export const SMOKE_HELP = "Usage: node scripts/smoke-real-tools.mjs [--require cargo,go,npm,uv] [--json]";

export function parseSmokeOptions(args) {
  const options = { required: [], json: false, help: false };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const [name] = argument.split("=", 1);
    if (!["--require", "--json", "--help"].includes(name) || seen.has(name)) throw new Error(SMOKE_HELP);
    seen.add(name);
    if (name !== "--require") {
      if (name !== argument) throw new Error(SMOKE_HELP);
      options[name === "--json" ? "json" : "help"] = true;
      continue;
    }
    const value = argument.startsWith("--require=") ? argument.slice(10) : args[++index];
    const tools = typeof value === "string" ? value.split(",") : [];
    if (!tools.length || tools.some((tool) => !SMOKE_TOOLS.includes(tool)) || new Set(tools).size !== tools.length) throw new Error(SMOKE_HELP);
    options.required = SMOKE_TOOLS.filter((tool) => tools.includes(tool));
  }
  return options;
}

/** Fingerprint only known source roots, never arbitrary project files or .env. */
export function verificationSource(root) {
  const files = [];
  function visit(relative) {
    const file = path.join(root, relative);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error("Verification source contains a symlink");
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) visit(path.join(relative, name));
    } else if (stat.isFile()) {
      if (stat.size > 8 * 1024 * 1024 || files.length >= 1000) throw new Error("Verification source exceeds inventory limits");
      files.push({ path: relative.split(path.sep).join("/"), sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") });
    } else throw new Error("Verification source contains a special file");
  }
  for (const relative of ["bin", "src", "scripts", "package.json"]) visit(relative);
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify(files)).digest("hex");
  const git = (args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 3000, maxBuffer: 64 * 1024, windowsHide: true });
  // Never attribute an archive inside a different Git checkout to the parent.
  const top = git(["rev-parse", "--show-toplevel"]);
  let commit = null, dirty = null;
  try {
    if (top.status === 0 && fs.realpathSync(top.stdout.trim()) === fs.realpathSync(root)) {
      const revision = git(["rev-parse", "--verify", "HEAD"]);
      if (revision.status === 0 && /^[0-9a-f]{40,64}$/.test(revision.stdout.trim())) commit = revision.stdout.trim();
      const status = git(["status", "--porcelain", "--untracked-files=normal"]);
      if (status.status === 0) dirty = status.stdout.length > 0;
    }
  } catch { /* An archive still has a content fingerprint without Git identity. */ }
  return { gitCommit: commit, gitDirty: dirty, fingerprintAlgorithm: "sha256", fingerprint,
    fingerprintScope: "sorted relative paths and content digests in bin, src, scripts and package.json; not the release tarball or entire repository",
    fileCount: files.length };
}

export function parseToolVersion(tool, output) {
  const prefixes = { cargo: "cargo ", go: "go version go", npm: "", uv: "uv ", python3: "Python " };
  if (!Object.hasOwn(prefixes, tool) || typeof output !== "string" || output.length > 16384) return null;
  const first = output.trim().split(/\r?\n/, 1)[0];
  if (!first.startsWith(prefixes[tool])) return null;
  const rest = first.slice(prefixes[tool].length);
  const value = rest.match(/^(\d+\.\d+(?:\.\d+)?(?:[-+][a-zA-Z0-9.-]+)?)(?:\s|$)/)?.[1];
  return value && value.length <= 128 ? value : null;
}

export function smokeOutcome(results, required) {
  const passed = results.filter((item) => item.status === "passed").map((item) => item.tool);
  const missingRequired = required.filter((tool) => !passed.includes(tool));
  const failed = results.some((item) => item.status === "failed");
  return { ok: passed.length > 0 && !failed && missingRequired.length === 0,
    passed, missingRequired, skipped: results.filter((item) => item.status === "skipped").map((item) => item.tool) };
}

/** Execute only harness-owned fixture commands; never return child output in errors. */
export function runVerificationCommand(command, args, { cwd, env = process.env, timeoutMs = 120000, maxOutputBytes = 2 * 1024 * 1024 } = {}) {
  for (const value of [timeoutMs, maxOutputBytes]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Verification command limits must be positive safe integers");
  }
  const invocation = process.platform === "win32" && /\.(cmd|bat)$/i.test(command)
    ? windowsBatchInvocation(command, args, env) : { command, args };
  const result = spawnSync(invocation.command, invocation.args, {
    cwd, env, encoding: "utf8", timeout: timeoutMs, maxBuffer: maxOutputBytes,
    windowsHide: true, windowsVerbatimArguments: invocation.windowsVerbatimArguments || false,
    detached: process.platform !== "win32", killSignal: "SIGKILL"
  });
  if (result.error || result.status !== 0) {
    // Killing only the CLI wrapper can leave its Cargo/Go child running. A
    // dedicated POSIX process group lets a failed fixture terminate descendants.
    if (process.platform !== "win32" && Number.isInteger(result.pid) && result.pid > 0) {
      try { process.kill(-result.pid, "SIGKILL"); }
      catch (error) { if (error.code !== "ESRCH") throw Object.assign(new Error("Fixture process-group cleanup failed"), { code: "GROUP_CLEANUP_FAILED" }); }
    }
    throw Object.assign(new Error(`${path.basename(command)} failed${result.error?.code ? ` (${result.error.code})` : ""}`),
      { code: result.error?.code || "CHILD_FAILED" });
  }
  return result;
}
