import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseConf, VERSION } from "../runtime/lib/conf.mjs";
import { plugin, runtime as rt } from "./helpers.mjs";

test("storage.conf parser: expansion, quoting, rejection", () => {
  const { values, errors } = parseConf("A=/x\nB=${A}/y\nC=\"$HOME/z\"\nD='$A'\nE=$(id)\n", { HOME: "/h" });
  assert.equal(values.B, "/x/y"); assert.equal(values.C, "/h/z"); assert.equal(values.D, "$A");
  assert.ok(errors.some((e) => e.includes("command substitution")));
});

test("plugin ships no hooks/ directory (both harnesses would auto-load hooks/hooks.json)", () => {
  assert.equal(fs.existsSync(path.join(plugin, "hooks")), false);
  const claude = JSON.parse(fs.readFileSync(path.join(plugin, ".claude-plugin", "plugin.json"), "utf8"));
  const portable = JSON.parse(fs.readFileSync(path.join(plugin, "plugin.json"), "utf8"));
  assert.equal(claude.hooks, undefined); assert.equal(portable.extensions["com.openai"].hooks, undefined);
  assert.equal(claude.version, VERSION); assert.equal(portable.version, VERSION);
  assert.equal(fs.readFileSync(path.join(rt, "VERSION"), "utf8").trim(), VERSION);
});
