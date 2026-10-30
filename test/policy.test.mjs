import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sim, plugin } from "./helpers.mjs";
import { loadConf } from "../runtime/lib/conf.mjs";

function shellMode(s, shell, inspect = true) {
  const r = spawnSync(shell, ["-c", '. "$1"; printf "%s|%s" "$CLEAN_DEV_MODE" "$DEVCACHE"', "fixture", path.join(plugin, "machine", "env.zsh")], {
    cwd: s.root, env: { ...s.env, HOMEBREW_PREFIX: "/opt/homebrew", DEV_ENV_INSPECT_ONLY: inspect ? "1" : "0" }, encoding: "utf8", timeout: 5000 });
  assert.equal(r.status, 0, r.stderr); return r.stdout;
}

for (const shell of ["/bin/zsh", "/bin/bash"]) {
  test(`${shell}: storage policy is data even in ordinary and inspection shells`, () => {
    for (const inspect of [true, false]) {
      const s = sim();
      const sentinel = path.join(s.root, "must-not-execute");
      fs.appendFileSync(s.config, `INTERNAL_ROOT=$(touch ${sentinel})\n`);
      assert.equal(shellMode(s, shell, inspect), `internal|${s.int}`);
      assert.equal(fs.existsSync(sentinel), false);
    }
    const s = sim();
    const literal = path.join(s.root, "literal");
    fs.appendFileSync(s.config, `HOME_DOT_ALLOW="safe; touch ${literal}"\n`);
    assert.equal(shellMode(s, shell), `external|${s.ext}`);
    assert.equal(fs.existsSync(literal), false, "metacharacters remain literal values, never shell commands");
  });
  test(`${shell}: machine root validation agrees with runtime on unsafe/empty/overlapping policy`, () => {
    for (const line of ["INTERNAL_ROOT=/", "INTERNAL_ROOT=//", "INTERNAL_ROOT=relative/path", "INTERNAL_ROOT=", "EXTERNAL_CACHE=${EXTERNAL_ROOT}/../../escape",
      "DEPS_CAP_GB=not-a-number", "DEPS_CAP_GB=1.2.3", "DEPS_CAP_GB=1e3", "UNKNOWN_POLICY_KEY=present", "INTERNAL_ROOT=$HOME/dev/machine/state/cache"]) {
      const s = sim(); fs.appendFileSync(s.config, `${line}\n`);
      assert.equal(loadConf(s.env).valid, false, line);
      assert.equal(shellMode(s, shell), `internal|${s.int}`, line);
    }
  });
  test(`${shell}: quoting, dependent defaults and explicit travel overrides remain valid`, () => {
    const s = sim();
    const travel = path.join(s.home, "dev", "travel lab");
    fs.appendFileSync(s.config, `LAB_ROOT="${travel}"\nINTERNAL_ROOT="${s.int}/"\n`);
    assert.equal(loadConf(s.env).valid, true);
    assert.equal(shellMode(s, shell), `external|${s.ext}`);
    fs.writeFileSync(s.config, `EXTERNAL_VOLUME=4TB\nEXTERNAL_ROOT=${s.vol}/machine\nINTERNAL_ROOT=$HOME/dev/machine/cache\n`);
    assert.equal(loadConf(s.env).valid, true);
    assert.equal(shellMode(s, shell), `external|${s.ext}`, "omitted dependent keys use the same defaults");
    assert.equal(fs.existsSync(travel), false);
  });
}

test("invalid project paths cannot name Git metadata through dot or nested components", async () => {
  const { validateV2 } = await import("../runtime/lib/project.mjs");
  const schema = JSON.parse(fs.readFileSync(path.join(plugin, "schemas", "project-config.schema.json")));
  const pattern = new RegExp(schema.oneOf[0].properties.buildDirs.items.pattern);
  for (const rel of [".", "./.git", "a/../outside", "a/.git", "a/./b", "a//b", "a/", "a/line\nbreak"]) {
    assert.ok(validateV2({ schemaVersion: 2, buildDirs: [rel] }).length, rel);
    assert.equal(pattern.test(rel), false, `schema ${JSON.stringify(rel)}`);
  }
  assert.equal(validateV2({ schemaVersion: 2, buildDirs: [".github-output", ".build", "a/b"] }).length, 0);
  for (const rel of [".github-output", ".build", "a/b"]) assert.equal(pattern.test(rel), true, rel);
});
