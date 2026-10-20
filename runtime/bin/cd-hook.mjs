#!/usr/bin/env node
// clean-development 0.6.0 hook entry: cd-hook.mjs <session-start|stop|session-end> <claude|codex>
// Reads the hook JSON from stdin. Always exits 0; SessionStart prints hookSpecificOutput JSON (Claude and Codex accept the
// same shape); Stop and SessionEnd print nothing (Codex treats empty output with exit 0 as success).
import { contextText, sessionEnd, sessionStart, stop } from "../lib/hook.mjs";
import { appendJsonl, appendLog } from "../lib/fsutil.mjs";
import { eventsPath, logPath } from "../lib/conf.mjs";
import { readPin, sessionKey } from "../lib/sessions.mjs";

const [event, harness] = process.argv.slice(2);

function readStdin(timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let buf = "";
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(t); try { process.stdin.destroy(); } catch { /* ignore */ } resolve(buf); };
    const t = setTimeout(finish, timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { buf += c; if (buf.length > 1024 * 1024) finish(); });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}

let out = "";
try {
  if (!["session-start", "stop", "session-end"].includes(event) || !["claude", "codex"].includes(harness)) {
    appendLog(logPath(), `bad arguments: ${process.argv.slice(2).join(" ")}`);
  } else {
    let input = {};
    try { input = JSON.parse((await readStdin()) || "{}"); } catch { input = {}; }
    // One JSON line per event in events.jsonl (ts, harness, event, session_id, mode): the observable trace that
    // dev-env-check and the Codex acceptance test read. The mode is the pinned one (session-start: the decided one).
    const sid = typeof input?.session_id === "string" ? input.session_id : null;
    const logEvent = (mode) => appendJsonl(eventsPath(), { ts: new Date().toISOString(), harness, event, session_id: sid, mode });
    let pinned = null;
    if (event !== "session-start") { try { const k = sessionKey(harness, sid); pinned = k ? readPin(process.env, k).mode : null; } catch { pinned = null; } }
    if (event === "session-start") {
      const r = sessionStart(input, harness);
      logEvent(r.decision.mode);
      out = JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: contextText(r) } });
    } else if (event === "stop") {
      logEvent(pinned);
      stop(input, harness);
    } else {
      logEvent(pinned);
      sessionEnd(input, harness);
    }
  }
} catch (e) {
  appendLog(logPath(), `${event} ${harness}: ${e.stack || e.message}`);
  if (event === "session-start") {
    out = JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart",
      additionalContext: "clean-development 0.6.0: the session-start hook failed; storage routing from ~/dev/machine/env.zsh still applies. Run `clean-development doctor` and tell G." } });
  }
}
// Flush stdout (pipes are asynchronous on macOS), then exit 0 even if a handle is still open.
if (out) process.stdout.write(out, () => process.exit(0)); else process.exit(0);
