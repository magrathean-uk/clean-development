import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { hook, cli, mk, plugin, runtime, sim, snapshot } from "./helpers.mjs";

function context(result) {
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, "");
  assert.equal(result.stdout.trim().split("\n").length, 1);
  const doc = JSON.parse(result.stdout);
  assert.equal(doc.hookSpecificOutput.hookEventName, "SessionStart");
  return doc.hookSpecificOutput.additionalContext;
}

test("SessionStart supplies one context line for each harness and routing mode without writing", () => {
  for (const mounted of [true, false]) for (const harness of ["claude", "codex"]) {
    const s = sim({ mounted });
    mk(path.join(s.home, "dev/machine/state/clean-development/lifecycle.lock"), "old state stays");
    const before = snapshot(s.root), began = Date.now();
    const text = context(hook(s, "session-start", harness));
    assert.ok(Date.now() - began < 1000, "context exits within 1 s");
    assert.match(text, new RegExp(`mode=${mounted ? "external" : "internal"}`));
    assert.ok(text.includes(`root=${mounted ? s.ext : s.int}`)); assert.match(text, /free=/);
    assert.equal(text.includes("\n"), false);
    assert.deepEqual(snapshot(s.root), before);
    context(cli(s, ["hook", "session-start", harness]));
    assert.deepEqual(snapshot(s.root), before);
  }
});

test("Stop, SessionEnd and invalid invocations exit 0 silently and preserve the fixture", () => {
  const s = sim(); const before = snapshot(s.root);
  for (const event of ["stop", "session-end", "bogus"]) for (const harness of ["claude", "codex", "bogus"]) {
    const r = hook(s, event, harness, "not JSON");
    assert.equal(r.status, 0); assert.equal(r.stdout, ""); assert.equal(r.stderr, "");
  }
  assert.deepEqual(snapshot(s.root), before);
});

test("context handles invalid policy and HOME, and offers cleanup when free space is low", () => {
  const s = sim(); fs.appendFileSync(s.config, "INTERNAL_MIN_FREE_GB=1000000000\n");
  let before = snapshot(s.root);
  assert.match(context(hook(s, "session-start", "codex")), /cleanup available/);
  assert.deepEqual(snapshot(s.root), before);
  fs.appendFileSync(s.config, "INTERNAL_ROOT=relative\n"); before = snapshot(s.root);
  assert.match(context(hook(s, "session-start", "claude")), /storage.conf problems/);
  assert.deepEqual(snapshot(s.root), before);
  assert.match(context(hook({ ...s, env: { ...s.env, HOME: "/" } }, "session-start", "claude")), /unavailable/);
  assert.deepEqual(snapshot(s.root), before);
});

test("an open stdin pipe cannot delay SessionStart or either silent event", async () => {
  const s = sim(); const before = snapshot(s.root);
  for (const event of ["session-start", "stop", "session-end"]) {
    const began = Date.now();
    const c = spawn(process.execPath, [path.join(runtime, "bin/cd-hook.mjs"), event, "codex"], { env: s.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    c.stdout.on("data", (d) => { stdout += d; }); c.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => c.kill("SIGKILL"), 1500);
    const status = await new Promise((resolve, reject) => { c.on("error", reject); c.on("close", resolve); });
    clearTimeout(timer); c.stdin.destroy();
    assert.equal(status, 0, stderr); assert.ok(Date.now() - began < 1000);
    if (event === "session-start") context({ status, stdout, stderr });
    else { assert.equal(stdout, ""); assert.equal(stderr, ""); }
  }
  assert.deepEqual(snapshot(s.root), before);
});

test("both packaged fragments carry SessionStart only", () => {
  for (const harness of ["claude", "codex"]) {
    const fragment = JSON.parse(fs.readFileSync(path.join(plugin, "fragments", `${harness}-hooks.json`)));
    assert.deepEqual(Object.keys(fragment.hooks), ["SessionStart"]);
    assert.match(fragment.hooks.SessionStart[0].hooks[0].command, new RegExp(`session-start ${harness}$`));
  }
});

test("the shell launcher returns silently for Stop and SessionEnd without looking for Node", () => {
  const s = sim(); const before = snapshot(s.root);
  for (const event of ["stop", "session-end"]) {
    const r = spawnSync("/bin/sh", [path.join(runtime, "bin/cd-hook"), event, "claude"], {
      env: { HOME: "/", PATH: "/missing", CLEAN_DEV_NODE: "/missing/node" }, encoding: "utf8", timeout: 1000
    });
    assert.equal(r.status, 0); assert.equal(r.stdout, ""); assert.equal(r.stderr, "");
  }
  assert.deepEqual(snapshot(s.root), before);
});
