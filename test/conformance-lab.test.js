import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TOOLS, vectors, minimise, commandResultEqual, environment, capture, runToolLab } from '../scripts/conformance-lab.mjs';

const temporary = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cd-conformance-test-')));

test('conformance corpus is reproducible and preserves non-shell Unicode/whitespace tokens', () => {
  assert.deepEqual(vectors(91, 12), vectors(91, 12));
  assert.notDeepEqual(vectors(91, 12), vectors(92, 12));
  assert.ok(vectors(91).flat().includes(''));
  assert.ok(vectors(91).flat().includes('\t\n'));
  assert.ok(vectors(91).flat().includes('東京'));
  assert.ok(vectors(91).flat().includes('$();&|'));
});

test('bounded reducer retains only failure-triggering argv/codepoints', async () => {
  const result = await minimise(['irrelevant', 'prefix🧪suffix', 'tail'], args => args.some(s => s.includes('🧪')), 80);
  assert.deepEqual(result.argv, ['🧪']); assert.ok(result.calls <= 80);
  const empty = await minimise(['a'], () => true); assert.deepEqual(empty.argv, []);
});

test('byte oracle rejects equal-length corruption, stderr changes, status changes and infrastructure failures', () => {
  const result = { code: 0, signal: null, stdout: Buffer.from([0, 255, 10]).toString('base64'), stderr: '', error: null };
  assert.deepEqual(commandResultEqual(result, result).differences, []);
  for (const field of ['stdout', 'stderr', 'code', 'signal', 'error']) {
    const changed = { ...result, [field]: field === 'code' ? 7 : field === 'signal' ? 'SIGTERM' : 'changed' };
    assert.ok(commandResultEqual(result, changed).differences.length, field);
  }
  const signalled = { ...result, code: null, signal: 'SIGTERM' };
  const mapped = { ...result, code: 128 + os.constants.signals.SIGTERM };
  assert.deepEqual(commandResultEqual(signalled, mapped).differences, []);
  assert.equal(commandResultEqual(signalled, mapped).accounting.length, 1);
  assert.ok(commandResultEqual(signalled, { ...mapped, code: 130 }).differences.length);
});

test('allowlisted environment never copies ambient credentials, tool overrides or Node hooks', t => {
  const root = temporary(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = environment(root, { node: process.execPath });
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'GITHUB_TOKEN', 'OPENAI_API_KEY', 'CARGO_TARGET_DIR', 'GOCACHE', 'UV_CACHE_DIR', 'npm_config_cache']) assert.equal(Object.hasOwn(env, key), false, key);
  assert.equal(env.HOME, path.join(root, 'home')); assert.equal(env.GOPROXY, 'off'); assert.equal(env.UV_PYTHON_DOWNLOADS, 'never');
});

test('capture handles ENOENT and deadlines as infrastructure errors, never conformance passes', { skip: process.platform === 'win32' }, async t => {
  const root = temporary(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const missing = await capture(path.join(root, 'missing'), [], { cwd: root, env: {}, timeout: 2000 });
  assert.equal(missing.error, 'ENOENT');
  const stalled = await capture(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: root, env: {}, timeout: 200 });
  assert.match(stalled.error, /deadline/);
});

for (const tool of TOOLS) test(`differential REAL ${tool}: commands, bytes, signals, nested cache and artifacts`, { timeout: 240000 }, async t => {
  const result = await runToolLab(tool, { count: 3, minimiseFailures: false });
  if (result.status === 'blocked') { t.skip(result.reason); return; }
  t.diagnostic(JSON.stringify({ tool, version: result.version, rustc: result.rustc, python: result.python,
    platform: result.platform, node: result.node, cases: result.cases.map(c => ({ id: c.id, status: c.status, differences: c.differences })),
    artifacts: result.artifacts, root: result.root }));
  // Keep failed fixture evidence. Passing test fixtures are generated exclusively by this call.
  if (result.status === 'passed') t.after(() => fs.rmSync(result.root, { recursive: true, force: true }));
  assert.equal(result.status, 'passed', result.error || JSON.stringify(result.failures));
  assert.ok(result.cases.length >= 10); assert.equal(result.artifacts.length, 2);
});
