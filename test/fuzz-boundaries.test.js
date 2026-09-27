import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { generate, SEEDS, BOUNDARIES, REGRESSIONS } from '../scripts/fuzz/corpus.mjs';
import { runCase, snapshot, changedPaths, isolatedEnvironment, containsOriginal, minimize } from '../scripts/fuzz/runner.mjs';
import { campaign } from '../scripts/fuzz-boundaries.mjs';

test('fuzz generation is reproducible, bounded and covers all input families', () => {
  for (const seed of SEEDS) {
    const cases = generate(seed, 128);
    assert.deepEqual(cases, generate(seed, 128));
    assert.equal(cases.length, 128);
    assert.equal(new Set(cases.map(c => c.id)).size, 128);
    for (const boundary of BOUNDARIES) {
      assert(cases.some(c => c.boundary === boundary && c.kind === 'near-miss'));
      assert(cases.some(c => c.boundary === boundary && c.kind === 'malformed'));
    }
    assert(cases.every(c => JSON.stringify(c).length < 65536));
    assert(cases.every(c => !c.name || !c.payload.includes('\0')), 'Environment values must be OS-representable');
  }
  assert.notDeepEqual(generate(SEEDS[0]), generate(SEEDS[1]));
  assert.throws(() => generate(1, 2049));
  assert.throws(() => generate(-1, 8));
});

test('fuzz environment excludes ambient credentials and routing', () => {
  const env = isolatedEnvironment('/fixture');
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.npm_config_cache, undefined);
  assert.equal(env.CLEAN_DEVELOPMENT_SESSION_MODE, undefined);
  assert.equal(env.PATH, path.join('/fixture', 'tools'));
});

test('fuzz snapshot detects changed bytes, removed files and empty directories', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fuzz-oracle-')));
  t.after(() => fs.rmSync(root, { recursive: true }));
  fs.writeFileSync(path.join(root, 'source'), 'before');
  fs.writeFileSync(path.join(root, 'remove'), 'keep');
  const before = snapshot(root);
  fs.writeFileSync(path.join(root, 'source'), 'after!');
  fs.unlinkSync(path.join(root, 'remove'));
  fs.mkdirSync(path.join(root, 'empty'));
  assert.deepEqual(changedPaths(before, snapshot(root)), ['empty', 'remove', 'source']);
});

test('fuzz observer rejects real CLI mutation and child-execution attempts', () => {
  const mutation = runCase({ id: 'oracle-write', boundary: 'argv', argv: ['init'] }, { keepFailure: false });
  assert(mutation.violations.includes('unexpected-write-attempt'), JSON.stringify(mutation));
  assert.equal(mutation.changed.length, 0);
  const child = runCase({ id: 'oracle-child', boundary: 'argv', argv: ['run', '--session', 'skip', '--', 'canary'] }, { keepFailure: false });
  assert(child.violations.includes('unexpected-child'), JSON.stringify(child));
  assert.equal(child.childAttempts, 1);
});

test('malformed package metadata does not break the observer preload', () => {
  const result = runCase({ id: 'invalid-package', boundary: 'manifest', slot: 'package', payload: 'null', argv: ['session', '--dry-run', '--json'] }, { keepFailure: false });
  assert.deepEqual(result.violations, [], JSON.stringify(result));
});

test('fuzz budget exhaustion is incomplete, never a clean complete pass', () => {
  const result = campaign({ count: 8, budgetMs: 1000, timeoutMs: 1000, reductions: 0 });
  assert.equal(result.complete, false);
  assert.equal(result.completed, 0);
});

for (const spec of REGRESSIONS) {
  test(`metadata boundary regression: ${spec.id}`, (t) => {
    const result = runCase(spec, { timeoutMs: 2000, keepFailure: false });
    if (result.skipped) return t.skip(result.skipped);
    assert.deepEqual(result.violations, [], JSON.stringify(result));
  });
}

test('metadata regressions also hold without observer instrumentation', async (t) => {
  for (const spec of REGRESSIONS) {
    await t.test(spec.id, (childTest) => {
      const result = runCase(spec, { timeoutMs: 2000, keepFailure: false, instrument: false });
      if (result.skipped) return childTest.skip(result.skipped);
      assert.deepEqual(result.violations, [], JSON.stringify(result));
    });
  }
});

test('oracle negative controls detect deletion, stream/promise writes, crash, leak, child and hang', async (t) => {
  const entrypoint = fileURLToPath(new URL('../scripts/fuzz/self-check.mjs', import.meta.url));
  for (const [mode, property] of Object.entries({
    delete: 'unexpected-deletion-attempt', stream: 'unexpected-write-attempt', promise: 'unexpected-write-attempt',
    child: 'unexpected-child', crash: 'uncaught-crash', leak: 'secret-disclosure', hang: 'timeout',
  })) {
    await t.test(mode, () => {
      const result = runCase({ id: `oracle-${mode}`, boundary: 'argv', argv: [mode] }, { entrypoint, timeoutMs: 1000, keepFailure: false });
      assert(result.violations.includes(property), JSON.stringify(result));
      assert(!result.violations.includes('observer-not-loaded'), JSON.stringify(result));
      assert.deepEqual(result.changed, []);
    });
  }
});

test('small generated campaign exercises real CLI paths without violating its contracts', (t) => {
  const result = campaign({ count: 32, timeoutMs: 2500, budgetMs: 60000, reductions: 0 });
  if (result.skipped) return t.skip('POSIX FIFO capability required for complete campaign');
  assert(result.complete, JSON.stringify(result));
  assert.equal(result.failed, 0, JSON.stringify(result.results.filter(r => r.violations.length)));
  assert(result.results.some(r => r.mutationAttempts > 0), 'Explicit setup control must perform real allowed writes');
});


test('preservation oracle rejects replaced scalars, lost fields and removed/duplicated list entries', () => {
  const old = { env: { TOKEN: 'unchanged' }, hooks: [{ value: 1 }, { value: 1 }] };
  assert(containsOriginal(old, { ...old, added: true }));
  assert(!containsOriginal(old, { ...old, env: { TOKEN: 'replaced' } }));
  assert(!containsOriginal(old, { hooks: old.hooks }));
  assert(!containsOriginal(old, { ...old, hooks: [{ value: 1 }] }));
});

test('reducer removes redundant argv while preserving the same failing property', () => {
  const result = minimize({ id: 'reduce-control', boundary: 'argv', argv: ['init', '--json'] },
    'unexpected-write-attempt', { timeoutMs: 1000 }, 8);
  assert(result.attempts <= 8);
  assert.deepEqual(result.input.argv, ['init']);
});

test('non-finite native configuration is not silently overwritten by setup', () => {
  const result = runCase({ id: 'claude-nonfinite', boundary: 'integration', slot: 'claude',
    payload: '{"x":1e999}', policy: 'setup', argv: ['setup', '--agents', 'claude'] }, { keepFailure: false, instrument: false });
  assert.deepEqual(result.violations, [], JSON.stringify(result));
});
