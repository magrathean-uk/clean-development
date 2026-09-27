// Explicit manual entry point. npm test must never start an agent or a paid model call.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeFixture, loadFixture, destroyFixture, setup, hook, routedParent, observe, evaluate,
  preflight, product, cli, repository, sourceIdentity, observer, quote } from "./fixture.mjs";

function resolveTool(name) {
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, name);
    try { fs.accessSync(candidate, fs.constants.X_OK); if (fs.statSync(candidate).isFile()) return candidate; }
    catch { /* Try the next PATH entry. Do not read credentials or settings. */ }
  }
  return null;
}
function save(item) { fs.writeFileSync(path.join(item.root, "lab.json"), `${JSON.stringify(item, null, 2)}\n`, { mode: 0o600 }); }
function print(value) { console.log(JSON.stringify(value, null, 2)); }
function createLive(args) {
  const tools = { claude: resolveTool("claude"), cargo: resolveTool("cargo"), rustc: resolveTool("rustc") };
  while (args.length) {
    const key = args.shift()?.replace(/^--/, ""), value = args.shift();
    assert.ok(Object.hasOwn(tools, key) && value && path.isAbsolute(value), "Use --claude/--cargo/--rustc ABSOLUTE_PATH");
    fs.accessSync(value, fs.constants.X_OK);
    assert.ok(fs.statSync(value).isFile()); tools[key] = value;
  }
  const item = makeFixture({ backend: "live", cargo: tools.cargo });
  item.claude = tools.claude; item.source = sourceIdentity();
  if (tools.rustc) item.env.RUSTC = tools.rustc;
  // Keep the executable's spelling (cargo may be a rustup proxy). Never import its home.
  if (tools.claude) item.env.PATH += `:${path.dirname(tools.claude)}`;
  save(item);
  return item;
}
export function launch(item, mode, project, options = []) {
  assert.equal(item.backend, "live", "Fixture tools cannot establish host acceptance");
  assert.ok(["native", "session-only", "skip"].includes(mode));
  assert.ok(Object.hasOwn(item.projects, project));
  const report = preflight(item);
  assert.ok(report.claude.available && report.cargo.available && report.rustc.available, "Live launch blocked: inspect preflight.json; no toolchain is installed automatically");
  assert.ok(item.claude && path.isAbsolute(item.claude), "A concrete Claude executable is required");
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === "--fork-session") continue;
    assert.ok(["--resume", "--session-id", "--model"].includes(option), `Unsupported live option: ${option}`);
    const value = options[++index];
    assert.match(value || "", option === "--model" ? /^[a-zA-Z0-9._:-]+$/ : /^[0-9a-f-]{36}$/i);
  }
  // Install the local marketplace inside the isolated host, never --plugin-dir at the root.
  // Real permissions remain enabled. No permission bypass, inherited MCP config, or real HOME.
  const hostArgs = ["--setting-sources", "user", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', ...options];
  const command = mode === "native" ? item.claude : process.execPath;
  const args = mode === "native" ? hostArgs : [cli, "run", "--session", mode, "--", item.claude, ...hostArgs];
  const receipt = { source: sourceIdentity(), claudeVersion: report.claude.version, mode, cwd: item.projects[project],
    command, args, startedAt: new Date().toISOString(), liveAcceptance: "unverified" };
  const file = path.join(item.root, "evidence", `launch-${Date.now()}.json`);
  fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  // Authentication is opt-in at launch only; never store the key in the lab or receipt.
  const env = { ...item.env };
  if (process.env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  const result = spawnSync(command, args, { cwd: item.projects[project], env, stdio: "inherit" });
  Object.assign(receipt, { endedAt: new Date().toISOString(), exitCode: result.status, signal: result.signal, error: result.error?.code || null });
  fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  print({ receipt: file, liveAcceptance: "unverified", next: "Inspect actual Claude session/tool evidence and run verify; launch success alone is not acceptance." });
  return result.status ?? 1;
}
export function main(args) {
  const action = args.shift();
  if (!action) return; // A support-file discovery pass is not live acceptance.
  assert.notEqual(process.platform, "win32", "This protocol requires a POSIX shell; native Windows remains untested");
  if (action === "prepare" || action === "preflight") {
    const item = createLive(args), report = preflight(item);
    print({ root: item.root, ...report, observerCommand: `${quote(process.execPath)} ${quote(observer)} observe CASE_NAME` });
    return report.claude.available && report.cargo.available && report.rustc.available ? 0 : 2;
  }
  if (action === "reproduce-cwd") {
    assert.equal(args.length, 0);
    const item = makeFixture(); setup(item);
    const env = routedParent(item), envFile = hook(item, { env });
    assert.ok(env.npm_config_cache, "Missing routed-parent precondition");
    hook(item, { env, generic: true, environmentFile: envFile, source: "cwd-change", cwd: item.projects.disabled });
    const children = observe(item, "cwd-change", { env, envFile, cwd: item.projects.disabled });
    const result = evaluate(item, "cwd-change", { routed: false, cwd: item.projects.disabled });
    const report = { source: sourceIdentity(), root: item.root, liveAcceptance: "not-run", result,
      shellCache: children.shell.env.npm_config_cache, cargoCache: children.cargo.env.npm_config_cache ?? null,
      artifact: children.cargo.artifact };
    fs.writeFileSync(path.join(item.root, "evidence", "result.json"), `${JSON.stringify(report, null, 2)}\n`);
    print(report);
    return result.status === "failed" ? 1 : 0;
  }
  const item = loadFixture(args.shift());
  if (action === "setup") { assert.equal(args.length, 0); setup(item); print({ root: item.root, setup: "completed", liveAcceptance: "unverified" }); return 0; }
  if (action === "uninstall") { assert.equal(args.length, 0); print(JSON.parse(product(item, ["uninstall", "--json"]).stdout)); return 0; }
  if (action === "cleanup") { assert.equal(args.length, 0); destroyFixture(item); print({ removed: item.root }); return 0; }
  if (action === "launch") { const mode = args.shift(), project = args.shift(); return launch(item, mode, project, args); }
  if (action === "verify") {
    const [name, disposition, project = "normal"] = args;
    assert.ok(["routed", "pass-through"].includes(disposition));
    assert.ok(Object.hasOwn(item.projects, project));
    assert.match(name || "", /^[a-z][a-z0-9-]*$/);
    const result = evaluate(item, name, { routed: disposition === "routed", cwd: item.projects[project] });
    print({ ...result, liveAcceptance: item.backend === "fixture" ? "not-run" : "unverified",
      boundary: "Child assertions only. A reviewer must correlate these nonce-bound captures with the real host session, lifecycle event and tool call; no fabricated or replayed host pass." });
    return result.status === "passed" ? 0 : 1;
  }
  throw new Error("Usage: run.mjs preflight|prepare [--claude PATH --cargo PATH --rustc PATH]; setup|uninstall|cleanup LAB; launch LAB native|session-only|skip normal|other|disabled [--resume UUID --fork-session]; verify LAB CASE routed|pass-through [PROJECT]; reproduce-cwd");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)) || 0; }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
