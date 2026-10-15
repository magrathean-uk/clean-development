import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  SMOKE_BUDGET_USD, SMOKE_CASE, claimSmokeExecution, createStreamCollector, executeSmoke, observerCommand, prepareSmoke, redactCredential,
  runBounded, smokeHostArgs, validateCliHelp, validateSessionStartResponses, validateSessionWitness, validateSmokeOptions
} from "./claude-acceptance/smoke.mjs";
import { destroyFixture, repository } from "./claude-acceptance/fixture.mjs";

test("smoke preparation requires concrete executable paths and an explicit model", () => {
  const result = validateSmokeOptions({ claude: process.execPath, cargo: process.execPath, rustc: process.execPath, model: "caller-selected-model" });
  assert.equal(result.model, "caller-selected-model");
  assert.equal(result.tools.claude.realpath, process.execPath);
  assert.throws(() => validateSmokeOptions({ claude: "claude", cargo: process.execPath, rustc: process.execPath, model: "x" }), /absolute path/);
  assert.throws(() => validateSmokeOptions({ claude: process.execPath, cargo: process.execPath, rustc: process.execPath, model: "" }), /explicit model/);
});

test("preflight requires every CLI control before any live execution", () => {
  const help = `--print\n--output-format <format> text, json, stream-json\n--include-hook-events\n--max-budget-usd <amount> only works with --print\n--no-session-persistence\n--tools <tools...> Bash\n--allowedTools\n--permission-mode <mode> dontAsk\n--setting-sources <sources>\n--strict-mcp-config\n--mcp-config <configs...>\n--session-id <uuid>`;
  assert.equal(validateCliHelp(help), true);
  assert.throws(() => validateCliHelp(help.replace("--no-session-persistence", "")), /no session persistence/);
});

test("prepared host argv has the fixed budget, one Bash permission, and no arbitrary shell", () => {
  const sessionId = "12345678-1234-4234-8234-123456789abc";
  const command = observerCommand(path.join(os.tmpdir(), "smoke observer.sh"));
  const args = smokeHostArgs({ command, model: "caller-selected-model", sessionId });
  assert.equal(args[args.indexOf("--max-budget-usd") + 1], SMOKE_BUDGET_USD.toFixed(2));
  assert.deepEqual(args.slice(args.indexOf("--tools"), args.indexOf("--permission-mode")), ["--tools", "Bash", "--allowedTools", `Bash(${command})`]);
  assert.ok(args.includes("--no-session-persistence"));
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(args.some((arg) => arg.includes("ANTHROPIC_API_KEY")), false);
  assert.equal(args.at(-1).includes("Do not retry"), true);
  assert.equal(SMOKE_CASE, "claude-api-session-only");
});

test("stream collector retains bounded event facts and exact observer linkage only", () => {
  const command = "/bin/sh '/tmp/fixed observer.sh'";
  const collector = createStreamCollector(command);
  const events = [
    { type: "system", subtype: "hook_response", hook_event: "SessionStart", hook_name: "SessionStart:owner-123", hook_id: "hook-id", session_id: "session-id", exit_code: 0 },
    { type: "assistant", session_id: "session-id", model: "chosen-model", message: { content: [{ type: "tool_use", id: "tool-id", name: "Bash", input: { command }, private: "do-not-retain" }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-id", is_error: false, content: "secret raw output" }] } },
    { type: "result", subtype: "success", total_cost_usd: 0.01, usage: { input_tokens: 5, output_tokens: 2 } }
  ];
  for (const event of events) collector.accept(JSON.stringify(event));
  const result = collector.result();
  assert.equal(result.sessionId, "session-id");
  assert.equal(result.tools.length, 1);
  assert.equal(result.tools[0].commandMatched, true);
  assert.equal(result.completions[0].id, "tool-id");
  assert.equal(result.totalCostUsd, 0.01);
  assert.equal(JSON.stringify(result).includes("secret raw output"), false);
  assert.equal(JSON.stringify(result).includes("do-not-retain"), false);
});

test("credential redaction is recursive and does not modify unrelated fields", () => {
  const result = redactCredential({ event: "token=abc123", rows: ["abc123", { safe: "safe" }] }, "abc123");
  assert.deepEqual(result, { event: "token=<redacted>", rows: ["<redacted>", { safe: "safe" }] });
});

test("execution claim is exclusive so a lab cannot replay the paid request", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-smoke-claim-test-"));
  fs.mkdirSync(path.join(root, "evidence"));
  try {
    const plan = { sessionId: "12345678-1234-4234-8234-123456789abc", model: "chosen" };
    const claim = claimSmokeExecution(root, plan);
    assert.equal(claim.sessionId, plan.sessionId);
    assert.throws(() => claimSmokeExecution(root, plan), { code: "EEXIST" });
    assert.equal(fs.readFileSync(path.join(root, "evidence", "claude-smoke-execution.json"), "utf8").includes("chosen"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("session witness binds the exact session and env file inside the lab", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-smoke-witness-test-"));
  const envFile = path.join(root, "session.env");
  fs.writeFileSync(envFile, "# owned fixture\n");
  try {
    const witness = { sessionId: "12345678-1234-4234-8234-123456789abc", event: "SessionStart", source: "startup", envFile };
    assert.equal(validateSessionWitness(witness, witness.sessionId, root), "session.env");
    assert.throws(() => validateSessionWitness({ ...witness, sessionId: "other" }, witness.sessionId, root), /witness ID/);
    assert.throws(() => validateSessionWitness({ ...witness, envFile: path.join(os.tmpdir(), "outside-session.env") }, witness.sessionId, root), /escaped/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("all two fixture hooks and the added witness hook must succeed for one session", () => {
  const hooks = ["user", "owned", "witness"].map((name) => ({ subtype: "hook_response", sessionId: "session-id", event: "SessionStart", name: `SessionStart:${name}`, success: true }));
  assert.equal(validateSessionStartResponses(hooks, "session-id", 3).length, 3);
  assert.throws(() => validateSessionStartResponses(hooks.map((hook, i) => i === 1 ? { ...hook, success: false } : hook), "session-id", 3), /response failed/);
  assert.throws(() => validateSessionStartResponses(hooks, "other-session", 3), /did not match/);
});

test("stream collector flags mixed sessions, duplicate results, and malformed content", () => {
  const collector = createStreamCollector("fixed command");
  collector.accept(JSON.stringify({ type: "assistant", session_id: "session-a", message: { content: "not-an-array" } }));
  collector.accept(JSON.stringify({ type: "assistant", session_id: "session-b", message: { content: [] } }));
  collector.accept(JSON.stringify({ type: "result", session_id: "session-b", subtype: "success", total_cost_usd: 0.01 }));
  collector.accept(JSON.stringify({ type: "result", session_id: "session-b", subtype: "success", total_cost_usd: 0.01 }));
  const result = collector.result();
  assert.equal(result.mixedSessions, true);
  assert.deepEqual(result.sessionIds, ["session-a", "session-b"]);
  assert.equal(result.invalidLines, 2);
  assert.equal(result.resultCount, 2);
});

test("stream collector treats malformed nested metadata as invalid without throwing", () => {
  const collector = createStreamCollector("fixed command");
  assert.doesNotThrow(() => {
    collector.accept(JSON.stringify({ type: "result", modelUsage: "not-an-object", usage: [1, 2] }));
    collector.accept(JSON.stringify({ type: "assistant", message: { content: "bad" } }));
    for (let i = 0; i < 10_005; i++) collector.accept(JSON.stringify({ type: "system", session_id: "s" }));
  });
  const result = collector.result();
  assert.equal(result.invalidLines, 8);
  assert.equal(result.eventCount, 10_007);
  assert.deepEqual(result.usage, []);
});

test("bounded runner terminates the owned process group at its deadline", { skip: process.platform === "win32" }, async () => {
  const result = await runBounded(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: process.cwd(), env: process.env, timeoutMs: 100, shutdownGraceMs: 500, maxOutputBytes: 4096
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.errorCode, "ETIMEDOUT");
  assert.ok(["quiescent", "uncertain"].includes(result.lifetime));
  assert.notEqual(result.status, 0);
});

test("bounded runner stops and hashes output after the configured byte limit", { skip: process.platform === "win32" }, async () => {
  const result = await runBounded(process.execPath, ["-e", "process.stdout.write('oversized'.repeat(10000)); setInterval(() => {}, 1000)"], {
    cwd: process.cwd(), env: process.env, timeoutMs: 5000, shutdownGraceMs: 500, maxOutputBytes: 4096
  });
  assert.equal(result.overflow, true);
  assert.equal(result.errorCode, "MAX_OUTPUT");
  assert.ok(result.stdoutBytes > 4096);
  assert.equal(result.stdoutSha256.length, 64);
  assert.ok(["quiescent", "uncertain"].includes(result.lifetime));
});

test("synthetic host, hooks, observer, and Cargo complete end to end without a model", { skip: process.platform === "win32" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-smoke-synthetic-tools-"));
  const fakeCargo = path.join(root, "cargo");
  const fakeRustc = path.join(root, "rustc");
  const fakeClaude = path.join(root, "claude");
  const node = process.execPath;
  const tools = `#!/bin/sh\nexec ${JSON.stringify(node)} "$0.cjs" "$@"\n`;
  fs.writeFileSync(fakeCargo, tools, { mode: 0o700 });
  fs.writeFileSync(fakeRustc, tools, { mode: 0o700 });
  fs.writeFileSync(`${fakeCargo}.cjs`, `const fs=require("node:fs"),path=require("node:path");
if(process.argv[2]==="--version"){console.log("cargo synthetic 1.0");process.exit(0)}
if(process.argv[2]!=="build"||process.argv[3]!=="--offline")process.exit(9);
const target=process.env.CARGO_TARGET_DIR;
if(!target)process.exit(8);
fs.mkdirSync(path.join(target,"debug"),{recursive:true});
fs.writeFileSync(path.join(target,"debug","claude_acceptance_fixture"),process.env.CLAUDE_ACCEPTANCE_NONCE||"synthetic");
`);
  fs.writeFileSync(`${fakeRustc}.cjs`, `if(process.argv[2]==="--version"){console.log("rustc synthetic 1.0");process.exit(0)}process.exit(9);\n`);
  fs.writeFileSync(fakeClaude, `#!${node}\nconst fs=require("node:fs"),path=require("node:path"),cp=require("node:child_process");
if(process.argv.includes("--help")){process.stdout.write(${JSON.stringify("--print\n--output-format <format> text json stream-json\n--include-hook-events\n--max-budget-usd <amount> only works with --print\n--no-session-persistence\n--tools <tools...> Bash\n--allowedTools\n--permission-mode <mode> dontAsk\n--setting-sources <sources>\n--strict-mcp-config\n--mcp-config <configs...>\n--session-id <uuid>\n")});process.exit(0)}
if(process.argv.includes("--version")){console.log("claude synthetic 1.0");process.exit(0)}
const args=process.argv.slice(2),value=(flag)=>args[args.indexOf(flag)+1],sid=value("--session-id"),model=value("--model");
const settings=JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR,"settings.json"),"utf8"));
const envFile=path.join(process.env.CLAUDE_CONFIG_DIR,"session-"+sid+".env");fs.writeFileSync(envFile,"",{flag:"wx",mode:0o600});
const event=JSON.stringify({session_id:sid,hook_event_name:"SessionStart",source:"startup",cwd:process.cwd()});
let hookNo=0;
for(const group of settings.hooks.SessionStart)for(const hook of group.hooks||[]){
 const result=cp.spawnSync("/bin/sh",["-c",hook.command],{cwd:process.cwd(),input:event,encoding:"utf8",env:{...process.env,CLAUDE_ENV_FILE:envFile,CLAUDE_PLUGIN_ROOT:${JSON.stringify(repository)}}});
 const ok=!result.error&&result.status===0;
 console.log(JSON.stringify({type:"system",subtype:"hook_response",hook_event:"SessionStart",hook_name:"SessionStart:synthetic-"+(hookNo++),hook_id:"hook-"+hookNo,session_id:sid,exit_code:ok?0:(result.status||1)}));
 if(!ok)process.exit(7);
}
const lab=JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_ACCEPTANCE_ROOT,"lab.json"),"utf8"));
const plan=JSON.parse(fs.readFileSync(path.join(lab.root,"claude-smoke-plan.json"),"utf8"));
const observer=plan.command;
const toolId="tool-"+sid;
console.log(JSON.stringify({type:"assistant",session_id:sid,model,message:{content:[{type:"tool_use",id:toolId,name:"Bash",input:{command:observer}}]}}));
const run=cp.spawnSync("/bin/sh",["-c",". \\\"$CLAUDE_ENV_FILE\\\"; exec /bin/sh -c \\\"$1\\\"","smoke",observer],{cwd:lab.projects.normal,encoding:"utf8",env:{...process.env,CLAUDE_ENV_FILE:envFile,CLAUDE_ACCEPTANCE_CASE:${JSON.stringify("claude-api-session-only")}}});
console.log(JSON.stringify({type:"user",session_id:sid,message:{content:[{type:"tool_result",tool_use_id:toolId,is_error:run.status!==0,content:"discarded synthetic output"}]}}));
console.log(JSON.stringify({type:"result",subtype:run.status===0?"success":"error",session_id:sid,model,total_cost_usd:0.001,usage:{input_tokens:1,output_tokens:1}}));
process.exit(run.status||0);
`, { mode: 0o700 });
  let prepared;
  try {
    prepared = prepareSmoke({ claude: fakeClaude, cargo: fakeCargo, rustc: fakeRustc, model: "synthetic-cheap-model" });
    const secret = "synthetic-test-credential-1234567890";
    const execution = await executeSmoke(prepared.root, { confirmed: true, env: { ANTHROPIC_API_KEY: secret } });
    assert.equal(execution.report.ok, true, execution.report.verificationError || JSON.stringify(execution.report.checks));
    assert.equal(execution.report.checks.realCargo, true);
    assert.equal(execution.report.checks.cargoCredentialAbsent, true);
    assert.equal(execution.report.checks.observerCredentialAbsent, true);
    assert.equal(execution.report.secretScan.found, false);
    assert.equal(fs.readFileSync(execution.reportFile, "utf8").includes(secret), false);
    assert.equal(execution.report.totalCostUsd, 0.001);
    assert.throws(() => claimSmokeExecution(prepared.root, { sessionId: execution.report.sessionId }), { code: "EEXIST" });
  } finally {
    if (prepared?.root && fs.existsSync(prepared.root)) destroyFixture({ root: prepared.root });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("test discovery does not invoke the CLI smoke runner", () => {
  const result = spawnSync(process.execPath, ["test/claude-acceptance/smoke.mjs"], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});
