#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { generate, REGRESSIONS, SEEDS, BOUNDARIES } from './fuzz/corpus.mjs';
import { runCase, minimize, LIMITS, REPO } from './fuzz/runner.mjs';

export function campaign({ seed = SEEDS[0], count = 128, timeoutMs = LIMITS.timeoutMs, budgetMs = 180000, reductions = 24, cases = null } = {}) {
  integer(timeoutMs, 100, 10000, 'timeout');
  integer(budgetMs, 1000, 600000, 'budget');
  integer(reductions, 0, 64, 'reductions');
  if (cases && (!Array.isArray(cases) || cases.length > 2048)) throw new Error('Invalid replay cases');
  const start = performance.now(), inputs = cases || [...REGRESSIONS, ...generate(seed, count)];
  const results = [], minimized = [], seen = new Set();
  for (const input of inputs) {
    if (performance.now() - start > budgetMs - timeoutMs * 3) break;
    const result = runCase(input, { timeoutMs });
    results.push(result);
    const signature = result.violations.find(v => v !== 'harness-error');
    if (signature && !seen.has(signature) && reductions && performance.now() - start + timeoutMs * 3 < budgetMs) {
      seen.add(signature);
      minimized.push({ signature, original: input, ...minimize(input, signature, { timeoutMs, deadline: start + budgetMs }, reductions) });
    }
  }
  const failed = results.filter(r => r.violations.length), skipped = results.filter(r => r.skipped);
  return { schemaVersion: 1, seed, requested: inputs.length, completed: results.length, failed: failed.length,
    skipped: skipped.length, passed: results.length - failed.length - skipped.length,
    complete: results.length === inputs.length, elapsedMs: Math.round(performance.now() - start),
    platform: { node: process.version, platform: process.platform, arch: process.arch, kernel: os.release() },
    source: fingerprints(),
    limits: { ...LIMITS, timeoutMs, budgetMs, reductions },
    coverage: Object.fromEntries(BOUNDARIES.map(b => [b, results.filter(r => r.boundary === b).length])),
    inputs, minimized, results };
}
function fingerprints() {
  const files = ['package.json', 'scripts/fuzz-boundaries.mjs'];
  for (const directory of ['src', 'bin', 'scripts/fuzz']) {
    for (const name of fs.readdirSync(path.join(REPO, directory)).sort()) {
      const relative = `${directory}/${name}`;
      if (fs.lstatSync(path.join(REPO, relative)).isFile()) files.push(relative);
    }
  }
  return Object.fromEntries(files.sort().map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO, file))).digest('hex')]));
}
function integer(value, min, max, label) {
  const n = Number(value); if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid ${label}`); return n;
}
function main(args) {
  const options = {}; let report, replay;
  for (let i = 0; i < args.length; i++) {
    const key = args[i], value = args[++i];
    if (key === '--seed') options.seed = integer(value, 0, 0xffffffff, key);
    else if (key === '--cases') options.count = integer(value, 8, 2048, key);
    else if (key === '--timeout-ms') options.timeoutMs = integer(value, 100, 10000, key);
    else if (key === '--budget-ms') options.budgetMs = integer(value, 1000, 600000, key);
    else if (key === '--reduce') options.reductions = integer(value, 0, 64, key);
    else if (key === '--report') report = value;
    else if (key === '--replay') replay = value;
    else throw new Error('Use --seed UINT32 --cases 8..2048 --timeout-ms 100..10000 --budget-ms 1000..600000 --reduce 0..64 --report NEW_FILE [--replay CASE_JSON]');
  }
  if (!report || fs.existsSync(report) || !fs.statSync(path.dirname(path.resolve(report))).isDirectory()) throw new Error('--report must be a new file in an existing directory');
  if (replay) { if (!fs.lstatSync(replay).isFile() || fs.statSync(replay).size > 65536) throw new Error('Replay descriptor limit'); options.cases = [JSON.parse(fs.readFileSync(replay, 'utf8'))]; }
  const result = campaign(options);
  const bytes = JSON.stringify(result, null, 2) + '\n';
  if (Buffer.byteLength(bytes) > 16 * 1024 * 1024) throw new Error('Report limit exceeded');
  fs.writeFileSync(report, bytes, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ report: path.resolve(report), completed: result.completed, requested: result.requested, passed: result.passed, failed: result.failed, skipped: result.skipped, complete: result.complete }));
  return result.failed || !result.complete || result.skipped ? 1 : 0;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.error(`fuzz-boundaries: ${error.message}`); process.exitCode = 2; }
}
