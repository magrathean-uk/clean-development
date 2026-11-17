#!/usr/bin/env node
// Never reads stdin or writes state. All host hook invocations exit successfully.
const [event, harness] = process.argv.slice(2);
if (event === "session-start" && ["claude", "codex"].includes(harness)) {
  let text;
  try { text = (await import("../lib/hook.mjs")).contextText(); }
  catch { text = "clean-development: storage context unavailable"; }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } }) + "\n");
}
