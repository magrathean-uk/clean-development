import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SECRET } from './corpus.mjs';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(REPO, 'bin/clean-development.js');
const OBSERVER = path.join(REPO, 'scripts/fuzz/observe.mjs');
export const LIMITS = Object.freeze({ timeoutMs: 2500, outputBytes: 128 * 1024, entries: 2048, fileBytes: 4 * 1024 * 1024, totalBytes: 32 * 1024 * 1024 });
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const expand = (value, root) => JSON.parse(JSON.stringify(value).replaceAll('$ROOT', root.replaceAll('\\', '\\\\')).replaceAll('$NODE', process.execPath.replaceAll('\\', '\\\\')));
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, { mode: 0o600 }); };

export function snapshot(root) {
  const result = {}; let count = 0, bytes = 0;
  function visit(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), rel = path.relative(root, file).split(path.sep).join('/');
      if (rel === 'telemetry') continue;
      if (++count > LIMITS.entries) throw new Error('Snapshot entry limit');
      const s = fs.lstatSync(file), entry = { mode: s.mode & 0o777 };
      if (s.isSymbolicLink()) Object.assign(entry, { type: 'link', target: fs.readlinkSync(file) });
      else if (s.isDirectory()) entry.type = 'directory';
      else if (s.isFile()) {
        if (s.size > LIMITS.fileBytes || (bytes += s.size) > LIMITS.totalBytes) throw new Error('Snapshot byte limit');
        Object.assign(entry, { type: 'file', size: s.size, hash: hash(fs.readFileSync(file)) });
      } else entry.type = s.isFIFO() ? 'fifo' : 'special';
      result[rel] = entry;
      if (entry.type === 'directory') visit(file);
    }
  }
  visit(root); return result;
}
export function isolatedEnvironment(root) {
  return {
    HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), CLEAN_DEVELOPMENT_HOME: path.join(root, 'home'),
    CLEAN_DEVELOPMENT_DATA_HOME: path.join(root, 'data'), CLEAN_DEVELOPMENT_CONFIG_HOME: path.join(root, 'config'), CLEAN_DEVELOPMENT_ROOT: path.join(root, 'managed'),
    XDG_DATA_HOME: path.join(root, 'xdg/data'), XDG_CONFIG_HOME: path.join(root, 'xdg/config'), XDG_CACHE_HOME: path.join(root, 'xdg/cache'),
    APPDATA: path.join(root, 'xdg/config'), LOCALAPPDATA: path.join(root, 'xdg/data'),
    TMPDIR: path.join(root, 'tmp'), TEMP: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'),
    CLAUDE_CONFIG_DIR: path.join(root, 'home/.claude'), CODEX_HOME: path.join(root, 'home/.codex'), GROK_HOME: path.join(root, 'home/.grok'),
    PATH: path.join(root, 'tools'), CI: '1', NO_COLOR: '1', LANG: 'C.UTF-8', FUZZ_CANARY: SECRET,
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec } : {}),
  };
}
function command(argv, root, env, timeoutMs, observe = true, entrypoint = CLI) {
  return spawnSync(process.execPath, ['--max-old-space-size=128', ...(observe ? ['--import', pathToFileURL(OBSERVER).href] : []), entrypoint, ...argv], {
    cwd: path.join(root, 'project'), env, encoding: 'utf8', input: '', timeout: timeoutMs,
    maxBuffer: LIMITS.outputBytes, killSignal: 'SIGKILL', windowsHide: true,
  });
}
export function allowedSetupPath(file) {
  return /^(data|config|managed)(\/|$)/.test(file)
    || /^home\/\.(claude|codex|grok)(\/((settings\.json|config\.toml)(\.tmp-[^/]+)?))?$/.test(file);
}
export function changedPaths(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k])).sort();
}
// Generic preservation oracle, independent of the integration writer: an
// explicit setup may add fields/list items, not replace existing user values.
export function containsOriginal(original, updated) {
  if (Array.isArray(original)) {
    if (!Array.isArray(updated)) return false;
    let index = 0;
    for (const item of updated) if (index < original.length && containsOriginal(original[index], item)) index++;
    return index === original.length;
  }
  if (original && typeof original === 'object') return Boolean(updated) && typeof updated === 'object' && !Array.isArray(updated)
    && Object.keys(original).every(key => Object.hasOwn(updated, key) && containsOriginal(original[key], updated[key]));
  return original === updated;
}
function preservedNative(spec, root, original, before, after, status) {
  if (original === null) return true;
  const rel = `home/.${spec.slot}/${spec.slot === 'claude' ? 'settings.json' : 'config.toml'}`;
  if (JSON.stringify(before[rel]) === JSON.stringify(after[rel])) return true;
  if (status !== 0 || after[rel]?.type !== 'file') return false;
  const text = fs.readFileSync(path.join(root, rel), 'utf8');
  if (spec.slot === 'claude') {
    try {
      const value = JSON.parse(original);
      // Scalar/array/non-JSON documents have no recognised settings-object
      // fields to preserve; the snapshot/error oracles still cover them.
      return !value || typeof value !== 'object' || Array.isArray(value) || containsOriginal(value, JSON.parse(text));
    } catch { return false; }
  }
  // Text subsequence checks retention/order only, not full TOML semantics.
  const lines = original.split(/\r?\n/).filter(Boolean);
  let index = 0;
  for (const line of text.split(/\r?\n/)) if (line === lines[index]) index++;
  return index === lines.length;
}
function clean(root, identity) {
  const now = fs.lstatSync(root);
  if (!now.isDirectory() || now.isSymbolicLink() || now.dev !== identity.dev || now.ino !== identity.ino || fs.realpathSync(root) !== root) throw new Error('Refusing changed fuzz fixture root');
  fs.rmSync(root, { recursive: true, force: false });
}
function prepare(spec, root, timeoutMs) {
  for (const name of ['home', 'tmp', 'tools', 'project', 'protected', 'telemetry', 'managed/builds', 'managed/caches', 'managed/scratch']) fs.mkdirSync(path.join(root, name), { recursive: true });
  // Bound ancestor discovery inside the lab, even when the caller has a
  // global /tmp configuration or manifest. These barriers are protected too.
  write(path.join(root, '.clean-development.json'), '{"schemaVersion":1}');
  write(path.join(root, 'Cargo.toml'), '[workspace]\nmembers=[]\n');
  write(path.join(root, 'package.json'), '{"private":true}');
  write(path.join(root, 'protected/secret'), `${SECRET}!`);
  write(path.join(root, 'home/.ssh/key'), SECRET);
  write(path.join(root, 'project/source.txt'), 'source must not change\n');
  write(path.join(root, 'project/deliverable.bin'), 'final artifact must survive\n');
  write(path.join(root, 'project/.git/HEAD'), 'ref: refs/heads/fixture\n');
  write(path.join(root, 'telemetry/events.jsonl'), '');
  const canary = `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(path.join(root, 'telemetry/child-executed'))}, 'executed'); process.exit(91);\n`;
  for (const name of ['canary', 'cargo', 'go', 'npm', 'npx', 'uv', 'git', 'sh', 'bash']) { write(path.join(root, 'tools', name), canary); fs.chmodSync(path.join(root, 'tools', name), 0o700); }
  const env = isolatedEnvironment(root);
  if (spec.installed) {
    const installed = command(['setup', '--agents', 'opencode', '--json'], root, env, timeoutMs, false);
    if (installed.status !== 0) throw new Error(`Trusted fixture setup failed: ${installed.error?.code || installed.stderr}`);
  }
  const id = 'fixture-0123456789', buildRoot = path.join(root, 'managed/builds');
  const registry = `${id}-${hash(buildRoot).slice(0, 8)}.json`;
  const slots = {
    project: 'project/.clean-development.json', package: 'project/package.json', cargo: 'project/Cargo.toml', python: 'project/pyproject.toml',
    state: `data/state/workspaces/${registry}`, marker: `managed/builds/${id}/.clean-development-owned.json`,
    runtime: 'data/state/runtime.json', integrations: 'data/state/integrations.json',
    claude: 'home/.claude/settings.json', codex: 'home/.codex/config.toml', grok: 'home/.grok/config.toml',
  };
  if (['state', 'marker'].includes(spec.boundary)) {
    const record = { schemaVersion: 1, workspaceId: id, workspace: path.join(root, 'project'), ownershipId: 'fixture-owned-id', buildRoot,
      path: path.join(buildRoot, id), lastUsedAt: '2000-01-01T00:00:00.000Z', pinned: false };
    write(path.join(root, slots.state), JSON.stringify(record));
    write(path.join(root, slots.marker), JSON.stringify({ schemaVersion: 1, owner: 'clean-development', ownershipId: record.ownershipId, workspaceId: id, workspace: record.workspace }));
    write(path.join(buildRoot, id, 'artifact'), 'retention canary');
  }
  if (spec.name) {
    if (!['CLEAN_DEVELOPMENT_ROOT', 'CLEAN_DEVELOPMENT_BUILD_ROOT', 'CLEAN_DEVELOPMENT_SESSION_MODE', 'CLEAN_DEVELOPMENT_SESSION_ENV'].includes(spec.name)) throw new Error('Unsupported fuzz environment key');
    env[spec.name] = expand(spec.payload, root);
  }
  if (spec.slot) {
    if (!Object.hasOwn(slots, spec.slot)) throw new Error('Unsupported fuzz file slot');
    const file = path.join(root, slots[spec.slot]); fs.mkdirSync(path.dirname(file), { recursive: true });
    let text = spec.payload ?? '{}';
    if (spec.mutation) {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      Object.defineProperty(value, spec.mutation.field, { value: expand(spec.mutation.value, root), enumerable: true, configurable: true, writable: true }); text = JSON.stringify(value);
    }
    if (fs.existsSync(file)) fs.unlinkSync(file);
    if (spec.topology === 'fifo') {
      const mkfifo = ['/usr/bin/mkfifo', '/bin/mkfifo'].find(p => fs.existsSync(p));
      if (process.platform === 'win32' || !mkfifo) return { skipped: 'POSIX mkfifo unavailable' };
      const made = spawnSync(mkfifo, [file], { env, timeout: timeoutMs, encoding: 'utf8', maxBuffer: LIMITS.outputBytes, killSignal: 'SIGKILL' });
      if (made.status !== 0) throw new Error(`FIFO fixture failed: ${made.error?.code || made.stderr}`);
    } else if (spec.topology === 'directory') fs.mkdirSync(file);
    else if (spec.topology === 'secret-link') fs.symlinkSync(path.join(root, 'protected/secret'), file);
    else if (spec.topology === 'oversize') write(file, ' '.repeat(1024 * 1024 + 1));
    else write(file, expand(String(text), root));
  }
  return { env };
}
export function runCase(spec, { timeoutMs = LIMITS.timeoutMs, keepFailure = true, parent = os.tmpdir(), instrument = true, entrypoint = CLI } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000) throw new Error('Invalid case timeout');
  if (!Array.isArray(spec.argv) || spec.argv.length > 32 || spec.argv.some(v => typeof v !== 'string' || v.includes('\0') || v.length > 8192)) throw new Error('Invalid case argv');
  if (JSON.stringify(spec).length > 65536) throw new Error('Case descriptor limit');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(parent, 'cd-fuzz-'))), identity = fs.lstatSync(root);
  try {
    const prepared = prepare(spec, root, timeoutMs);
    if (prepared.skipped) { clean(root, identity); return { id: spec.id, boundary: spec.boundary, skipped: prepared.skipped, violations: [] }; }
    const before = snapshot(root);
    const nativePath = ['claude', 'codex', 'grok'].includes(spec.slot) ? `home/.${spec.slot}/${spec.slot === 'claude' ? 'settings.json' : 'config.toml'}` : null;
    const nativeOriginal = nativePath && before[nativePath]?.type === 'file' ? fs.readFileSync(path.join(root, nativePath), 'utf8') : null;
    const env = { ...prepared.env, FUZZ_CASE_ROOT: root, FUZZ_POLICY: spec.policy || 'read-only' };
    const start = performance.now(), child = command(expand(spec.argv, root), root, env, timeoutMs, instrument, entrypoint);
    const elapsedMs = Math.round(performance.now() - start), stdout = child.stdout || '', stderr = child.stderr || '';
    const events = fs.readFileSync(path.join(root, 'telemetry/events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const after = snapshot(root), changed = changedPaths(before, after), mutations = events.filter(e => e.kind === 'mutation'), violations = [];
    if (instrument && !events.some(e => e.kind === 'ready')) violations.push('observer-not-loaded');
    if (child.error?.code === 'ETIMEDOUT') violations.push('timeout');
    else if (child.error) violations.push(`process-${child.error.code || 'error'}`);
    if (child.signal && !child.error) violations.push(`signal-${child.signal}`);
    if (events.some(e => e.kind === 'uncaught') || /\n\s+at .+\(.+:\d+:\d+\)/.test(stderr)) violations.push('uncaught-crash');
    if (events.some(e => e.kind === 'child-attempt') || fs.existsSync(path.join(root, 'telemetry/child-executed'))) violations.push('unexpected-child');
    if (stdout.includes(SECRET) || stderr.includes(SECRET)) violations.push('secret-disclosure');
    if (mutations.some(e => !e.allowed && /unlink|rm|rmdir/.test(e.api))) violations.push('unexpected-deletion-attempt');
    if (mutations.some(e => !e.allowed || spec.policy !== 'setup' || e.paths.some(p => !allowedSetupPath(p.replace('<case>/', '').replaceAll('\\', '/'))))) violations.push('unexpected-write-attempt');
    if (!preservedNative(spec, root, nativeOriginal, before, after, child.status)) violations.push('unexpected-configuration-change');
    const unexpected = changed.filter(p => spec.policy !== 'setup' || !allowedSetupPath(p));
    if (unexpected.some(p => before[p] && !after[p])) violations.push('unexpected-deletion');
    if (unexpected.some(p => after[p])) violations.push('unexpected-write');
    if (child.status !== null && ![0, 1].includes(child.status)) violations.push(`unexpected-exit-${child.status}`);
    const redact = value => String(value).replaceAll(root, '<case>').replaceAll(REPO, '<repo>').replaceAll(SECRET, '<synthetic-secret>');
    const result = { id: spec.id, boundary: spec.boundary, kind: spec.kind || 'regression', instrumented: instrument, violations: [...new Set(violations)], status: child.status,
      signal: child.signal, error: child.error?.code || null, elapsedMs, changed, mutationAttempts: mutations.length,
      childAttempts: events.filter(e => e.kind === 'child-attempt').length, stdout: redact(stdout).slice(0, 16384), stderr: redact(stderr).slice(0, 4096), outputSha256: hash(stdout + '\0' + stderr), retained: null };
    if (result.violations.length && keepFailure) { result.retained = root; write(path.join(root, 'telemetry/replay.json'), JSON.stringify(spec, null, 2) + '\n'); }
    else clean(root, identity);
    return result;
  } catch (error) {
    return { id: spec.id, boundary: spec.boundary, violations: ['harness-error'], error: String(error.message).replaceAll(root, '<case>').replaceAll(SECRET, '<synthetic-secret>'), retained: root };
  }
}
// Delta debugging keeps the same property, not merely any nonzero exit.
export function minimize(spec, signature, options = {}, maxAttempts = 24) {
  let current = structuredClone(spec), attempts = 0;
  // First minimise the invocation, then the bytes. FIFO/file-type failures are
  // already payload-free but can still have redundant CLI arguments removed.
  for (const key of ['argv', 'payload']) {
    if (key === 'payload' && (typeof current.payload !== 'string' || current.topology === 'fifo')) continue;
    let granularity = 2;
    while (current[key].length > 0 && attempts < maxAttempts) {
      const width = Math.ceil(current[key].length / granularity); let reduced = false;
      for (let start = 0; start < current[key].length && attempts < maxAttempts; start += width) {
        if (options.deadline !== undefined && performance.now() + (options.timeoutMs || LIMITS.timeoutMs) * 3 >= options.deadline) return { input: current, attempts, budgetExhausted: true };
        const candidate = { ...current, [key]: key === 'argv'
          ? [...current[key].slice(0, start), ...current[key].slice(start + width)]
          : current[key].slice(0, start) + current[key].slice(start + width) };
        const result = runCase(candidate, { ...options, keepFailure: false }); attempts++;
        if (result.violations.includes(signature) && !result.violations.includes('harness-error')) { current = candidate; granularity = Math.max(2, granularity - 1); reduced = true; break; }
      }
      if (!reduced) { if (granularity >= current[key].length) break; granularity = Math.min(current[key].length, granularity * 2); }
    }
  }
  return { input: current, attempts, budgetExhausted: false };
}
