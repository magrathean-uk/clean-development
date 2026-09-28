// Test-only observer, not an OS sandbox. Reject forbidden attempts before they
// touch a contributor's files or launch a tool. Allowed fixture writes stay real.
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const root = fs.realpathSync(process.env.FUZZ_CASE_ROOT);
const policy = process.env.FUZZ_POLICY;
const write = fs.writeSync.bind(fs);
const log = fs.openSync(path.join(root, 'telemetry', 'events.jsonl'), 'a', 0o600);
let count = 0;
function event(value) {
  if (++count > 4096) process.exit(98);
  write(log, JSON.stringify(value) + '\n');
}
function normalized(file) {
  if (typeof file === 'number') return `<fd:${file}>`;
  return path.resolve(String(file)).replace(root, '<case>');
}
function permitted(file) {
  if (typeof file !== 'string' && !Buffer.isBuffer(file)) return false;
  let p = path.resolve(String(file));
  const tail = [];
  // Resolve existing ancestors, including leaf links, before allowing writes.
  while (!fs.existsSync(p)) { const parent = path.dirname(p); if (parent === p) return false; tail.unshift(path.basename(p)); p = parent; }
  p = path.resolve(fs.realpathSync(p), ...tail);
  const rel = path.relative(root, p);
  const portable = rel.split(path.sep).join('/');
  return policy === 'setup' && !rel.startsWith('..') && !path.isAbsolute(rel)
    && (/^(data|config|managed)(\/|$)/.test(portable)
      || /^home\/\.(claude|codex|grok)(\/((settings\.json|config\.toml)(\.tmp-[^/]+)?))?$/.test(portable));
}
function mutation(api, files) {
  const allowed = files.every(permitted);
  event({ kind: 'mutation', api, paths: files.map(normalized), allowed });
  if (!allowed) throw new Error('Fuzz observer rejected filesystem mutation');
}
const targets = { copyFile: [1], cp: [1], rename: [0, 1], link: [1], symlink: [1] };
for (const stem of ['appendFile', 'writeFile', 'unlink', 'rm', 'rmdir', 'mkdir', 'mkdtemp', 'rename', 'copyFile', 'cp', 'chmod', 'chown', 'lchmod', 'lchown', 'truncate', 'utimes', 'lutimes', 'link', 'symlink']) {
  for (const api of [stem, `${stem}Sync`]) {
    if (typeof fs[api] !== 'function') continue;
    const original = fs[api];
    // writeFile/appendFile/truncate also accept a descriptor; attribute it to its opened path.
    fs[api] = (...args) => { mutation(api, (targets[stem] || [0]).map(i => typeof args[i] === 'number' ? fds.get(args[i]) ?? args[i] : args[i])); return original(...args); };
  }
  if (typeof fs.promises[stem] === 'function') {
    const original = fs.promises[stem].bind(fs.promises);
    fs.promises[stem] = async (...args) => { mutation(`promises.${stem}`, (targets[stem] || [0]).map(i => args[i])); return original(...args); };
  }
}
function writable(flags) { return typeof flags === 'number' ? Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) : /[wa+]/.test(flags); }
const fds = new Map();
const open = fs.openSync;
fs.openSync = (file, flags, ...args) => { if (writable(flags)) mutation('openSync', [file]); const fd = open(file, flags, ...args); fds.set(fd, file); return fd; };
const asyncOpen = fs.open;
fs.open = (file, flags, ...args) => {
  if (writable(flags)) mutation('open', [file]);
  const callback = args.pop();
  return asyncOpen(file, flags, ...args, (error, fd) => { if (!error) fds.set(fd, file); callback(error, fd); });
};
const promiseOpen = fs.promises.open.bind(fs.promises);
fs.promises.open = async (file, flags, ...args) => {
  if (writable(flags)) mutation('promises.open', [file]);
  const handle = await promiseOpen(file, flags, ...args);
  for (const name of ['write', 'writev', 'writeFile', 'appendFile', 'truncate', 'chmod', 'chown', 'utimes', 'createWriteStream']) {
    if (typeof handle[name] !== 'function') continue;
    const original = handle[name].bind(handle);
    handle[name] = (...values) => { mutation(`FileHandle.${name}`, [file]); return original(...values); };
  }
  return handle;
};
const createWriteStream = fs.createWriteStream;
fs.createWriteStream = (file, options) => { mutation('createWriteStream', [file ?? options?.fd]); return createWriteStream(file, options); };
const close = fs.closeSync;
fs.closeSync = (fd) => { fds.delete(fd); return close(fd); };
for (const api of ['write', 'writev', 'ftruncate', 'fchmod', 'fchown', 'futimes', 'writeSync', 'writevSync', 'ftruncateSync', 'fchmodSync', 'fchownSync', 'futimesSync']) {
  const original = fs[api];
  fs[api] = (fd, ...args) => { if (![1, 2].includes(fd)) mutation(api, [fds.get(fd) ?? fd]); return original(fd, ...args); };
}
for (const api of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  cp[api] = () => { event({ kind: 'child-attempt', api }); throw new Error('Fuzz observer rejected child execution'); };
}
process.on('uncaughtExceptionMonitor', () => event({ kind: 'uncaught' }));
// Do not install unhandledRejection: that would change Node's crash semantics.
syncBuiltinESMExports();
event({ kind: 'ready' });
