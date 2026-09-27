import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repository, 'bin/clean-development.js');
const probe = path.join(repository, 'scripts/conformance/probe.cjs');
export const TOOLS = ['cargo', 'go', 'npm', 'uv'];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const write = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function executable(name, search = process.env.PATH || '') {
  for (const entry of search.split(path.delimiter).filter(Boolean)) {
    const candidate = path.resolve(entry, name);
    try { fs.accessSync(candidate, fs.constants.X_OK); if (fs.statSync(candidate).isFile()) return candidate; } catch {}
  }
  return null;
}
export function vectors(seed = 0x5eed, count = 4) {
  let state = seed >>> 0;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  const alphabet = ['', ' ', '\t', '\n', '\r', 'café', '東京', '🧪', 'e\u0301', '\u2028',
    '"', "'", '\\', '$HOME', '$(false)', ';', '&', '|', '<>', '*?[]{}', '%!=+^', '--cache=x'];
  const result = [['', 'two words', "single'quote", 'double"quote', '東京', '$();&|', '\t\n', '--', '--cache=literal']];
  for (let i = 1; i < count; i++) result.push(Array.from({ length: 1 + next() % 6 }, () =>
    Array.from({ length: 1 + next() % 4 }, () => alphabet[next() % alphabet.length]).join('')));
  return result;
}
export async function minimise(argv, stillFails, budget = 40) {
  let result = [...argv], calls = 0;
  for (let width = Math.max(1, Math.ceil(result.length / 2)); width >= 1; width = Math.floor(width / 2)) {
    for (let i = 0; i < result.length && calls < budget;) {
      const candidate = [...result.slice(0, i), ...result.slice(i + width)]; calls++;
      if (await stillFails(candidate)) result = candidate; else i += width;
    }
  }
  for (let i = 0; i < result.length && calls < budget; i++) {
    let chars = Array.from(result[i]);
    for (let width = Math.max(1, Math.ceil(chars.length / 2)); width >= 1 && calls < budget; width = Math.floor(width / 2)) {
      for (let j = 0; j < chars.length && calls < budget;) {
        const shorter = [...chars.slice(0, j), ...chars.slice(j + width)];
        const candidate = [...result]; candidate[i] = shorter.join(''); calls++;
        if (await stillFails(candidate)) { result = candidate; chars = shorter; } else j += width;
      }
    }
  }
  return { argv: result, calls, budget, minimality: 'bounded reduction; not a global minimum' };
}
export function commandResultEqual(direct, routed) {
  const differences = [];
  for (const stream of ['stdout', 'stderr']) if (direct[stream] !== routed[stream]) differences.push(stream);
  const signalStatus = direct.signal && 128 + os.constants.signals[direct.signal];
  const signalEquivalent = signalStatus && routed.code === signalStatus && routed.signal === null;
  if (!((direct.code === routed.code && direct.signal === routed.signal) || signalEquivalent)) differences.push('termination');
  if (direct.error || routed.error) differences.push('infrastructure');
  return { differences, accounting: signalEquivalent ? ['documented signal-to-128+signum exit conversion'] : [] };
}
export function environment(root, toolPaths) {
  const env = {
    PATH: [...new Set([path.dirname(process.execPath), ...Object.values(toolPaths).filter(Boolean).map(p => path.dirname(p)), '/usr/bin', '/bin'])].join(path.delimiter),
    HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
    TMPDIR: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'), TEMP: path.join(root, 'tmp'),
    XDG_CONFIG_HOME: path.join(root, 'xdg/config'), XDG_DATA_HOME: path.join(root, 'xdg/data'), XDG_CACHE_HOME: path.join(root, 'xdg/cache'), XDG_STATE_HOME: path.join(root, 'xdg/state'),
    CLEAN_DEVELOPMENT_HOME: path.join(root, 'home'), CLEAN_DEVELOPMENT_CONFIG_HOME: path.join(root, 'config'),
    CLEAN_DEVELOPMENT_DATA_HOME: path.join(root, 'data'), CLEAN_DEVELOPMENT_ROOT: path.join(root, 'managed'),
    CARGO_HOME: path.join(root, 'cargo-home'), CARGO_NET_OFFLINE: 'true', CARGO_TERM_COLOR: 'never',
    CARGO_PROFILE_DEV_DEBUG: '0', CARGO_INCREMENTAL: '0', RUSTUP_AUTO_INSTALL: '0', RUSTUP_NO_UPDATE_CHECK: '1',
    // Only the installed toolchain location is retained; no contributor Cargo settings or credentials.
    RUSTUP_HOME: process.env.RUSTUP_HOME || path.join(os.homedir(), '.rustup'),
    GOPATH: path.join(root, 'go-path'), GOPROXY: 'off', GOSUMDB: 'off', GOTOOLCHAIN: 'local',
    GOENV: 'off', GOWORK: 'off', GOTELEMETRY: 'off', CGO_ENABLED: '0', GOFLAGS: '-p=2',
    npm_config_userconfig: path.join(root, 'npm-user.conf'), npm_config_globalconfig: path.join(root, 'npm-global.conf'),
    npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false',
    UV_OFFLINE: '1', UV_PYTHON_DOWNLOADS: 'never', UV_PYTHON_INSTALL_DIR: path.join(root, 'python-install'), UV_NO_CONFIG: '1', UV_LINK_MODE: 'copy',
    NO_COLOR: '1', LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8', TZ: 'UTC', SOURCE_DATE_EPOCH: '1700000000',
    LAB_NODE: process.execPath, LAB_SENTINEL: 'untouched $HOME ; & = %', LAB_EMPTY: '', LAB_UNICODE: 'café 東京 🧪'
  };
  for (const key of ['HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'CARGO_HOME', 'GOPATH']) fs.mkdirSync(env[key], { recursive: true });
  write(env.npm_config_userconfig, ''); write(env.npm_config_globalconfig, '');
  return env;
}
export async function capture(command, argv, { cwd, env, input = Buffer.alloc(0), signal, timeout = 120000 } = {}) {
  return new Promise(resolve => {
    const chunks = { stdout: [], stderr: [] }; let bytes = 0, error = null, sent = false, cleanup = null;
    let rootExit = null;
    const child = spawn(command, argv, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const killGroup = () => { if (!child.pid) return; try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') error ||= e.message; } };
    const timer = setTimeout(() => { error ||= 'process deadline exceeded'; killGroup(); }, timeout);
    child.on('error', e => { error ||= e.code || e.message; });
    child.stdin.on('error', e => { if (e.code !== 'EPIPE') error ||= e.code || e.message; });
    child.stdin.end(input);
    for (const stream of ['stdout', 'stderr']) child[stream].on('data', chunk => {
      bytes += chunk.length; if (bytes <= 2 * 1024 * 1024) chunks[stream].push(chunk);
      if (bytes > 2 * 1024 * 1024) { error ||= 'output limit exceeded'; killGroup(); }
      if (signal && !sent && stream === 'stdout' && Buffer.concat(chunks.stdout).includes(Buffer.from('\nCONFORMANCE_READY\n'))) {
        sent = true;
        // Model a terminal signal to the foreground process group, including tool descendants.
        try { process.kill(-child.pid, signal); } catch (e) { error ||= e.message; }
      }
    });
    child.once('exit', (code, exitSignal) => {
      rootExit = { code, signal: exitSignal };
      // A tool may leave a child holding its pipes after its own exit. Do not hang or leak it.
      // Cleanup is outside the observed entry-process termination, never a product claim.
      cleanup = setTimeout(killGroup, 100);
    });
    child.once('close', (code, exitSignal) => {
      clearTimeout(timer); if (cleanup) clearTimeout(cleanup);
      if (signal && !sent) error ||= 'signal case never reached readiness';
      resolve({ command, argv, cwd, ...(rootExit || { code, signal: exitSignal }),
        stdout: Buffer.concat(chunks.stdout).toString('base64'), stderr: Buffer.concat(chunks.stderr).toString('base64'),
        signalSent: sent ? signal : null, signalTarget: signal ? 'process-group' : null, error });
    });
  });
}
function text(result, stream = 'stdout') { return Buffer.from(result[stream], 'base64').toString('utf8'); }
function successful(result) { assert.equal(result.error, null); assert.equal(result.code, 0, text(result, 'stderr')); }
function listFiles(directory, limit = 20000) {
  const entries = []; const pending = [directory];
  while (pending.length) {
    const current = pending.pop(); if (!fs.existsSync(current)) continue;
    const st = fs.lstatSync(current);
    if (entries.length + pending.length > limit) throw new Error('inventory entry limit exceeded');
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) for (const name of fs.readdirSync(current)) pending.push(path.join(current, name));
    else if (st.isFile()) entries.push(current);
  }
  return entries.sort();
}
function sourceSnapshot(project, sources) {
  assert.equal(fs.existsSync(path.join(project, '.clean-development.json')), false, 'session-only must not persist config');
  return Object.fromEntries(sources.map(file => {
    const location = path.join(project, file), st = fs.lstatSync(location);
    assert.ok(st.isFile() && !st.isSymbolicLink(), 'source must remain a regular file');
    return [file, { sha256: hash(fs.readFileSync(location)), mode: st.mode & 0o777 }];
  }));
}
export function assertObservationPair(tool, observations, env, override = {}) {
  const [direct, routed] = observations;
  const bin = path.join(env.CLEAN_DEVELOPMENT_DATA_HOME, 'bin');
  assert.equal(routed.path.split(path.delimiter).filter(p => p === bin).length, 1, 'exactly one owned shim PATH');
  assert.deepEqual(routed.path.split(path.delimiter).filter(p => p !== bin), direct.path.split(path.delimiter), 'other PATH entries/order changed');
  assert.equal(direct.sessionMode, null); assert.equal(routed.sessionMode, 'session-only');
  const owned = { cargo: ['CARGO_TARGET_DIR'], go: ['GOCACHE', 'GOMODCACHE'], npm: ['npm_config_cache'], uv: ['UV_CACHE_DIR'] }[tool];
  for (const key of Object.keys(direct.environment)) {
    if (!owned.includes(key) || Object.hasOwn(override, key)) assert.equal(routed.environment[key], direct.environment[key], `unrelated/explicit ${key}`);
  }
  if (tool === 'cargo') assertCache(tool, JSON.stringify({ target_directory: routed.environment.CARGO_TARGET_DIR }), { ...env, ...override }, true, env.LAB_PROJECT || routed.cwd);
  else if (tool === 'go') assert.deepEqual(Object.fromEntries(owned.map(key => [key, routed.environment[key]])), expectedCache(tool, { ...env, ...override }, true));
  else assert.equal(routed.environment[owned[0]], expectedCache(tool, { ...env, ...override }, true));
}
function canonicalCacheOutput(tool, output, env, routed, project) {
  assertCache(tool, output, env, routed, project);
  if (tool === 'cargo') {
    const value = JSON.parse(output), target = value.target_directory;
    // Only the documented target path may differ; retain all other bytes/fields.
    if (Object.hasOwn(value, 'build_directory')) assert.equal(value.build_directory, target);
    return output.split(JSON.stringify(target)).join(JSON.stringify('<CARGO_TARGET>'));
  }
  if (tool === 'go') {
    for (const [key, value] of Object.entries(expectedCache(tool, env, routed))) output = output.split(JSON.stringify(value)).join(JSON.stringify(`<${key}>`));
    return output;
  }
  assert.equal(output, expectedCache(tool, env, routed) + '\n');
  return '<CACHE>\n';
}
function makeProject(root, tool) {
  const project = path.join(root, 'project café 東京 & [x]'); fs.mkdirSync(project);
  fs.copyFileSync(probe, path.join(project, 'probe.cjs'));
  const files = ['probe.cjs'];
  const put = (file, content) => { write(path.join(project, file), content); files.push(file); };
  if (tool === 'npm') {
    put('package.json', JSON.stringify({ name: 'conformance-probe', version: '1.0.0', files: ['payload.txt'],
      scripts: { probe: 'node probe.cjs' } }) + '\n');
    put('payload.txt', 'same package bytes café 東京\n');
  } else if (tool === 'cargo') {
    put('Cargo.toml', '[package]\nname="conformance-probe"\nversion="1.0.0"\nedition="2021"\n');
    put('Cargo.lock', 'version = 3\n\n[[package]]\nname = "conformance-probe"\nversion = "1.0.0"\n');
    put('src/main.rs', 'use std::{env,process::Command};use std::os::unix::process::CommandExt;fn main(){let e=Command::new(env::var("LAB_NODE").unwrap()).arg(env::var("LAB_PROBE").unwrap()).args(env::args_os().skip(1)).exec();panic!("{e}");}\n');
  } else if (tool === 'go') {
    put('go.mod', 'module example.invalid/conformance\n\ngo 1.22\n');
    put('main.go', 'package main\nimport("os";"syscall")\nfunc main(){n:=os.Getenv("LAB_NODE");a:=append([]string{n,os.Getenv("LAB_PROBE")},os.Args[1:]...);if e:=syscall.Exec(n,a,os.Environ());e!=nil{panic(e)}}\n');
  } else put('pyproject.toml', '[project]\nname="conformance-probe"\nversion="1.0.0"\n');
  return { project, sources: files };
}
function probeArgs(tool, mode, args) {
  if (tool === 'cargo') return ['run', '--offline', '--locked', '--quiet', '--', mode, ...args];
  if (tool === 'go') return ['run', '-trimpath', '.', mode, ...args];
  if (tool === 'npm') return ['--silent', 'run', 'probe', '--', mode, ...args];
  return ['--quiet', 'run', '--no-project', '--no-python-downloads', '--', 'node', 'probe.cjs', mode, ...args];
}
function expectedCache(tool, env, routed) {
  const base = env.CLEAN_DEVELOPMENT_ROOT;
  if (tool === 'npm') return env.npm_config_cache || (routed ? path.join(base, 'caches/node/npm') : path.join(env.HOME, '.npm'));
  if (tool === 'uv') return env.UV_CACHE_DIR || (routed ? path.join(base, 'caches/python/uv') : path.join(env.XDG_CACHE_HOME, 'uv'));
  if (tool === 'go') return { GOCACHE: env.GOCACHE || (routed ? path.join(base, 'caches/go/build') : path.join(env.XDG_CACHE_HOME, 'go-build')),
    GOMODCACHE: env.GOMODCACHE || (routed ? path.join(base, 'caches/go/modules') : path.join(env.GOPATH, 'pkg/mod')) };
  return null;
}
function assertCache(tool, actual, env, routed, project) {
  if (tool === 'cargo') {
    const target = JSON.parse(actual).target_directory;
    if (env.CARGO_TARGET_DIR) assert.equal(target, env.CARGO_TARGET_DIR);
    else if (!routed) assert.equal(target, path.join(project, 'target'));
    else {
      const relative = path.relative(path.join(env.CLEAN_DEVELOPMENT_ROOT, 'builds'), target);
      assert.match(relative, /^[^/\\]+[/\\]cargo[/\\]target$/);
      const owner = JSON.parse(fs.readFileSync(path.join(target, '../..', '.clean-development-owned.json')));
      assert.equal(owner.workspace, project); assert.equal(owner.owner, 'clean-development');
      assert.ok(owner.ownershipId);
    }
  } else if (tool === 'go') assert.deepEqual(JSON.parse(actual), expectedCache(tool, env, routed));
  else assert.equal(actual.trim(), expectedCache(tool, env, routed));
}
function cacheArgs(tool) { return { cargo: ['metadata', '--offline', '--no-deps', '--format-version=1'],
  go: ['env', '-json', 'GOCACHE', 'GOMODCACHE'], npm: ['config', 'get', 'cache'], uv: ['cache', 'dir', '--no-config'] }[tool]; }
function collectArtifact(file) { const st = fs.statSync(file); assert.ok(st.isFile() && st.size > 0); return { path: file, bytes: st.size, sha256: hash(fs.readFileSync(file)) }; }

export async function runToolLab(tool, { seed = 0x5eed, count = 4, parent = os.tmpdir(), minimiseFailures = true } = {}) {
  assert.ok(TOOLS.includes(tool));
  if (process.platform === 'win32') return { tool, status: 'blocked', reason: 'POSIX lab; native Windows not claimed', cases: [] };
  const toolPaths = Object.fromEntries([...TOOLS, 'python3', 'rustc'].map(name => [name, executable(name)]));
  if (!toolPaths[tool] || (tool === 'cargo' && !toolPaths.rustc) || (tool === 'uv' && !toolPaths.python3))
    return { tool, status: 'blocked', reason: 'required native executable unavailable', cases: [] };
  const root = fs.realpathSync(fs.mkdtempSync(path.join(parent, `cd-conformance-${tool}-`)));
  const env = environment(root, toolPaths); env.LAB_TOOL = tool;
  env.LAB_OBSERVATION = path.join(root, 'observation.json');
  const { project, sources } = makeProject(root, tool); env.LAB_PROBE = path.join(project, 'probe.cjs'); const initialSources = sourceSnapshot(project, sources);
  const result = { tool, seed, count, root, platform: `${process.platform}-${process.arch}`, kernel: os.release(), node: process.version,
    status: 'running', cases: [], commands: [], artifacts: [], failures: [],
    scope: 'same physical cwd and argv; real tool invocation; selected environment and nested effective caches; separate stdout/stderr byte comparison' };
  const run = async (routed, args, options = {}) => {
    const r = await capture(routed ? process.execPath : toolPaths[tool], routed ? [cli, 'run', '--session', 'session-only', '--', tool, ...args] : args,
      { cwd: options.cwd || project, env: { ...env, ...options.env }, input: options.input, signal: options.signal });
    result.commands.push({ lane: routed ? 'routed' : 'direct', ...r }); return r;
  };
  const save = () => write(path.join(root, 'report.json'), JSON.stringify(result, null, 2) + '\n');
  try {
    const version = await capture(toolPaths[tool], tool === 'go' ? ['version'] : ['--version'], { cwd: project, env }); successful(version);
    result.version = text(version).trim(); result.executable = toolPaths[tool];
    result.executableSha256 = hash(fs.readFileSync(fs.realpathSync(toolPaths[tool])));
    if (tool === 'cargo') { const r = await capture(toolPaths.rustc, ['-vV'], { cwd: project, env }); successful(r); result.rustc = text(r).trim(); }
    if (tool === 'uv') { const r = await capture(toolPaths.python3, ['--version'], { cwd: project, env }); successful(r); result.python = text(r).trim(); }
    let random = seed >>> 0;
    const input = Buffer.concat([Buffer.from([0, 255, 254, 13, 10]), Buffer.from('stdin café 東京 🧪\n'), Buffer.from(Array.from({ length: 257 }, () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random >>> 24; }))]);
    const pair = async (id, args, { mode = 'echo', override = {}, signal, nativeCwd = false, record = true } = {}) => {
      const observations = [], captures = [], violations = [];
      const caller = path.join(root, 'caller'); fs.mkdirSync(caller, { recursive: true });
      const launchCwd = nativeCwd ? caller : project, childCwd = nativeCwd && tool === 'cargo' ? caller : project;
      const argv = probeArgs(tool, mode, args);
      if (nativeCwd) {
        if (tool === 'cargo') argv.splice(1, 0, '--manifest-path', path.join(project, 'Cargo.toml'));
        else argv.unshift({ go: '-C', npm: '--prefix', uv: '--directory' }[tool], project);
      }
      for (const routed of [false, true]) {
        fs.rmSync(env.LAB_OBSERVATION, { force: true }); fs.rmSync(path.join(childCwd, 'artifact.bin'), { force: true });
        const value = await run(routed, argv, { input, env: override, signal, cwd: launchCwd }); captures.push(value);
        try {
        assert.ok(fs.existsSync(env.LAB_OBSERVATION), `${id}: real tool never executed probe: ${text(value, 'stderr')}`);
        const observed = JSON.parse(fs.readFileSync(env.LAB_OBSERVATION)); observations.push(observed);
        assert.deepEqual(observed.argv, args, `${id}: native argv effects`); assert.equal(observed.cwd, childCwd);
        assert.deepEqual(fs.readFileSync(path.join(childCwd, 'artifact.bin')), input, `${id}: stdin artifact`);
        for (const key of ['LAB_SENTINEL', 'LAB_EMPTY', 'LAB_UNICODE', 'CARGO_HOME', 'GOPATH', 'npm_config_userconfig', 'UV_PYTHON_INSTALL_DIR'])
          assert.equal(observed.user[key], override[key] ?? env[key], `${id}: user variable ${key}`);
        for (const [key, value] of Object.entries(override)) assert.equal(observed.environment[key], value, `${id}: override ${key}`);
        if (observed.nested) {
          assert.equal(observed.nested.code, 0); assert.equal(observed.nested.stderr, '');
          assertCache(tool, observed.nested.stdout, { ...env, ...override }, routed, project);
        }
        assert.deepEqual(sourceSnapshot(project, sources), initialSources, 'source/config bytes changed');
        } catch (error) { violations.push({ lane: routed ? 'routed' : 'direct', error: error.message }); }
      }
      const comparison = commandResultEqual(...captures);
      if (observations.length === 2 && !violations.length) {
        try {
          assertObservationPair(tool, observations, { ...env, LAB_PROJECT: project }, override);
          if (mode === 'nested') assert.equal(canonicalCacheOutput(tool, observations[0].nested.stdout, { ...env, ...override }, false, project),
            canonicalCacheOutput(tool, observations[1].nested.stdout, { ...env, ...override }, true, project), 'unexplained nested output difference');
        } catch (error) { violations.push({ lane: 'comparison', error: error.message }); }
      }
      if (violations.length) comparison.differences.push('observation-invariant');
      const item = { id, mode, argv: args, launchCwd, childCwd, signal: signal || null, override, ...comparison, observations, violations, accounting: [...comparison.accounting, 'one owned PATH entry and explicit session mode', 'declared adapter cache variables only'],
        status: comparison.differences.length ? 'failed' : 'passed' };
      if (record) result.cases.push(item);
      return item;
    };
    for (const [i, argv] of vectors(seed, count).entries()) {
      const item = await pair(`argv-${i}`, argv);
      if (item.status === 'failed') {
        if (minimiseFailures) item.reproduction = await minimise(argv, async candidate => {
          const replay = await pair('reduce', candidate, { record: false }); return same(replay.differences, item.differences);
        });
        result.failures.push(item.id);
      }
    }
    for (const [i, exit] of [7, 37, 1 + seed % 124].entries()) { const item = await pair(`exit-${exit}`, vectors(seed ^ 0xabcdef, 3)[i], { mode: `exit:${exit}` });
      if (item.status === 'failed') result.failures.push(item.id); }
    const changedCwd = await pair('native-cwd', ['cwd café'], { nativeCwd: true }); if (changedCwd.status === 'failed') result.failures.push(changedCwd.id);
    const nested = await pair('nested', ['nested ; 東京'], { mode: 'nested' }); if (nested.status === 'failed') result.failures.push(nested.id);
    const keys = { cargo: ['CARGO_TARGET_DIR'], go: ['GOCACHE', 'GOMODCACHE'], npm: ['npm_config_cache'], uv: ['UV_CACHE_DIR'] }[tool];
    const override = Object.fromEntries(keys.map(key => [key, path.join(root, `explicit ${key} café`)]));
    const overridden = await pair('user-overrides', ['override'], { mode: 'nested', override }); if (overridden.status === 'failed') result.failures.push(overridden.id);
    for (const signal of ['SIGINT', 'SIGTERM']) { const item = await pair(signal, [], { mode: 'signal', signal });
      if (item.status === 'failed') result.failures.push(item.id); }
    // Invalid native options must fail identically, not just agree on success.
    const invalid = [];
    for (const lane of [false, true]) invalid.push(await run(lane, ['--conformance-invalid-option=東京']));
    const comparison = commandResultEqual(...invalid); assert.notEqual(invalid[0].code, 0);
    result.cases.push({ id: 'native-invalid-option', ...comparison, status: comparison.differences.length ? 'failed' : 'passed' });
    if (comparison.differences.length) result.failures.push('native-invalid-option');
    if (['npm', 'uv'].includes(tool)) {
      const destination = path.join(root, 'flag cache café = &');
      for (const attached of [false, true]) {
        const flag = tool === 'npm' ? '--cache' : '--cache-dir';
        const args = [...(attached ? [`${flag}=${destination}`] : [flag, destination]), ...cacheArgs(tool)];
        const values = [await run(false, args), await run(true, args)]; values.forEach(successful);
        assert.equal(text(values[0]), destination + '\n');
        assert.deepEqual(commandResultEqual(...values).differences, []);
        result.cases.push({ id: `leading-cache-${attached ? 'equals' : 'split'}`, status: 'passed', destination });
      }
    }
    // Real build/package/cache artifacts: compare explicit final deliverables byte-for-byte.
    const artifacts = [], buildCaptures = [], cacheOutputs = [];
    for (const routed of [false, true]) {
      const query = await run(routed, cacheArgs(tool)); successful(query); cacheOutputs.push(canonicalCacheOutput(tool, text(query), env, routed, project));
      let file;
      if (tool === 'cargo') {
        fs.rmSync(path.join(JSON.parse(text(query)).target_directory, 'debug/conformance-probe'), { force: true });
        const built = await run(routed, ['build', '--offline', '--locked', '--quiet']); successful(built); buildCaptures.push(built);
        file = path.join(JSON.parse(text(query)).target_directory, 'debug/conformance-probe');
      } else if (tool === 'go') {
        file = path.join(project, 'deliverables/probe'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.rmSync(file, { force: true });
        const built = await run(routed, ['build', '-trimpath', '-ldflags=-buildid=', '-o', file, '.']); successful(built); buildCaptures.push(built);
        assert.ok(listFiles(expectedCache(tool, env, routed).GOCACHE).some(p => /[a-f0-9]{64}-[ad]$/.test(p)), 'real Go cache entries');
      } else if (tool === 'npm') {
        const dir = path.join(project, 'deliverables'); fs.mkdirSync(dir, { recursive: true }); fs.rmSync(path.join(dir, 'conformance-probe-1.0.0.tgz'), { force: true });
        const packed = await run(routed, ['pack', '--quiet', '--json', '--ignore-scripts', '--pack-destination', dir]); successful(packed); buildCaptures.push(packed);
        file = path.join(dir, JSON.parse(text(packed))[0].filename);
        successful(await run(routed, ['cache', 'add', file, '--silent', '--ignore-scripts']));
        const wanted = hash(fs.readFileSync(file));
        assert.ok(listFiles(path.join(expectedCache(tool, env, routed), '_cacache/content-v2')).some(p => hash(fs.readFileSync(p)) === wanted), 'exact tarball bytes in native npm cache');
      } else {
        file = path.join(project, 'conformance_probe-1.0.0-py3-none-any.whl');
        if (!fs.existsSync(file)) {
          const python = ['import sys,zipfile', 'with zipfile.ZipFile(sys.argv[1],"w") as z:',
            ' for n,s in {"conformance_probe.py":"VALUE = 42\\n", "conformance_probe-1.0.0.dist-info/METADATA":"Metadata-Version: 2.1\\nName: conformance-probe\\nVersion: 1.0.0\\n", "conformance_probe-1.0.0.dist-info/WHEEL":"Wheel-Version: 1.0\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n", "conformance_probe-1.0.0.dist-info/RECORD":""}.items(): z.writestr(zipfile.ZipInfo(n,(2020,1,1,0,0,0)),s)'].join('\n');
          successful(await capture(toolPaths.python3, ['-I', '-c', python, file], { cwd: project, env }));
        }
        const target = path.join(project, 'deliverables/site'); fs.rmSync(target, { recursive: true, force: true });
        const built = await run(routed, ['--quiet', 'pip', 'install', '--python', toolPaths.python3, '--target', target, '--no-deps', '--no-index', '--no-managed-python', file]); successful(built); buildCaptures.push(built);
        file = path.join(target, 'conformance_probe.py'); assert.equal(fs.readFileSync(file, 'utf8'), 'VALUE = 42\n');
        assert.ok(listFiles(expectedCache(tool, env, routed)).some(p => path.basename(p) === 'conformance_probe.py' && fs.readFileSync(p, 'utf8') === 'VALUE = 42\n'), 'real uv wheel cache payload');
      }
      artifacts.push({ lane: routed ? 'routed' : 'direct', ...collectArtifact(file) });
    }
    result.artifacts = artifacts;
    assert.equal(cacheOutputs[0], cacheOutputs[1], 'only declared cache paths may differ');
    assert.deepEqual(commandResultEqual(...buildCaptures).differences, [], 'build/package output differs');
    assert.equal(artifacts[0].sha256, artifacts[1].sha256, 'produced artifact bytes differ');
    result.cases.push({ id: 'real-artifacts', status: 'passed', accounting: tool === 'cargo' ? ['Cargo target is relocated to marker-verified managed build root'] : ['shared caches relocate; explicit final artifact path does not'] });
    assert.deepEqual(sourceSnapshot(project, sources), initialSources);
    result.status = result.failures.length ? 'failed' : 'passed';
  } catch (error) { result.status = 'failed'; result.error = error.stack; }
  save(); return result;
}

export async function main(args) {
  const options = { seed: 0x5eed, count: 4, tools: TOOLS, output: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') { console.log('node scripts/conformance-lab.mjs [--tools cargo,go,npm,uv] [--seed UINT32] [--count 1..32] [--output NEW_JSON]\nRuns real offline direct/routed commands in retained disposable roots. Exit: 0 passed, 1 difference/error, 2 missing tools.'); return 0; }
    const key = args[i].slice(2), value = args[++i]; if (!['seed', 'count', 'tools', 'output'].includes(key) || !value) throw new Error('Invalid arguments; use --help');
    options[key] = ['seed', 'count'].includes(key) ? Number(value) : key === 'tools' ? value.split(',') : value;
  }
  assert.ok(Number.isInteger(options.seed) && options.seed >= 0 && options.seed <= 0xffffffff);
  assert.ok(Number.isInteger(options.count) && options.count >= 1 && options.count <= 32);
  assert.ok(options.tools.length && options.tools.every(tool => TOOLS.includes(tool)));
  if (options.output) { const fd = fs.openSync(options.output, 'wx', 0o600); fs.closeSync(fd); }
  const result = { schemaVersion: 1, startedAt: new Date().toISOString(), indexTree: spawnSync('git', ['write-tree'], { cwd: repository, encoding: 'utf8' }).stdout?.trim(),
    sourceHead: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).stdout?.trim(),
    worktreeStatus: spawnSync('git', ['status', '--porcelain'], { cwd: repository, encoding: 'utf8' }).stdout?.trim(),
    files: Object.fromEntries(['scripts/conformance-lab.mjs', 'scripts/conformance/probe.cjs', ...fs.readdirSync(path.join(repository, 'src')).filter(f => f.endsWith('.js')).map(f => `src/${f}`)].map(f => [f, hash(fs.readFileSync(path.join(repository, f)))])), seed: options.seed, results: [] };
  for (const tool of options.tools) {
    const item = await runToolLab(tool, options); result.results.push(item);
    console.error(`${tool}: ${item.status} (${item.version || item.reason}); ${item.root || ''}`);
    if (options.output) write(options.output, JSON.stringify(result, null, 2) + '\n');
  }
  result.completedAt = new Date().toISOString();
  const code = result.results.some(r => r.status === 'failed') ? 1 : result.results.some(r => r.status === 'blocked') ? 2 : 0;
  if (options.output) write(options.output, JSON.stringify(result, null, 2) + '\n');
  else console.log(JSON.stringify(result, null, 2));
  return code;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => { console.error(error.message); process.exitCode = 1; });
}
