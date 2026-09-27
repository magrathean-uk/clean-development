#!/usr/bin/env node
// Opt-in, credential-free request-construction experiment. No production imports.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CANARY, HOOK_CANARY, ORDINARY, comparisonValue, differences, inspectPayload, redact, sha256, startCapture } from "./capture.mjs";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const TARGET_VERSION = "2.1.283";
export const CASES = ["absent-before", "skill-inactive", "native-inactive", "combined-inactive", "native-explicit", "skill-explicit", "description-control", "hook-control", "absent-after"];
const HOSTS = ["claude", "codex", "grok", "agy", "opencode", "pi"];
const HELP = "Usage: node scripts/request-acceptance/run.mjs --preflight | --claude /absolute/claude [--expect-version 2.1.283] [--repeats 2] [--output /absolute/new-directory]";

export function options(args) {
  const result = { preflight: false, claude: null, expectedVersion: TARGET_VERSION, repeats: 2, output: null };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) throw new Error(HELP);
    seen.add(flag);
    if (flag === "--help") return { help: true };
    if (flag === "--preflight") { result.preflight = true; continue; }
    if (!["--claude", "--expect-version", "--repeats", "--output"].includes(flag) || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error(HELP);
    const value = args[++i];
    if (flag === "--claude") result.claude = value;
    if (flag === "--expect-version") result.expectedVersion = value;
    if (flag === "--repeats") result.repeats = Number(value);
    if (flag === "--output") result.output = value;
  }
  if ((!result.preflight && !result.claude) || (result.preflight && result.claude)
    || !/^\d+\.\d+\.\d+$/.test(result.expectedVersion) || ![1, 2, 3].includes(result.repeats)
    || [result.claude, result.output].some((value) => value && (!path.isAbsolute(value) || value.includes("\0")))) throw new Error(HELP);
  return result;
}

export function isolatedEnvironment(directory, binaryDirectory = "") {
  const directories = [path.dirname(process.execPath), binaryDirectory, "/usr/local/bin", "/usr/bin", "/bin"].filter(Boolean);
  return {
    PATH: [...new Set(directories)].join(path.delimiter), HOME: path.join(directory, "home"), USERPROFILE: path.join(directory, "home"),
    XDG_CONFIG_HOME: path.join(directory, "xdg-config"), XDG_DATA_HOME: path.join(directory, "xdg-data"), XDG_CACHE_HOME: path.join(directory, "xdg-cache"),
    TMPDIR: path.join(directory, "tmp"), TMP: path.join(directory, "tmp"), TEMP: path.join(directory, "tmp"),
    CLAUDE_CONFIG_DIR: path.join(directory, "claude"), CODEX_HOME: path.join(directory, "codex"), GROK_HOME: path.join(directory, "grok"),
    CLEAN_DEVELOPMENT_HOME: path.join(directory, "home"), CLEAN_DEVELOPMENT_CONFIG_HOME: path.join(directory, "product-config"),
    CLEAN_DEVELOPMENT_DATA_HOME: path.join(directory, "product-data"), CLEAN_DEVELOPMENT_ROOT: path.join(directory, "managed"),
    DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(directory, "gitconfig"), LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC", TERM: "dumb"
  };
}

export function prepareDirectories(directory, env) {
  fs.mkdirSync(directory, { mode: 0o700 });
  for (const value of Object.values(env)) if (value.startsWith(`${directory}${path.sep}`) && value !== env.GIT_CONFIG_GLOBAL) fs.mkdirSync(value, { recursive: true, mode: 0o700 });
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL, "", { flag: "wx", mode: 0o600 });
}

export function runChild(command, args, { cwd, env, timeoutMs = 60000, maxBytes = 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid process limits");
  return new Promise((resolve) => {
    const out = [], err = [];
    let bytes = 0, failure = null, killTimer, settled = false;
    const child = spawn(command, args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    const finish = (code, signal) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(killTimer);
      resolve({ code, signal, failure, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    };
    const terminate = (reason) => {
      if (failure) return;
      failure = reason;
      if (child.pid) {
        try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL"); }
        catch (error) { if (error.code !== "ESRCH") failure = `${reason}:termination-uncertain`; }
      }
      killTimer = setTimeout(() => {
        failure = `${failure}:close-unconfirmed`;
        child.stdout.destroy(); child.stderr.destroy(); child.unref();
        finish(null, null); // Never a passing experiment; retain the disposable fixture.
      }, 2000);
    };
    const timer = setTimeout(() => terminate("timeout"), timeoutMs);
    const collect = (chunks, chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) { terminate("output-limit"); return; }
      chunks.push(chunk);
    };
    child.stdout.on("data", (chunk) => collect(out, chunk));
    child.stderr.on("data", (chunk) => collect(err, chunk));
    child.on("error", (error) => { failure = /^[A-Z0-9_]+$/.test(error.code || "") ? error.code : "spawn-error"; });
    child.on("close", finish);
  });
}

function write(directory, name, value) {
  fs.writeFileSync(path.join(directory, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

function productFingerprint() {
  const paths = ["src", "bin", "marketplace/claude", "scripts/request-acceptance"];
  const entries = [];
  const walk = (relative) => {
    const full = path.join(ROOT, relative), stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error("Symlink in experiment source");
    if (stat.isDirectory()) for (const name of fs.readdirSync(full).sort()) walk(`${relative}/${name}`);
    else if (stat.isFile()) entries.push([relative, sha256(fs.readFileSync(full))]);
    else throw new Error("Unsupported experiment source entry");
  };
  for (const relative of paths) walk(relative);
  return { sha256: sha256(JSON.stringify(entries)), fileCount: entries.length };
}

function sourceIdentity() {
  const get = (args) => {
    const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", timeout: 3000 });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  return { localCommit: get(["rev-parse", "HEAD"]), localTree: get(["rev-parse", "HEAD^{tree}"]), dirty: Boolean(get(["status", "--porcelain"])), fingerprint: productFingerprint() };
}

export function nativeHookObserved(stdout) {
  return stdout.split("\n").some((line) => {
    try { const event = JSON.parse(line); return event.type === "system" && event.subtype === "hook_response" && /^SessionStart/.test(event.hook_name || "") && event.exit_code === 0; }
    catch { return false; }
  });
}

export function evaluate(cases, repeats) {
  const reasons = [], comparisons = [];
  if (!Array.isArray(cases) || ![1, 2, 3].includes(repeats)) throw new Error("Invalid acceptance matrix");
  if (cases.length !== CASES.length * repeats) reasons.push("unexpected-case-count");
  for (let repeat = 0; repeat < repeats; repeat++) {
    const batch = cases.filter((item) => item.repeat === repeat);
    if (batch.length !== CASES.length || CASES.some((name) => batch.filter((item) => item.name === name).length !== 1)) { reasons.push("missing-case"); continue; }
    if (batch.some((item) => item.status !== "captured" || !Array.isArray(item.requests) || item.requests.length === 0 || item.requests.some((entry) => !entry.comparison || !entry.observation))) { reasons.push("incomplete-host-capture"); continue; }
    const get = (name) => batch.find((item) => item.name === name);
    const generated = (name) => get(name).requests.filter((item) => item.endpoint === "/v1/messages");
    if (batch.some((item) => !generated(item.name).some((entry) => entry.observation.ordinaryPromptPresent))) reasons.push("generation-request-missing");
    if (!generated("skill-explicit").some((item) => item.observation.bodyPresent)) reasons.push("explicit-skill-body-not-observed");
    if (!generated("description-control").some((item) => item.observation.descriptionCanaryPresent)) reasons.push("description-positive-control-missing");
    if (!generated("hook-control").some((item) => item.observation.hookCanaryPresent)) reasons.push("hook-positive-control-missing");
    const baseline = get("absent-before");
    const sequence = (item) => item.requests.map((entry) => ({ endpoint: entry.endpoint, body: entry.comparison }));
    const repeatDiff = differences(sequence(baseline), sequence(get("absent-after")));
    comparisons.push({ repeat, case: "absent-after", changedPointers: repeatDiff, equal: repeatDiff.length === 0 });
    if (repeatDiff.length) reasons.push("absent-controls-differ");
    if ([baseline, get("absent-after")].some((item) => item.requests.some((entry) => entry.observation.productReferencePresent))) reasons.push("absent-control-contaminated");
    for (const name of ["skill-inactive", "native-inactive", "combined-inactive", "native-explicit"]) {
      const item = get(name), diff = differences(sequence(baseline), sequence(item));
      comparisons.push({ repeat, case: name, changedPointers: diff, equal: diff.length === 0 });
      if (item.requests.some((entry) => entry.observation.productReferencePresent)) reasons.push(`${name}:product-text-observed`);
      if (diff.length) reasons.push(`${name}:request-difference-requires-review`);
    }
  }
  return { status: reasons.length ? "inconclusive-or-difference" : "observed-equal-in-tested-scope", reasons: [...new Set(reasons)], comparisons,
    billedTokenNeutrality: "unproven", productionInference: "not-tested", crossHostAcceptance: "unproven" };
}

export function prepareMarketplace(directory, bundle, descriptionControl = false) {
  const catalog = path.join(directory, "marketplace"), copy = path.join(catalog, "clean-development");
  fs.mkdirSync(catalog, { mode: 0o700 });
  fs.cpSync(bundle, copy, { recursive: true });
  fs.mkdirSync(path.join(catalog, ".claude-plugin"));
  fs.writeFileSync(path.join(catalog, ".claude-plugin/marketplace.json"), JSON.stringify({
    name: "request-acceptance-local", owner: { name: "Disposable acceptance fixture" },
    plugins: [{ name: "clean-development", source: "./clean-development" }]
  }), { mode: 0o600, flag: "wx" });
  if (descriptionControl) {
    const file = path.join(copy, "skills/clean-development/SKILL.md");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("disable-model-invocation: true\n", "").replace(/^description: .*$/m, `description: ${CANARY}`));
  }
  return catalog;
}

export async function executeCase({ name, repeat, lab, binary, bundle, skill, replacements = [] }) {
  if (!CASES.includes(name) || !Number.isSafeInteger(repeat) || repeat < 0 || repeat > 2) throw new Error("Invalid case");
  const directory = path.join(lab, `r${repeat}-${name}`), env = isolatedEnvironment(directory, path.dirname(binary));
  prepareDirectories(directory, env);
  const project = path.join(directory, "project"); fs.mkdirSync(project, { mode: 0o700 }); fs.mkdirSync(path.join(project, ".git"));
  fs.writeFileSync(path.join(project, "package.json"), '{"name":"request-fixture","private":true}\n', { mode: 0o600 });
  const native = ["native-inactive", "combined-inactive", "native-explicit"].includes(name);
  const plugin = ["skill-inactive", "combined-inactive", "skill-explicit", "description-control"].includes(name);
  const settingsPath = path.join(env.CLAUDE_CONFIG_DIR, "settings.json");
  const result = { name, repeat, native, plugin, explicit: name.endsWith("explicit"), status: "blocked", reason: null, hostSessionAttempted: false, requests: [] };
  if (native) {
    const setup = await runChild(process.execPath, [path.join(ROOT, "bin/clean-development.js"), "setup", "--root", env.CLEAN_DEVELOPMENT_ROOT, "--agents", "claude", "--json"], { cwd: project, env });
    let receipt;
    try { receipt = JSON.parse(setup.stdout); } catch { /* no valid setup evidence */ }
    if (setup.code !== 0 || !receipt?.integrations?.some((item) => item.agent === "claude" && item.mode === "native-hook")) {
      result.reason = "native-setup-not-established"; return result;
    }
    result.nativeSetup = "receipt-verified";
  } else fs.writeFileSync(settingsPath, "{}\n", { mode: 0o600 });
  if (plugin) {
    const catalog = prepareMarketplace(directory, bundle, name === "description-control");
    result.pluginInstallation = [];
    for (const args of [["plugin", "marketplace", "add", catalog], ["plugin", "install", "clean-development@request-acceptance-local", "--scope", "user"]]) {
      const installed = await runChild(binary, args, { cwd: project, env });
      result.pluginInstallation.push({ command: redact(args, [[directory, "<LANE>"]]).value, exitCode: installed.code, failure: installed.failure });
      write(directory, `plugin-install-${result.pluginInstallation.length}.redacted.json`, redact({ stdout: installed.stdout, stderr: installed.stderr }, [[directory, "<LANE>"], ...replacements]));
      if (installed.failure || installed.code !== 0) { result.reason = "plugin-installation-not-established"; return result; }
    }
    const installedSettings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    if (installedSettings.enabledPlugins?.["clean-development@request-acceptance-local"] !== true) {
      result.reason = "installed-plugin-not-enabled"; return result;
    }
  }
  if (name === "hook-control") {
    const file = path.join(directory, "control-hook.cjs");
    fs.writeFileSync(file, `process.stdout.write(${JSON.stringify(`${HOOK_CANARY}\n`)});\n`, { mode: 0o600 });
    const quote = (text) => `'${text.replaceAll("'", `'"'"'`)}'`;
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: `${quote(process.execPath)} ${quote(file)}` }] }] } }));
  }
  const beforeSettings = sha256(fs.readFileSync(settingsPath)), beforeProject = sha256(fs.readFileSync(path.join(project, "package.json")));
  const capture = await startCapture();
  try {
    Object.assign(env, { ANTHROPIC_BASE_URL: capture.url, ANTHROPIC_API_KEY: capture.token });
    if (name === "native-explicit") env.CLEAN_DEVELOPMENT_SESSION_MODE = "session-only";
    const args = ["--print", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--max-turns", "1", "--model", "claude-sonnet-5",
      "--setting-sources", "", "--settings", settingsPath, "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--permission-prompts", "none"];
    args.push(name === "skill-explicit" ? `/clean-development:clean-development ${ORDINARY}` : ORDINARY);
    result.hostSessionAttempted = true;
    const child = await runChild(binary, args, { cwd: project, env });
    const localRedactions = [[directory, "<LANE>"], [capture.url, "<LOOPBACK>"], [capture.token, "<FIXTURE_CREDENTIAL>"], ...replacements];
    write(directory, "cli-output.redacted.json", redact({ stdout: child.stdout, stderr: child.stderr }, localRedactions));
    result.command = redact({ executable: binary, args, cwd: project }, localRedactions).value;
    result.process = { exitCode: child.code, signal: child.signal, failure: child.failure };
    result.nativeHookObserved = native ? nativeHookObserved(child.stdout) : null;
    result.captureErrors = [...capture.errors];
    result.settingsUnchanged = beforeSettings === sha256(fs.readFileSync(settingsPath));
    result.projectUnchanged = beforeProject === sha256(fs.readFileSync(path.join(project, "package.json"))) && fs.readdirSync(project).sort().join(",") === ".git,package.json";
    for (const entry of capture.requests) {
      const observation = inspectPayload(entry.payload, skill), redacted = redact(entry.payload, localRedactions);
      const file = `request-${entry.sequence}.redacted.json`;
      write(directory, file, redacted);
      result.requests.push({ endpoint: entry.endpoint, rawSha256: entry.rawSha256, rawBytes: entry.rawBytes, observation,
        captureFile: `${path.basename(directory)}/${file}`, redactions: redacted.edits,
        comparison: comparisonValue(entry.payload, directory) });
    }
    const generated = result.requests.filter((entry) => entry.endpoint === "/v1/messages");
    if (child.failure || child.code !== 0) result.reason = "host-execution-failed";
    else if (capture.errors.length) result.reason = "capture-protocol-errors";
    else if (!generated.length || !generated.some((entry) => entry.observation.ordinaryPromptPresent)) result.reason = "ordinary-model-request-not-captured";
    else if (!result.projectUnchanged || !result.settingsUnchanged) result.reason = "fixture-changed";
    else if (native && !result.nativeHookObserved) result.reason = "native-hook-execution-unproven";
    else { result.status = "captured"; result.reason = null; }
    return result;
  } finally { await capture.close(); }
}

export async function main(args) {
  const settings = options(args);
  if (settings.help) { console.log(HELP); return 0; }
  const output = settings.output || path.join(fs.realpathSync(os.tmpdir()), `cd-request-${Date.now()}-${process.pid}`);
  fs.mkdirSync(output, { mode: 0o700 }); // Exclusive, no overwrite or automatic removal.
  const report = { schemaVersion: 1, startedAt: new Date().toISOString(), environment: { platform: process.platform, arch: process.arch, node: process.version, osRelease: os.release() },
    source: sourceIdentity(), captureMechanism: "documented ANTHROPIC_BASE_URL, loopback Anthropic-compatible fixture; no upstream forwarding",
    targetHostVersion: settings.expectedVersion, observedHostVersion: null, hostBinarySha256: null, hostCasesExecuted: 0,
    claims: { requestText: "unproven", billedTokens: "unproven", cliOutput: "not-a-request-capture", metadata: "not-acceptance-evidence" }, cases: [] };
  const finish = (code) => {
    report.finishedAt = new Date().toISOString();
    report.sourceUnchanged = report.source.fingerprint.sha256 === productFingerprint().sha256;
    if (!report.sourceUnchanged) { report.claims.requestText = "unproven-source-changed"; code = 1; }
    // Comparison snapshots are private memory only; redact captures independently.
    const published = structuredClone(report);
    for (const item of published.cases) for (const request of item.requests || []) delete request.comparison;
    write(output, "report.json", published);
    console.log(JSON.stringify({ report: path.join(output, "report.json"), status: report.claims.requestText, hostCasesExecuted: report.hostCasesExecuted, billedTokenNeutrality: "unproven" }));
    return code;
  };
  const preflightDir = path.join(output, "preflight"), env = isolatedEnvironment(preflightDir, settings.claude ? path.dirname(settings.claude) : "");
  prepareDirectories(preflightDir, env);
  if (settings.preflight) {
    report.preflight = [];
    for (const name of HOSTS) {
      const probe = await runChild(name, ["--version"], { cwd: preflightDir, env, timeoutMs: 5000, maxBytes: 16384 });
      const version = probe.code === 0 ? probe.stdout.match(/\b\d+\.\d+\.\d+\b/)?.[0] || null : null;
      report.preflight.push({ host: name, observedVersion: version, status: version ? "available-not-tested" : "unavailable", error: probe.failure });
    }
    report.blocker = "preflight-only-no-payload-captured";
    report.cases = CASES.map((name) => ({ name, status: "blocked", reason: "no-host-session", requests: [] }));
    return finish(2);
  }
  if (process.platform === "win32") { report.blocker = "automated-driver-is-posix-only"; return finish(2); }
  // HOME is not policy isolation: decline known machine-wide managed settings.
  if (["/etc/claude-code/managed-settings.json", "/Library/Application Support/ClaudeCode/managed-settings.json"].some((file) => fs.existsSync(file))) {
    report.blocker = "machine-managed-settings-present-use-disposable-runner"; return finish(2);
  }
  let binary;
  try { binary = fs.realpathSync(settings.claude); report.hostBinarySha256 = sha256(fs.readFileSync(binary)); }
  catch { report.blocker = "host-binary-unavailable"; return finish(2); }
  const version = await runChild(binary, ["--version"], { cwd: preflightDir, env, timeoutMs: 10000, maxBytes: 16384 });
  report.observedHostVersion = version.code === 0 ? version.stdout.match(/\b\d+\.\d+\.\d+\b/)?.[0] || null : null;
  if (report.observedHostVersion !== settings.expectedVersion) { report.blocker = "exact-host-version-not-established"; return finish(2); }
  const bundle = path.join(ROOT, "marketplace/claude"), contents = fs.readFileSync(path.join(bundle, "skills/clean-development/SKILL.md"), "utf8");
  const skill = { body: contents.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim(), description: contents.match(/^description: (.+)$/m)?.[1] };
  if (!skill.body || !skill.description) throw new Error("Skill fixture unavailable");
  const replacements = [[ROOT.replace(/\/$/, ""), "<SOURCE>"], [binary, "<CLAUDE_BINARY>"], [os.homedir(), "<OPERATOR_HOME>"], [os.hostname(), "<HOSTNAME>"]];
  for (let repeat = 0; repeat < settings.repeats; repeat++) {
    // Reverse order on alternate repetitions, retaining independent homes.
    for (const name of repeat % 2 ? [...CASES].reverse() : CASES) {
      const item = await executeCase({ name, repeat, lab: output, binary, bundle, skill, replacements });
      report.cases.push(item);
      if (item.hostSessionAttempted) report.hostCasesExecuted++;
    }
  }
  report.evaluation = evaluate(report.cases, settings.repeats);
  report.binaryUnchanged = report.hostBinarySha256 === sha256(fs.readFileSync(binary));
  report.claims.requestText = report.binaryUnchanged ? report.evaluation.status : "unproven-host-changed";
  return finish(report.evaluation.status === "observed-equal-in-tested-scope" && report.binaryUnchanged ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) { console.error(error.message === HELP ? HELP : "Request experiment failed; retain its private fixture for inspection."); process.exitCode = 2; }
}
