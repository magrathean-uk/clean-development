// Executed by a real tool's child, never used as a replacement tool executable.
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const mode = process.argv[2];
const args = process.argv.slice(3);
const input = fs.readFileSync(0);
const envKeys = ['LAB_SENTINEL', 'LAB_EMPTY', 'LAB_UNICODE', 'CARGO_HOME', 'GOPATH',
  'npm_config_userconfig', 'UV_PYTHON_INSTALL_DIR'];
const user = Object.fromEntries(envKeys.map(key => [key, process.env[key] ?? null]));
const observation = { argv: args, cwd: process.cwd(), user };
const cacheKeys = ['CARGO_TARGET_DIR', 'GOCACHE', 'GOMODCACHE', 'npm_config_cache', 'UV_CACHE_DIR'];
const evidence = { ...observation, pid: process.pid, ppid: process.ppid,
  environment: Object.fromEntries(cacheKeys.map(key => [key, process.env[key] ?? null])),
  path: process.env.PATH, sessionMode: process.env.CLEAN_DEVELOPMENT_SESSION_MODE ?? null };
if (mode === 'nested') {
  const commands = { cargo: ['metadata', '--offline', '--no-deps', '--format-version=1'],
    go: ['env', '-json', 'GOCACHE', 'GOMODCACHE'], npm: ['config', 'get', 'cache'], uv: ['cache', 'dir', '--no-config'] };
  const tool = process.env.LAB_TOOL;
  const child = cp.spawnSync(tool, commands[tool], { encoding: 'utf8', timeout: 10000, maxBuffer: 1048576 });
  if (child.error) throw child.error;
  evidence.nested = { command: tool, argv: commands[tool], cwd: process.cwd(), code: child.status,
    signal: child.signal, stdout: child.stdout, stderr: child.stderr };
  if (child.status !== 0) throw new Error(`nested ${tool} failed: ${child.stderr}`);
}
fs.writeFileSync(process.env.LAB_OBSERVATION, JSON.stringify(evidence));
fs.writeFileSync(path.join(process.cwd(), 'artifact.bin'), input);
fs.writeSync(1, Buffer.from(JSON.stringify(observation) + '\n'));
fs.writeSync(1, input);
fs.writeSync(2, Buffer.concat([Buffer.from('stderr\0'), input]));
if (mode === 'signal') {
  // Only publish readiness after stdin, evidence and output have been consumed.
  fs.writeSync(1, Buffer.from('\nCONFORMANCE_READY\n'));
  setInterval(() => {}, 1000);
} else if (mode.startsWith('exit:')) process.exitCode = Number(mode.slice(5));
