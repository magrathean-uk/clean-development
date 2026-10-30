import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { plugin, sim, mk } from "./helpers.mjs";

const wrapper = path.join(path.dirname(plugin), "bin", "opencode2");
test("OpenCode client launcher filters foreign session identity without calling the real service", { skip: !fs.existsSync(wrapper) }, () => {
  const s = sim({ mounted: false });
  mk(path.join(s.home, "dev", "machine", "env.zsh"), fs.readFileSync(path.join(plugin, "machine", "env.zsh")));
  const parentScratch = path.join(s.int, "scratch", "c-parent000000"); fs.mkdirSync(path.join(parentScratch, "tmp"), { recursive: true });
  const fake = mk(path.join(s.root, "fake-opencode"), `#!${process.execPath}\nconsole.log(JSON.stringify({args:process.argv.slice(2),session:process.env.CLEAN_DEV_SESSION,claude:process.env.CLAUDE_CODE_SESSION_ID,codex:process.env.CODEX_THREAD_ID,tmp:process.env.TMPDIR,npm:process.env.npm_config_cache,scratch:process.env.CLEAN_DEVELOPMENT_SCRATCH_ROOT}));\n`);
  fs.chmodSync(fake, 0o700);
  // Replace only the executable in a private fixture copy. No real client/server/model is invoked.
  const fixture = mk(path.join(s.root, "opencode2-fixture"), fs.readFileSync(wrapper, "utf8").replace('exec /opt/homebrew/bin/opencode "$@"', `exec '${fake}' "$@"`));
  const r = spawnSync("/bin/sh", [fixture, "argument with spaces"], { cwd: s.root,
    env: { ...s.env, HOMEBREW_PREFIX: "/opt/homebrew", CLEAN_DEV_SESSION: "c-parent000000", CLEAN_DEV_SCRATCH: parentScratch,
      CLEAN_DEV_STAMP: `internal|${s.int}|c-parent000000`, CLAUDE_CODE_SESSION_ID: "parent-claude", CODEX_THREAD_ID: "parent-codex",
      TMPDIR: path.join(parentScratch, "tmp"), npm_config_cache: "/foreign/cache" }, encoding: "utf8", timeout: 5000 });
  assert.equal(r.status, 0, r.stderr);
  const child = JSON.parse(r.stdout);
  assert.equal(child.session, undefined); assert.equal(child.claude, undefined); assert.equal(child.codex, undefined);
  assert.notEqual(child.tmp, path.join(parentScratch, "tmp"));
  assert.equal(child.npm, path.join(s.int, "deps", "npm"));
  assert.equal(child.scratch, path.join(s.int, "scratch", "shell"));
  assert.deepEqual(child.args, ["argument with spaces"]);
  assert.equal(fs.existsSync(parentScratch), true, "filtering ownership never deletes parent state");
});
