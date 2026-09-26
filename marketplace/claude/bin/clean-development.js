#!/usr/bin/env node
import { main } from "../src/cli.js";

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`clean-development: ${error.message}`);
  process.exitCode = 1;
}
