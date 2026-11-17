import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cli, mk, sim, snapshot } from "./helpers.mjs";
import { VERSION } from "../runtime/lib/conf.mjs";
import { loadProjectConfig } from "../runtime/lib/project.mjs";

const retired = ["run", "env", "doctor", "status", "reap", "locks", "leases", "reconcile", "publish", "vm", "codex-trust", "sizes", "migrate", "prune", "housekeeping"];

test("every retired command refuses with exit 2 and leaves all fixture bytes and metadata alone", () => {
  const s = sim();
  const marker = path.join(s.root, "must-not-execute");
  const before = snapshot(s.root);
  for (const command of retired) {
    const r = cli(s, [command, "--apply", "--write", "--", process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "bad")`]);
    assert.equal(r.status, 2, `${command}: ${r.stderr}`);
    assert.equal(r.stderr.trim(), `unknown command ${command}; use --help`);
    assert.equal(r.stdout, "");
    assert.deepEqual(snapshot(s.root), before, command);
  }
});

test("help wins before every command, unknown options and write flags, even with invalid HOME", () => {
  const s = sim({ mounted: false });
  const before = snapshot(s.root);
  const commands = [...retired, "report", "cleanup", "init", "hook", "version", "unknown"];
  for (const command of commands) for (const help of ["--help", "-h", "help"]) {
    const r = cli({ ...s, env: { ...s.env, HOME: "/" } }, [command, "--write", "--apply", "--unknown", help]);
    assert.equal(r.status, 0, `${command} ${help}: ${r.stderr}`);
    assert.match(r.stdout, /^Usage:/); assert.equal(r.stderr, "");
  }
  for (const args of [[], ["help"], ["--help"], ["-h"]]) assert.equal(cli(s, args).status, 0);
  assert.deepEqual(snapshot(s.root), before);
});

test("version reports the current release without reading policy or changing the fixture", () => {
  const s = sim(); mk(s.config, "not valid policy");
  const before = snapshot(s.root);
  const r = cli({ ...s, env: { ...s.env, HOME: "/" } }, ["version"]);
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, VERSION + "\n"); assert.equal(r.stderr, "");
  assert.deepEqual(snapshot(s.root), before);
});

test("invalid kept-command arguments and unknown commands fail without acting", () => {
  const s = sim(); const before = snapshot(s.root);
  for (const args of [["unknown"], ["version", "extra"], ["report", "--write"], ["cleanup", "--project"], ["cleanup", "--project", "--json"], ["init", "--unknown"], ["init", "one", "two"]]) {
    const r = cli(s, args); assert.equal(r.status, 2, `${args}: ${r.stderr}`); assert.notEqual(r.stderr, "");
  }
  assert.deepEqual(snapshot(s.root), before);
});

test("init previews detected directories, writes only explicitly, and refuses existing settings on retry", () => {
  const s = sim({ mounted: false }); mk(path.join(s.root, "Package.swift"), "// package");
  const before = snapshot(s.root);
  let r = cli(s, ["init"]); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).buildDirs, [".build"]);
  assert.deepEqual(snapshot(s.root), before);
  r = cli(s, ["init", "--write", s.root]); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(loadProjectConfig(s.root).config.buildDirs, [".build"]);
  const written = snapshot(s.root);
  r = cli(s, ["init", "--write", s.root]); assert.equal(r.status, 1); assert.match(r.stderr, /exists; retaining/);
  assert.deepEqual(snapshot(s.root), written);
  mk(path.join(s.root, ".clean-development.json"), JSON.stringify({ schemaVersion: 1, enabled: false, tools: { swift: true } }));
  assert.equal(loadProjectConfig(s.root).version, 1);
  assert.equal(loadProjectConfig(s.root).config.enabled, false);
  assert.deepEqual(loadProjectConfig(s.root).config.buildDirs, [".build"]);
  const v1 = snapshot(s.root);
  assert.equal(cli(s, ["init", "--write"]).status, 1); assert.deepEqual(snapshot(s.root), v1);
});
