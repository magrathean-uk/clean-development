#!/usr/bin/env node
// Detached size refresher; no cleanup or lifecycle hooks.
import { loadConf } from "../lib/conf.mjs";
import { refreshSizes } from "../lib/sizes.mjs";

try { refreshSizes(loadConf(), process.env); }
catch (e) { console.error(`clean-development sizes: ${e.message}`); process.exitCode = 1; }
