import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readJson, readTextMetadata, MAX_METADATA_BYTES } from '../src/io.js';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'metadata-read-')));
  t.after(() => fs.rmSync(root, { recursive: true }));
  return { root, file: path.join(root, 'metadata.json') };
}

test('metadata reader preserves UTF-8, exact limits, missing JSON defaults and regular-file symlinks', (t) => {
  const { root, file } = fixture(t);
  assert.equal(readJson(file, 'missing'), 'missing');
  assert.throws(() => readTextMetadata(file), { code: 'ENOENT' });
  const value = { greeting: 'café 東京', enabled: false };
  fs.writeFileSync(file, JSON.stringify(value));
  assert.deepEqual(readJson(file), value);
  const link = path.join(root, 'link.json');
  try { fs.symlinkSync(file, link); assert.deepEqual(readJson(link), value); }
  catch (error) { if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) throw error; t.diagnostic('File symlink unavailable; regular-file cases still executed'); }
  fs.writeFileSync(file, ' '.repeat(MAX_METADATA_BYTES - 2) + '{}');
  assert.deepEqual(readJson(file), {});
  fs.appendFileSync(file, ' ');
  assert.throws(() => readJson(file), /exceeds.*1048576/);
  assert.throws(() => readTextMetadata(root), /regular file/);
});

test('malformed JSON errors identify the file but never include the input snippet', (t) => {
  const { file } = fixture(t);
  fs.writeFileSync(file, 'FUZZ_CANARY!');
  assert.throws(() => readJson(file), error => {
    assert(error.message.includes(file));
    assert.match(error.message, /Invalid JSON/);
    assert(!String(error.stack).includes('FUZZ_CANARY'));
    assert.equal(error.cause, undefined);
    return true;
  });
});

test('oversized metadata is rejected before any open or read', (t) => {
  const { file } = fixture(t);
  fs.writeFileSync(file, 'x'.repeat(MAX_METADATA_BYTES + 1));
  t.mock.method(fs, 'openSync', () => assert.fail('Oversized file must not be opened'));
  t.mock.method(fs, 'readSync', () => assert.fail('Oversized file must not be read'));
  assert.throws(() => readTextMetadata(file), /exceeds/);
});

test('opened non-regular replacements are rejected and their handle is closed', (t) => {
  const { file } = fixture(t);
  fs.writeFileSync(file, '{}');
  const originalOpen = fs.openSync.bind(fs), originalClose = fs.closeSync.bind(fs);
  let opened, closed;
  t.mock.method(fs, 'openSync', (name, flags) => {
    assert.equal(flags & fs.constants.O_WRONLY, 0);
    if (fs.constants.O_NONBLOCK) assert.equal(flags & fs.constants.O_NONBLOCK, fs.constants.O_NONBLOCK);
    return (opened = originalOpen(name, flags));
  });
  t.mock.method(fs, 'fstatSync', () => ({ isFile: () => false, size: 0 }));
  t.mock.method(fs, 'readSync', () => assert.fail('Special-file replacement must not be read'));
  t.mock.method(fs, 'closeSync', fd => { closed = fd; return originalClose(fd); });
  assert.throws(() => readTextMetadata(file), /regular file/);
  assert.equal(closed, opened);
});

test('growing or size-underreported input consumes at most limit plus one bytes', (t) => {
  const { file } = fixture(t);
  fs.writeFileSync(file, '{}');
  const close = fs.closeSync.bind(fs); let bytes = 0, closes = 0;
  t.mock.method(fs, 'readSync', (fd, buffer, offset, length) => {
    assert(length > 0);
    bytes += length; buffer.fill(0x20, offset, offset + length); return length;
  });
  t.mock.method(fs, 'closeSync', fd => { closes++; return close(fd); });
  assert.throws(() => readTextMetadata(file), /exceeds/);
  assert.equal(bytes, MAX_METADATA_BYTES + 1);
  assert.equal(closes, 1);
});

test('short reads and mid-read failures retain error attribution and close descriptors', (t) => {
  const { file } = fixture(t);
  fs.writeFileSync(file, '{"ok":true}');
  const read = fs.readSync.bind(fs), close = fs.closeSync.bind(fs); let closes = 0;
  t.mock.method(fs, 'readSync', (fd, buffer, offset, length, position) => read(fd, buffer, offset, Math.min(length, 1), position));
  t.mock.method(fs, 'closeSync', fd => { closes++; return close(fd); });
  assert.deepEqual(readJson(file), { ok: true });
  assert.equal(closes, 1);
  const ioError = Object.assign(new Error('fixture I/O failed'), { code: 'EIO' });
  t.mock.method(fs, 'readSync', () => { throw ioError; });
  assert.throws(() => readTextMetadata(file), error => error === ioError);
  assert.equal(closes, 2);
  assert.throws(() => readJson(file), /Cannot read.*fixture I\/O failed/);
  assert.equal(closes, 3);
});

test('POSIX regular-to-FIFO replacement at open cannot wait for a writer', (t) => {
  const mkfifo = ['/usr/bin/mkfifo', '/bin/mkfifo'].find(name => fs.existsSync(name));
  if (process.platform === 'win32' || !mkfifo) return t.skip('POSIX mkfifo required');
  const { root, file } = fixture(t);
  fs.writeFileSync(file, '{}');
  const script = `
    import fs from 'node:fs';
    import { spawnSync } from 'node:child_process';
    import { readTextMetadata } from ${JSON.stringify(new URL('../src/io.js', import.meta.url).href)};
    const file = ${JSON.stringify(file)}, open = fs.openSync;
    let replaced = false;
    fs.openSync = (name, flags, ...rest) => {
      if (name === file && !replaced) {
        replaced = true;
        fs.unlinkSync(file);
        const result = spawnSync(${JSON.stringify(mkfifo)}, [file], { timeout: 1000, killSignal: 'SIGKILL' });
        if (result.status !== 0) throw new Error('Cannot create disposable FIFO');
      }
      return open(name, flags, ...rest);
    };
    try { readTextMetadata(file); process.exitCode = 2; }
    catch (error) {
      if (!replaced || !/regular file/.test(error.message)) throw error;
      console.log('replacement rejected');
    }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), env: { HOME: root, PATH: '', TMPDIR: root },
    timeout: 3000, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 8192,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /replacement rejected/);
  assert(fs.lstatSync(file).isFIFO());
});

test('non-finite JSON numbers are rejected rather than later serialised to null', (t) => {
  const { file } = fixture(t);
  for (const text of ['{"x":1e999}', '{"x":[{"y":-1e999}]}', '1e999']) {
    fs.writeFileSync(file, text);
    assert.throws(() => readJson(file), /non-finite/);
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  }
  fs.writeFileSync(file, '{"x":1e308,"keep":"Infinity","null":null}');
  assert.deepEqual(readJson(file), { x: 1e308, keep: 'Infinity', null: null });
});

test('deep JSON nesting does not require a recursive validation walk', (t) => {
  const { file } = fixture(t), depth = 20000;
  fs.writeFileSync(file, '['.repeat(depth) + '1' + ']'.repeat(depth));
  let value = readJson(file), actual = 0;
  while (Array.isArray(value)) { value = value[0]; actual++; }
  assert.equal(actual, depth);
  assert.equal(value, 1);
});
