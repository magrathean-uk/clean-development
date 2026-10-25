#!/usr/bin/env node
// clean-development 0.6.0 hook entry: cd-hook.mjs <session-start|stop|session-end> <claude|codex>
// Reads the hook JSON from stdin. Always exits 0; SessionStart prints hookSpecificOutput JSON (Claude and Codex accept the
// same shape); Stop and SessionEnd print nothing (Codex treats empty output with exit 0 as success).
import { contextText, sessionEnd, sessionStart, stop } from "../lib/hook.mjs";
import { appendJsonl, appendLog, flushDeletes } from "../lib/fsutil.mjs";
import { VERSION, eventsPath, logPath } from "../lib/conf.mjs";
import { readPin, sessionKey } from "../lib/sessions.mjs";

const [event, harness] = process.argv.slice(2);

function readStdin(timeoutMs = 200) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let buf = "";
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(t); try { process.stdin.destroy(); } catch { /* ignore */ } resolve(buf); };
    const t = setTimeout(finish, timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => {
      buf += c;
      if (buf.length > 1024 * 1024) { buf = ""; finish(); return; }
      try { const value = JSON.parse(buf); if (value && typeof value === "object" && !Array.isArray(value)) finish(); } catch { /* partial frame */ }
    });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}

let out = "";
const began = Date.now();
let sid = null;
let generation = null;
const receipt = (mode, status, result = {}) => {
  try { appendJsonl(eventsPath(), { ts: new Date().toISOString(), harness, event, session_id: sid,
    mode, version: VERSION, generation, status, durationMs: Date.now() - began, ...(result.skipped ? { reason: result.skipped } : {}), ...(result.deferred || result.timedOut ? { deferred: true } : {}),
    ...(result.repoBlocked?.length ? { repoBlockedCount: result.repoBlocked.length, repoBlocked: result.repoBlocked.slice(0, 8) } : {}) }); } catch { /* invalid HOME must not fail the host */ }
};
try {
  if (!["session-start", "stop", "session-end"].includes(event) || !["claude", "codex"].includes(harness)) {
    appendLog(logPath(), `bad arguments: ${process.argv.slice(2).join(" ")}`);
  } else {
    let input = {};
    try { input = JSON.parse((await readStdin()) || "{}"); } catch { input = {}; }
    // One JSON line per event in events.jsonl (ts, harness, event, session_id, mode): the observable trace that
    // dev-env-check and the Codex acceptance test read. The mode is the pinned one (session-start: the decided one).
    sid = typeof input?.session_id === "string" ? input.session_id : null;
    let pinned = null;
    if (event !== "session-start") { try { const k = sessionKey(harness, sid), pin = k ? readPin(process.env, k) : null; pinned = pin?.mode || null; generation = pin?.meta?.generation || null; } catch { pinned = null; } }
    if (event === "session-start") {
      const r = sessionStart(input, harness);
      generation = r.key ? readPin(process.env, r.key).meta?.generation || null : null;
      receipt(r.decision.mode, "completed");
      out = JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: contextText(r) } });
    } else if (event === "stop") {
      const r = stop(input, harness);
      receipt(pinned, r.locked || r.result?.skipped ? "blocked" : r.result?.timedOut || r.result?.deferred ? "deferred" : "completed", r.result);
    } else {
      const r = sessionEnd(input, harness);
      receipt(pinned, r.skipped ? "blocked" : r.deferred ? "deferred" : "completed", r);
    }
  }
} catch (e) {
  try { appendLog(logPath(), `${event} ${harness}: ${e.stack || e.message}`); } catch { /* invalid HOME */ }
  receipt(null, "failed", { skipped: e.message });
  if (event === "session-start") {
    out = JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart",
      additionalContext: `clean-development ${VERSION}: lifecycle registration/cleanup failed; routing from ~/dev/machine/env.zsh still applies. Do not assume project ownership is registered. Run \`clean-development doctor\` and tell G.` } });
  }
}
// Flush stdout (pipes are asynchronous on macOS), then exit 0 even if a handle is still open.
flushDeletes();
if (out) process.stdout.write(out, () => process.exit(0)); else process.exit(0);
