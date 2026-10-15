// Explicit, single-call, API-authenticated smoke protocol. Importing this file
// and test discovery are inert; only the execute action can launch Claude.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeFixture, loadFixture, setup, preflight, sourceIdentity, cli, observer, quote, evidence, evaluate, intact } from "./fixture.mjs";

export const SMOKE_CASE = "claude-api-session-only";
export const SMOKE_BUDGET_USD = 0.1;
export const SMOKE_TIMEOUT_MS = 120_000;
export const SMOKE_SHUTDOWN_GRACE_MS = 3_000;
export const SMOKE_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const PLAN_NAME = "claude-smoke-plan.json";
const ENTRY_NAME = "claude-smoke-observer.sh";
const WITNESS_NAME = "claude-smoke-session-witness.mjs";
const WITNESS_EVIDENCE_NAME = "claude-smoke-session-witness.json";
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function executable(file, label) {
  assert.ok(path.isAbsolute(file), `${label} must be an absolute path`);
  const stat = fs.statSync(file);
  assert.ok(stat.isFile(), `${label} must name a file`);
  fs.accessSync(file, fs.constants.X_OK);
  return { path: file, realpath: fs.realpathSync(file) };
}

export function validateSmokeOptions({ claude, cargo, rustc, model }) {
  for (const [label, file] of [["Claude executable", claude], ["Cargo executable", cargo], ["rustc executable", rustc]]) {
    assert.equal(typeof file, "string", `${label} must be an absolute path`);
  }
  const tools = {
    claude: executable(claude, "Claude executable"),
    cargo: executable(cargo, "Cargo executable"),
    rustc: executable(rustc, "rustc executable")
  };
  assert.equal(typeof model, "string", "Supply an explicit model identifier with --model");
  assert.match(model, /^[a-zA-Z0-9._:-]+$/, "Supply one explicit model identifier");
  return { tools, model };
}

export function observerEntryText() {
  return `#!/bin/sh\nset -eu\nunset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR\nexec ${quote(process.execPath)} ${quote(observer)} observe ${quote(SMOKE_CASE)}\n`;
}

export function observerCommand(entry) {
  return `/bin/sh ${quote(entry)}`;
}

export function sessionWitnessText() {
  return `import fs from "node:fs";\nimport path from "node:path";\nconst output = process.argv[2];\nlet input = "";\nfor await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 65536) throw new Error("event input too large"); }\nconst event = JSON.parse(input);\nif (typeof event.session_id !== "string" || typeof event.hook_event_name !== "string" || typeof process.env.CLAUDE_ENV_FILE !== "string") throw new Error("required event fields absent");\nconst record = { sessionId: event.session_id, event: event.hook_event_name, source: typeof event.source === "string" ? event.source : null, envFile: path.resolve(process.env.CLAUDE_ENV_FILE) };\nfs.writeFileSync(output, JSON.stringify(record) + "\\n", { flag: "wx", mode: 0o600 });\n`;
}

function installSessionWitness(item) {
  const script = path.join(item.root, WITNESS_NAME);
  const output = path.join(item.root, "evidence", WITNESS_EVIDENCE_NAME);
  fs.writeFileSync(script, sessionWitnessText(), { flag: "wx", mode: 0o600 });
  const configFile = path.join(item.env.CLAUDE_CONFIG_DIR, "settings.json");
  const settings = boundedReadJson(configFile);
  assert.ok(Array.isArray(settings.hooks?.SessionStart), "Disposable SessionStart hooks are absent");
  const command = `${quote(process.execPath)} ${quote(script)} ${quote(output)}`;
  settings.hooks.SessionStart.push({ matcher: "startup|resume|fork", hooks: [{ type: "command", command }] });
  fs.writeFileSync(configFile, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  return { script, output, command };
}

export function smokeHostArgs({ command, model, sessionId }) {
  assert.match(sessionId, SESSION_ID_RE, "Session ID must be a UUID");
  assert.ok(command.startsWith("/bin/sh "), "Observer command must use the fixed POSIX shell entry");
  assert.match(model, /^[a-zA-Z0-9._:-]+$/);
  return [
    "--print", "--output-format", "stream-json", "--verbose", "--include-hook-events",
    "--model", model, "--max-budget-usd", SMOKE_BUDGET_USD.toFixed(2), "--no-session-persistence",
    "--tools", "Bash", "--allowedTools", `Bash(${command})`, "--permission-mode", "dontAsk",
    "--setting-sources", "user", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--session-id", sessionId,
    `Run exactly this single Bash command once: ${command}\nThis is an authorized, tiny offline Rust routing test in a disposable project. Do not inspect files, change code, delegate, or execute any other command. After success reply only OK. If execution fails, report it and stop. Do not retry.`
  ];
}

function boundedReadJson(file, maxBytes = 256 * 1024) {
  const before = fs.lstatSync(file, { bigint: true });
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.size <= BigInt(maxBytes), "Smoke metadata must be a bounded regular file");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    assert.ok(opened.isFile() && opened.dev === before.dev && opened.ino === before.ino && opened.size <= BigInt(maxBytes), "Smoke metadata changed before read");
    const content = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < content.length) {
      const count = fs.readSync(fd, content, offset, content.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    const current = fs.lstatSync(file, { bigint: true });
    for (const observed of [after, current]) {
      assert.ok(observed.isFile() && !observed.isSymbolicLink()
        && ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every((key) => observed[key] === opened[key]), "Smoke metadata changed during read");
    }
    assert.ok(offset <= maxBytes && BigInt(offset) === opened.size, "Smoke metadata was truncated or exceeded its read bound");
    return JSON.parse(content.subarray(0, offset).toString("utf8"));
  } finally { fs.closeSync(fd); }
}

function writeExclusive(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

function writeExclusiveEvidence(root, name, value) {
  assert.match(name, /^[a-z0-9-]+\.json$/);
  const directory = path.join(root, "evidence");
  const stat = fs.lstatSync(directory);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && fs.realpathSync(directory) === directory, "Evidence directory must remain inside the disposable lab");
  writeExclusive(path.join(directory, name), value);
}

export function claimSmokeExecution(root, plan) {
  const claim = { schemaVersion: 1, sessionId: plan.sessionId, planSha256: sha256(JSON.stringify(plan)), claimedAt: new Date().toISOString(), pid: process.pid };
  writeExclusiveEvidence(root, "claude-smoke-execution.json", claim);
  return claim;
}

const REQUIRED_CLI_FEATURES = [
  ["--print", /--print\b/],
  ["stream-json output", /--output-format\s+<format>[\s\S]*?stream-json/],
  ["hook events", /--include-hook-events\b/],
  ["print-mode API budget", /--max-budget-usd\s+<amount>[\s\S]*?only works with --print/],
  ["no session persistence", /--no-session-persistence\b/],
  ["Bash tool selection", /--tools\s+<tools\.\.\.>[\s\S]*?Bash/],
  ["allowed tool restriction", /--allowedTools|--allowed-tools/],
  ["permission mode", /--permission-mode\s+<mode>[\s\S]*?dontAsk/],
  ["setting source restriction", /--setting-sources\s+<sources>/],
  ["strict MCP configuration", /--strict-mcp-config\b/],
  ["MCP configuration", /--mcp-config\s+<configs/],
  ["explicit session ID", /--session-id\s+<uuid>/]
];

export function validateCliHelp(helpText) {
  assert.equal(typeof helpText, "string");
  const missing = REQUIRED_CLI_FEATURES.filter(([, expression]) => !expression.test(helpText)).map(([name]) => name);
  assert.deepEqual(missing, [], `Installed Claude CLI lacks required smoke features: ${missing.join(", ")}`);
  return true;
}

function readCliHelp(host, env, cwd) {
  const result = spawnSync(host, ["--help"], { env, cwd, encoding: "utf8", timeout: 5000, maxBuffer: 128 * 1024 });
  assert.equal(result.status, 0, "Could not inspect installed Claude CLI help");
  validateCliHelp(result.stdout || "");
  return result.stdout;
}

export function prepareSmoke({ claude, cargo, rustc, model }) {
  assert.notEqual(process.platform, "win32", "The live smoke protocol currently requires POSIX process groups");
  const selected = validateSmokeOptions({ claude, cargo, rustc, model });
  const item = makeFixture({ backend: "live", cargo: selected.tools.cargo.path });
  fs.chmodSync(item.root, 0o700);
  item.claude = selected.tools.claude.path;
  item.cargo = selected.tools.cargo.path;
  item.toolIdentity = selected.tools;
  item.env.RUSTC = selected.tools.rustc.path;
  item.env.PATH += `:${path.dirname(item.claude)}`;
  fs.writeFileSync(path.join(item.root, "lab.json"), `${JSON.stringify({ ...item, source: sourceIdentity() }, null, 2)}\n`, { mode: 0o600 });

  const host = preflight(item);
  assert.ok(host.claude.available && host.cargo.available && host.rustc.available, "Isolated live-tool preflight failed; inspect the disposable evidence");
  assert.equal(host.claude.version, runVersion(item.claude, item.env), "Claude version changed during preparation");
  const cliHelp = readCliHelp(item.claude, item.env, item.projects.normal);
  setup(item);
  const witness = installSessionWitness(item);

  const entry = path.join(item.root, ENTRY_NAME);
  fs.writeFileSync(entry, observerEntryText(), { flag: "wx", mode: 0o700 });
  const command = observerCommand(entry);
  const sessionId = crypto.randomUUID();
  const plan = {
    schemaVersion: 1,
    root: item.root,
    name: SMOKE_CASE,
    entry,
    command,
    witness,
    host: item.claude,
    tools: item.toolIdentity,
    model,
    budgetUsd: SMOKE_BUDGET_USD,
    timeoutMs: SMOKE_TIMEOUT_MS,
    shutdownGraceMs: SMOKE_SHUTDOWN_GRACE_MS,
    sessionId,
    args: smokeHostArgs({ command, model, sessionId }),
    source: sourceIdentity(),
    hostVersion: host.claude.version,
    cliHelpSha256: sha256(cliHelp)
  };
  writeExclusive(path.join(item.root, PLAN_NAME), plan);
  return { root: item.root, plan: path.join(item.root, PLAN_NAME), hostVersion: plan.hostVersion, model, budgetUsd: plan.budgetUsd, timeoutMs: plan.timeoutMs };
}

function runVersion(host, env) {
  const result = spawnSync(host, ["--version"], { env, encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024 });
  assert.equal(result.status, 0, "Could not recheck Claude version");
  return result.stdout.trim();
}

export function validatePreparedSmoke(item, plan) {
  assert.equal(item.backend, "live");
  assert.equal(plan.schemaVersion, 1);
  assert.equal(plan.root, item.root);
  assert.equal(plan.name, SMOKE_CASE);
  assert.equal(plan.budgetUsd, SMOKE_BUDGET_USD);
  assert.equal(plan.timeoutMs, SMOKE_TIMEOUT_MS);
  assert.equal(plan.shutdownGraceMs, SMOKE_SHUTDOWN_GRACE_MS);
  assert.equal(plan.host, item.claude);
  assert.equal(plan.tools?.claude?.path, item.claude);
  assert.equal(plan.tools?.claude?.realpath, fs.realpathSync(item.claude));
  assert.equal(plan.tools?.cargo?.realpath, fs.realpathSync(item.cargo));
  assert.equal(plan.tools?.rustc?.realpath, fs.realpathSync(item.env.RUSTC));
  assert.equal(item.cargo, plan.tools.cargo.path);
  assert.equal(item.env.RUSTC, plan.tools.rustc.path);
  assert.match(plan.model, /^[a-zA-Z0-9._:-]+$/);
  assert.match(plan.sessionId, SESSION_ID_RE);
  const entry = path.join(item.root, ENTRY_NAME);
  const stat = fs.lstatSync(entry);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o111) !== 0, "Observer entry must be an executable regular file");
  assert.equal(fs.readFileSync(entry, "utf8"), observerEntryText(), "Observer entry changed");
  const command = observerCommand(entry);
  assert.equal(plan.entry, entry);
  assert.deepEqual(plan.witness, { script: path.join(item.root, WITNESS_NAME), output: path.join(item.root, "evidence", WITNESS_EVIDENCE_NAME),
    command: `${quote(process.execPath)} ${quote(path.join(item.root, WITNESS_NAME))} ${quote(path.join(item.root, "evidence", WITNESS_EVIDENCE_NAME))}` });
  assert.equal(fs.readFileSync(plan.witness.script, "utf8"), sessionWitnessText(), "Session witness changed");
  const settings = boundedReadJson(path.join(item.env.CLAUDE_CONFIG_DIR, "settings.json"));
  assert.ok(settings.hooks.SessionStart.some((group) => group.hooks?.some((hook) => hook.command === plan.witness.command)), "Disposable session witness hook changed");
  assert.equal(plan.command, command);
  assert.ok(sameJson(plan.args, smokeHostArgs({ command, model: plan.model, sessionId: plan.sessionId })), "Prepared Claude argv changed");
  assert.ok(sameJson(plan.source, sourceIdentity()), "Source identity changed since preparation");
  return { item, plan, command };
}

function processGroupSignal(pid, signal) {
  if (!pid) return false;
  try { process.kill(-pid, signal); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

function processGroupAlive(pid) {
  if (!pid) return false;
  try { process.kill(-pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

export async function runBounded(command, args, { cwd, env, expectedCommand = null, timeoutMs = SMOKE_TIMEOUT_MS, shutdownGraceMs = SMOKE_SHUTDOWN_GRACE_MS, maxOutputBytes = SMOKE_MAX_OUTPUT_BYTES } = {}) {
  assert.notEqual(process.platform, "win32", "Live smoke process-group control requires POSIX");
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const outputHash = crypto.createHash("sha256");
  const stderrHash = crypto.createHash("sha256");
  const collector = createStreamCollector(expectedCommand);
  let stdoutBytes = 0, stderrBytes = 0, overflow = false, timedOut = false, status = null, signal = null, errorCode = null;
  let stdoutTail = "", finished = false;
  let discarded = false;
  const timers = [];
  let resolveRun;
  const completed = new Promise((resolve) => { resolveRun = resolve; });
  const clearTimers = () => timers.splice(0).forEach(clearTimeout);
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimers();
    child.stdout.destroy(); child.stderr.destroy();
    resolveRun();
  };
  const terminate = (reason) => {
    if (finished || timedOut || overflow || errorCode) return;
    discarded = true;
    if (reason === "timeout") timedOut = true;
    else if (reason === "output-limit") overflow = true;
    else errorCode = reason;
    if (child.pid) processGroupSignal(child.pid, "SIGTERM");
    timers.push(setTimeout(() => { if (child.pid) processGroupSignal(child.pid, "SIGKILL"); }, Math.max(1, shutdownGraceMs - 1000)));
    timers.push(setTimeout(finish, shutdownGraceMs));
  };
  child.stdout.on("data", (chunk) => {
    stdoutBytes += chunk.length; outputHash.update(chunk);
    if (discarded) return;
    if (stdoutBytes + stderrBytes > maxOutputBytes) { terminate("output-limit"); return; }
    stdoutTail += chunk.toString("utf8");
    let newline;
    while ((newline = stdoutTail.indexOf("\n")) >= 0) {
      const line = stdoutTail.slice(0, newline); stdoutTail = stdoutTail.slice(newline + 1);
      collector.accept(line);
    }
  });
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length; stderrHash.update(chunk);
    if (stdoutBytes + stderrBytes > maxOutputBytes) terminate("output-limit");
  });
  child.on("error", (error) => { errorCode = error.code || "SPAWN_ERROR"; finish(); });
  child.on("close", (code, receivedSignal) => {
    status = code; signal = receivedSignal;
    if (processGroupAlive(child.pid)) {
      if (!timedOut && !overflow && !errorCode) processGroupSignal(child.pid, "SIGTERM");
      timers.push(setTimeout(() => { if (processGroupAlive(child.pid)) processGroupSignal(child.pid, "SIGKILL"); }, Math.max(1, shutdownGraceMs - 1000)));
      timers.push(setTimeout(finish, shutdownGraceMs));
    } else finish();
  });
  timers.push(setTimeout(() => terminate("timeout"), timeoutMs));
  await completed;
  if (stdoutTail && !discarded) collector.accept(stdoutTail);
  const alive = processGroupAlive(child.pid);
  return {
    status, signal, errorCode: timedOut ? "ETIMEDOUT" : overflow ? "MAX_OUTPUT" : errorCode,
    timedOut, overflow, lifetime: !alive && status !== null ? "quiescent" : "uncertain",
    stdoutBytes, stderrBytes, stdoutSha256: outputHash.digest("hex"), stderrSha256: stderrHash.digest("hex"),
    ...collector.result()
  };
}

export function createStreamCollector(expectedCommand = null) {
  let sessionId = null, model = null, resultSubtype = null, totalCostUsd = null, eventCount = 0, invalidLines = 0, mixedSessions = false, resultCount = 0;
  const sessionIds = new Set();
  const events = [], tools = [], completions = [], hooks = [], usage = [];
  return {
    accept(line) {
      if (!line) return;
      let event;
      try { event = JSON.parse(line); } catch { invalidLines += 1; return; }
      if (!isRecord(event)) { invalidLines += 1; return; }
      eventCount += 1;
      if (eventCount > 10_000) { invalidLines += 1; return; }
      if (typeof event.session_id === "string") {
        const id = event.session_id.slice(0, 200);
        sessionIds.add(id);
        if (sessionIds.size > 1) mixedSessions = true;
        sessionId = id;
      }
      if (typeof event.model === "string") model = event.model.slice(0, 200);
      if (events.length < 1000) events.push({ type: typeof event.type === "string" ? event.type : null, subtype: typeof event.subtype === "string" ? event.subtype : null });
      const short = (value) => typeof value === "string" ? value.slice(0, 200) : null;
      if (event.type === "system" && typeof event.subtype === "string" && event.subtype.startsWith("hook") && hooks.length < 100) {
        const success = event.exit_code === 0 || event.outcome === "success";
        hooks.push({ type: event.type, subtype: event.subtype, event: short(event.hook_event), name: short(event.hook_name),
          id: short(event.hook_id), sessionId: short(event.session_id),
          exitCode: typeof event.exit_code === "number" ? event.exit_code : null, outcome: typeof event.outcome === "string" ? short(event.outcome) : null, success });
      }
      const content = event.message?.content;
      if (content !== undefined && !Array.isArray(content)) { invalidLines += 1; return; }
      for (const block of content || []) {
        if (!isRecord(block)) continue;
        if (block.type === "tool_use" && tools.length < 100) {
          tools.push({ id: typeof block.id === "string" ? block.id.slice(0, 200) : null, sessionId: typeof event.session_id === "string" ? event.session_id.slice(0, 200) : null,
            name: typeof block.name === "string" ? block.name.slice(0, 100) : null,
            commandMatched: block.name === "Bash" && block.input?.command === expectedCommand });
        }
        if (block.type === "tool_result" && completions.length < 100) {
          completions.push({ id: typeof block.tool_use_id === "string" ? block.tool_use_id.slice(0, 200) : null,
            sessionId: typeof event.session_id === "string" ? event.session_id.slice(0, 200) : null, isError: block.is_error === true });
        }
      }
      if (event.type === "result") {
        resultCount += 1;
        if (resultCount > 1) invalidLines += 1;
        resultSubtype = typeof event.subtype === "string" ? event.subtype : null;
        if (typeof event.total_cost_usd === "number" && Number.isFinite(event.total_cost_usd)) totalCostUsd = event.total_cost_usd;
        const modelUsage = isRecord(event.modelUsage) ? Object.values(event.modelUsage).slice(0, 100) : [];
        for (const obj of [event.usage, ...modelUsage]) {
          if (!isRecord(obj)) continue;
          if (usage.length >= 100) break;
          usage.push(Object.fromEntries(Object.entries(obj).slice(0, 100).filter(([key, value]) => /token|cost/i.test(key) && typeof value === "number" && Number.isFinite(value))));
        }
      }
    },
    result() { return { sessionId, sessionIds: [...sessionIds], mixedSessions, model, resultSubtype, totalCostUsd, eventCount, invalidLines, resultCount, events, tools, completions, hooks, usage }; }
  };
}

function checkLiveEvidence(item, plan, result) {
  const value = evidence(item, SMOKE_CASE);
  const receiptFile = path.join(item.root, "data", "state", "integrations.json");
  const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
  const integration = receipt.integrations.find((entry) => entry.agent === "claude");
  assert.ok(integration?.ownershipId, "Claude integration ownership receipt is absent");
  const configFile = path.join(item.env.CLAUDE_CONFIG_DIR, "settings.json");
  const settings = JSON.parse(fs.readFileSync(configFile, "utf8"));
  const command = settings.hooks.SessionStart?.flatMap((group) => group.hooks || []).find((hook) => hook.command?.includes(integration.ownershipId))?.command;
  assert.ok(command, "Owned SessionStart hook is absent from the disposable profile");
  const expectedHookResponses = settings.hooks.SessionStart.flatMap((group) => group.hooks || []).length;
  const witness = boundedReadJson(plan.witness.output);
  const relativeEnvFile = validateSessionWitness(witness, plan.sessionId, item.root);
  const files = [];
  let visitedFiles = 0, visitedBytes = 0;
  const walk = (directory, depth = 0) => {
    assert.ok(depth <= 16, "Evidence tree exceeded its depth bound");
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      assert.ok(visitedFiles < 10_000 && visitedBytes < 256 * 1024 * 1024, "Evidence tree exceeded its scan bound");
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(file, depth + 1);
      else if (entry.isFile() && fs.statSync(file).size <= 64 * 1024 * 1024) {
        visitedFiles += 1; visitedBytes += fs.statSync(file).size;
        const content = fs.readFileSync(file, "utf8");
        if (content.includes(`# clean-development begin (claude-session) owner=${integration.ownershipId}`)) {
          files.push({ path: path.relative(item.root, file), sha256: sha256(content) });
        }
      }
    }
  };
  walk(item.root);
  const hookEvents = validateSessionStartResponses(result.hooks, plan.sessionId, expectedHookResponses);
  assert.equal(result.sessionId, plan.sessionId, "Stream session ID did not match the prepared session");
  assert.equal(files.length, 1, "Expected exactly one session environment file with the owned routing block");
  assert.equal(files[0].path, relativeEnvFile, "Owned routing block was not in the host-witnessed session env file");
  const matchedTools = result.tools.filter((tool) => tool.commandMatched);
  assert.equal(result.tools.length, 1, "Smoke must use exactly one tool call");
  assert.equal(matchedTools.length, 1, "Tool call did not match the fixed observer command");
  assert.equal(matchedTools[0].sessionId, plan.sessionId, "Bash tool event was not joined to the prepared session");
  const toolResults = result.completions.filter((entry) => entry.id === matchedTools[0].id);
  assert.equal(toolResults.length, 1, "Expected one completion for the observer Bash call");
  assert.ok(toolResults[0].sessionId === plan.sessionId && !toolResults[0].isError, "Observer Bash tool did not complete successfully in the prepared session");
  const checks = {
    realCargo: value.cargo.backend === "live" && value.cargo.exitCode === 0,
    sessionOnlyRouting: evaluate(item, SMOKE_CASE, { routed: true }).status === "passed",
    nonce: value.shell.nonce === value.cargo.nonce,
    managedArtifact: value.cargo.artifact.startsWith(`${item.managed}${path.sep}`) && fs.statSync(value.cargo.artifact).size > 0,
    isolatedHome: value.shell.env.HOME === item.env.HOME && value.cargo.env.HOME === item.env.HOME,
    cargoCredentialAbsent: value.cargo.authPresent === false,
    observerCredentialAbsent: value.shell.authPresent === false,
    unrelatedHook: value.shell.env.ACCEPTANCE_KEEP === "unrelated-hook"
  };
  assert.ok(Object.values(checks).every(Boolean), "Observer evidence failed one or more routing or credential assertions");
  intact(item);
  return { checks, nonce: value.shell.nonce, child: { artifact: value.cargo.artifact, sha256: sha256(fs.readFileSync(value.cargo.artifact)), target: value.cargo.target }, hookEnvironmentFiles: files,
    sessionWitness: { sessionId: witness.sessionId, event: witness.event, source: witness.source, envFile: relativeEnvFile }, hookEvent: hookEvents[0] };
}

export function validateSessionWitness(witness, sessionId, root) {
  assert.equal(witness.sessionId, sessionId, "Session witness ID did not match the prepared session");
  assert.equal(witness.event, "SessionStart", "Session witness did not observe SessionStart");
  assert.equal(typeof witness.envFile, "string");
  assert.ok(path.isAbsolute(witness.envFile), "Session env file path must be absolute");
  const envFile = path.resolve(witness.envFile);
  const relative = path.relative(root, envFile);
  assert.ok(relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative), "Session env file escaped the disposable lab");
  assert.equal(fs.realpathSync(envFile), envFile, "Session env file path contains a symlink");
  const stat = fs.lstatSync(envFile);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), "Session env file is not a regular file");
  return relative;
}

export function validateSessionStartResponses(hooks, sessionId, expectedCount) {
  const responses = hooks.filter((hook) => hook.subtype === "hook_response" && hook.sessionId === sessionId
    && (hook.event === "SessionStart" || String(hook.name).startsWith("SessionStart")));
  assert.equal(responses.length, expectedCount, "SessionStart hook responses did not match the disposable settings");
  assert.ok(responses.length > 0 && responses.every((hook) => hook.success), "A relevant SessionStart hook response failed");
  return responses;
}

export async function executeSmoke(root, { confirmed = false, env = process.env } = {}) {
  assert.equal(confirmed, true, "Live smoke requires the explicit --confirm-live-smoke opt-in");
  assert.notEqual(process.platform, "win32", "The live smoke protocol currently requires POSIX process groups");
  const item = loadFixture(root);
  const plan = boundedReadJson(path.join(item.root, PLAN_NAME));
  const { command } = validatePreparedSmoke(item, plan);
  assert.ok(sameJson(sourceIdentity(), plan.source), "Source identity changed since preparation");
  const cliHelp = readCliHelp(item.claude, item.env, item.projects.normal);
  assert.equal(sha256(cliHelp), plan.cliHelpSha256, "Claude CLI help changed since preparation");
  assert.equal(runVersion(item.claude, item.env), plan.hostVersion, "Claude executable version changed since preparation");
  const key = env.ANTHROPIC_API_KEY;
  assert.ok(typeof key === "string" && key.length >= 20 && !key.startsWith("op://"), "Inject ANTHROPIC_API_KEY through the approved secret runner");
  assert.ok(!Object.hasOwn(item.env, "ANTHROPIC_API_KEY") && !Object.hasOwn(item.env, "ANTHROPIC_AUTH_TOKEN") && !Object.hasOwn(item.env, "CLAUDE_CODE_OAUTH_TOKEN"), "Prepared environment contains ambient credentials");
  claimSmokeExecution(item.root, plan);
  const startedAt = new Date().toISOString();
  const childEnv = { ...item.env, ANTHROPIC_API_KEY: key };
  const argv = [cli, "run", "--session", "session-only", "--", item.claude, ...plan.args];
  const result = await runBounded(process.execPath, argv, { cwd: item.projects.normal, env: childEnv, expectedCommand: command, timeoutMs: plan.timeoutMs, shutdownGraceMs: plan.shutdownGraceMs });
  let verified = { checks: {}, nonce: null, child: null, hookEnvironmentFiles: [], hookEvent: null }, verificationError = null;
  try { verified = checkLiveEvidence(item, plan, result); }
  catch { verificationError = "EVIDENCE_VALIDATION_FAILED"; }
  const secretScan = scanLabForCredential(item.root, key);
  const finalSource = sourceIdentity();
  const sourceUnchanged = sameJson(finalSource, plan.source);
  const ok = verificationError === null && sourceUnchanged && secretScan.complete && !secretScan.found && result.status === 0 && result.errorCode === null && result.lifetime === "quiescent"
    && result.resultCount === 1 && result.invalidLines === 0 && result.resultSubtype === "success" && result.totalCostUsd !== null && result.totalCostUsd <= plan.budgetUsd
    && result.sessionId === plan.sessionId && !result.mixedSessions && result.sessionIds.length === 1 && result.sessionIds[0] === plan.sessionId
    && result.hooks.some((hook) => hook.subtype === "hook_response" && hook.sessionId === plan.sessionId && hook.event === "SessionStart" && hook.success === true)
    && result.tools.length === 1 && result.tools[0].sessionId === plan.sessionId && result.tools[0].commandMatched
    && result.completions.length === 1 && result.completions[0].sessionId === plan.sessionId && result.completions[0].id === result.tools[0].id && !result.completions[0].isError
    && result.stdoutBytes + result.stderrBytes <= SMOKE_MAX_OUTPUT_BYTES;
  const report = {
    schemaVersion: 1, backend: "live-candidate", hostVersion: plan.hostVersion, model: result.model || plan.model,
    source: finalSource, sourceUnchanged, root: item.root, sessionId: plan.sessionId, startedAt, endedAt: new Date().toISOString(),
    budgetUsd: plan.budgetUsd, totalCostUsd: result.totalCostUsd, timeoutMs: plan.timeoutMs, shutdownGraceMs: plan.shutdownGraceMs,
    exitStatus: result.status, signal: result.signal, errorCode: result.errorCode, lifetime: result.lifetime,
    resultSubtype: result.resultSubtype, eventCount: result.eventCount, invalidLines: result.invalidLines,
    events: result.events, hooks: result.hooks, tools: result.tools, completions: result.completions, usage: result.usage,
    stdoutBytes: result.stdoutBytes, stderrBytes: result.stderrBytes, stdoutSha256: result.stdoutSha256, stderrSha256: result.stderrSha256,
    ...verified, secretScan, verificationError, ok,
    boundary: "One API-authenticated print-mode session, one fixed Bash observer call, session-only routing, and one offline real-Cargo build. This does not establish resume/fork/subagent behavior or billed-token neutrality."
  };
  const reportFile = path.join(item.root, "evidence", "claude-smoke-result.json");
  writeExclusiveEvidence(item.root, "claude-smoke-result.json", redactCredential(report, key));
  return { reportFile, report: redactCredential(report, key) };
}

export function redactCredential(value, secret) {
  if (typeof value === "string") return value.replaceAll(secret, "<redacted>");
  if (Array.isArray(value)) return value.map((item) => redactCredential(item, secret));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactCredential(item, secret)]));
  return value;
}

export function scanLabForCredential(root, secret, { maxFiles = 10_000, maxBytes = 256 * 1024 * 1024, maxFileBytes = 64 * 1024 * 1024 } = {}) {
  let found = false, complete = true, files = 0, bytes = 0;
  const visit = (directory, depth) => {
    if (depth > 16) { complete = false; return; }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (files >= maxFiles || bytes >= maxBytes) { complete = false; return; }
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) { complete = false; continue; }
      if (entry.isDirectory()) visit(file, depth + 1);
      else if (entry.isFile()) {
        const size = fs.statSync(file).size;
        if (size > maxFileBytes || bytes + size > maxBytes) { complete = false; continue; }
        const content = fs.readFileSync(file);
        files += 1; bytes += content.length;
        if (content.includes(Buffer.from(secret))) found = true;
      }
    }
  };
  visit(root, 0);
  return { complete, found, files, bytes };
}

function parseOptions(args) {
  const parsed = {};
  while (args.length) {
    const option = args.shift();
    if (!["--claude", "--cargo", "--rustc", "--model"].includes(option)) throw new Error(`Unsupported smoke option: ${option}`);
    const value = args.shift();
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${option}`);
    const key = option.slice(2);
    if (Object.hasOwn(parsed, key)) throw new Error(`Duplicate option: ${option}`);
    parsed[key] = value;
  }
  for (const key of ["claude", "cargo", "rustc", "model"]) if (!parsed[key]) throw new Error(`Required option missing: --${key}`);
  return parsed;
}

export async function main(args = process.argv.slice(2)) {
  const action = args.shift();
  if (!action) return 0;
  if (action === "prepare") {
    const prepared = prepareSmoke(parseOptions(args));
    console.log(JSON.stringify({ prepared: true, ...prepared }, null, 2));
    return 0;
  }
  if (action === "execute") {
    const root = args.shift();
    assert.ok(root && path.isAbsolute(root), "Supply the absolute LAB path returned by prepare");
    assert.deepEqual(args, ["--confirm-live-smoke"], "Execution requires exactly --confirm-live-smoke");
    const result = await executeSmoke(root, { confirmed: true });
    console.log(JSON.stringify(result.report, null, 2));
    return result.report.ok ? 0 : 1;
  }
  throw new Error("Usage: smoke.mjs prepare --claude ABS --cargo ABS --rustc ABS --model MODEL_ID | execute ABS_LAB --confirm-live-smoke");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
