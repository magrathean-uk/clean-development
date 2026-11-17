#!/usr/bin/env node
// Storage reports, cleanup previews and project initialisation.
import fs from "node:fs";
import path from "node:path";
import { VERSION } from "../lib/conf.mjs";

const usage = `Usage: clean-development <command>
  report [--json] [--check]
  cleanup [--json] [--project DIR]
  cleanup --apply <id> [--skip N,...] [--project DIR] [--json]
  init [--write] [DIR]
  hook <session-start|stop|session-end> <claude|codex>
  version
  help | --help | -h
`;

function options(args, booleans, values = [], allowDir = false) {
  const out = { positional: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (booleans.includes(arg)) out[arg] = true;
    else if (values.includes(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith("-")) throw new Error(`${arg} needs a value`);
      out[arg] = args[++i];
    } else if (arg === "--" && allowDir) { out.positional.push(...args.slice(i + 1)); break; }
    else if (allowDir && !arg.startsWith("-")) out.positional.push(arg);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (out.positional.length > 1) throw new Error("expected at most one directory");
  return out;
}

async function main(argv) {
  // Handle help before argument validation, configuration reads or command dispatch.
  if (!argv.length || argv.some((arg) => ["help", "--help", "-h"].includes(arg))) {
    process.stdout.write(usage); return 0;
  }
  const [command, ...args] = argv;
  if (command === "version") { options(args, []); console.log(VERSION); return 0; }
  if (command === "hook") {
    process.argv = [process.argv[0], process.argv[1], ...args];
    await import("./cd-hook.mjs"); return 0;
  }
  if (command === "report") {
    const opts = options(args, ["--json", "--check"]);
    const { report, reportText } = await import("../lib/report.mjs");
    const result = report();
    console.log(opts["--json"] ? JSON.stringify(result, null, 2) : reportText(result));
    return opts["--check"] && (result.routing.length || result.errors.length) ? 1 : 0;
  }
  if (command === "cleanup") {
    const applyIndex = args.indexOf("--apply");
    if (applyIndex !== -1 && (!args[applyIndex + 1] || args[applyIndex + 1].startsWith("-"))) {
      console.error("cleanup refused: --apply needs a list id"); return 3;
    }
    const opts = options(args, ["--json"], ["--project", "--apply", "--skip"]);
    if (opts["--skip"] !== undefined && opts["--apply"] === undefined) throw new Error("--skip requires --apply");
    const { cleanup, cleanupText, applyCleanup, applyText } = await import("../lib/cleanup.mjs");
    if (opts["--apply"] !== undefined) {
      const result = applyCleanup(process.env, { id: opts["--apply"], skip: opts["--skip"], project: opts["--project"] });
      const text = opts["--json"] ? JSON.stringify(result, null, 2) : applyText(result);
      if (result.status === 3) console.error(text); else console.log(text);
      return result.status;
    }
    const result = cleanup(process.env, { project: opts["--project"] });
    console.log(opts["--json"] ? JSON.stringify(result, null, 2) : cleanupText(result)); return 0;
  }
  if (command === "init") {
    const opts = options(args, ["--write"], [], true);
    const { CONFIG, SCHEMA_URL, detectDirs, loadProjectConfig } = await import("../lib/project.mjs");
    const dir = path.resolve(opts.positional[0] || process.cwd());
    const existing = loadProjectConfig(dir);
    if (existing && opts["--write"]) { console.error(`${existing.file} exists; retaining existing settings`); return 1; }
    const config = { $schema: SCHEMA_URL, schemaVersion: 2, enabled: true, heavy: false, ...detectDirs(dir) };
    const text = JSON.stringify(config, null, 2) + "\n";
    if (opts["--write"]) {
      const file = path.join(dir, CONFIG);
      fs.writeFileSync(file, text, { flag: "wx" }); console.log(`wrote ${file}`);
    } else process.stdout.write(text);
    return 0;
  }
  console.error(`unknown command ${command}; use --help`); return 2;
}

try { process.exitCode = await main(process.argv.slice(2)); }
catch (error) { console.error(`clean-development: ${error.message}`); process.exitCode = 2; }
