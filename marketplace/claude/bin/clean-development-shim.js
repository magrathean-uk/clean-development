#!/usr/bin/env node
import { resolveConfig } from "../src/config.js";
import { runTool } from "../src/runtime.js";
import { environmentValue, platformPaths } from "../src/platform.js";
import { normalizeSessionMode, SESSION_MODE_ENV } from "../src/session.js";

const [tool, ...args] = process.argv.slice(2);
if (!tool) {
  console.error("clean-development shim: missing tool name");
  process.exitCode = 2;
} else {
  try {
    const skip = normalizeSessionMode(environmentValue(process.env, SESSION_MODE_ENV)) === "skip";
    const config = skip ? { locations: platformPaths(process.env) } : resolveConfig();
    process.exitCode = await runTool(tool, args, { config });
  } catch (error) {
    console.error(`clean-development: ${error.message}`);
    process.exitCode = 1;
  }
}
