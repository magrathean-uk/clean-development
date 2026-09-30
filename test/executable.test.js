import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { resolveExecutable, runWithShims } from "../src/runtime.js";
import { explainCommand } from "../src/explain.js";
import { platformPaths, setEnvironmentValue } from "../src/platform.js";
import { isolatedEnvironment } from "../scripts/harness-utils.mjs";

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cd resolve & contract ")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = path.join(root, "first"), second = path.join(root, "second");
  fs.mkdirSync(first); fs.mkdirSync(second);
  const env = isolatedEnvironment(root); setEnvironmentValue(env, "PATH", [first, second].join(path.delimiter));
  return { root, first, second, env };
}
function candidate(directory, name = "tool", contents = "#!/bin/sh\nexit 0\n") {
  const file = path.join(directory, `${name}${process.platform === "win32" ? ".cmd" : ""}`);
  fs.writeFileSync(file, contents, { mode: 0o755 }); return file;
}
function replaceOpenedCandidate(file, replacement, retired, descriptor) {
  try {
    const original = fs.fstatSync(descriptor, { bigint: true });
    // NTFS can rename an open original but rejects replacing an existing open
    // destination. Vacate the name first while retaining the inspected handle.
    fs.renameSync(file, retired);
    fs.renameSync(replacement, file);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const published = fs.statSync(file, { bigint: true });
    assert.equal(opened.dev, original.dev);
    assert.equal(opened.ino, original.ino);
    assert.notEqual(published.ino, original.ino, "The pathname must refer to a real replacement");
  } catch (error) {
    // The mocked open has allocated a descriptor that its caller has not yet
    // received. It remains the fixture's responsibility if the swap throws.
    fs.closeSync(descriptor);
    throw error;
  }
}
function isolatedQuery(code, env) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    env, encoding: "utf8", timeout: 2000, killSignal: "SIGKILL", maxBuffer: 64 * 1024
  });
}
const moduleUrl = new URL("../src/executable.js", import.meta.url).href;

test("a directory in PATH cannot shadow a real executable or be opened for inspection", (t) => {
  const item = fixture(t), real = candidate(item.second);
  const directory = path.join(item.first, path.basename(real)); fs.mkdirSync(directory);
  const original = fs.openSync; let openedDirectory = false;
  t.mock.method(fs, "openSync", (file, ...args) => { if (file === directory) openedDirectory = true; return original(file, ...args); });
  assert.equal(resolveExecutable("tool", item.env), real); assert.equal(openedDirectory, false);
});

test("relative PATH entries and explicit paths resolve against the requested child cwd", (t) => {
  const item = fixture(t); const real = candidate(item.first);
  setEnvironmentValue(item.env, "PATH", "first");
  assert.equal(resolveExecutable("tool", item.env, null, item.root), real);
  assert.equal(resolveExecutable(path.join("first", path.basename(real)), item.env, null, item.root), real);
  setEnvironmentValue(item.env, "PATH", "."); assert.equal(resolveExecutable("tool", item.env, null, item.first), real);
  setEnvironmentValue(item.env, "PATH", path.delimiter); assert.equal(resolveExecutable("tool", item.env, null, item.first), null);
});

test("explain and execution agree on relative PATH without installing runtime state", async (t) => {
  const item = fixture(t), capture = path.join(item.root, "captured.json"), script = path.join(item.root, "capture.cjs");
  fs.writeFileSync(script, "require('node:fs').writeFileSync(process.env.CAPTURE,JSON.stringify({cwd:process.cwd(),argv:process.argv.slice(2)}));");
  const body = process.platform === "win32"
    ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
    : `#!${process.execPath}\nrequire(${JSON.stringify(script)});\n`;
  const command = candidate(item.first, "capture", body);
  setEnvironmentValue(item.env, "PATH", "first"); setEnvironmentValue(item.env, "CAPTURE", capture);
  setEnvironmentValue(item.env, "CLEAN_DEVELOPMENT_SESSION_MODE", "skip");
  const config = { locations: platformPaths(item.env) };
  const explanation = explainCommand("capture", [], { cwd: item.root, env: item.env, mode: "skip" });
  assert.equal(explanation.executable.path, command); assert.equal(explanation.executable.found, true);
  assert.equal(await runWithShims("capture", ["kept & literal"], { config, cwd: item.root, env: item.env }), 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(capture, "utf8")), { cwd: item.root, argv: ["kept & literal"] });
  assert.equal(fs.existsSync(config.locations.runtimeDir), false);
});

test("symlinked executable invocation keeps its original name while generated shims are skipped", (t) => {
  const item = fixture(t), real = candidate(item.second);
  const link = path.join(item.first, path.basename(real));
  try { fs.symlinkSync(real, link); }
  catch (error) { if (process.platform === "win32" && error.code === "EPERM") return t.skip("symlink privilege unavailable"); throw error; }
  assert.equal(resolveExecutable("tool", item.env), link, "proxy argv[0] must retain its tool name");
  fs.unlinkSync(link); candidate(item.first, "tool", "#!/bin/sh\n# clean-development-shim.js\n");
  assert.equal(resolveExecutable("tool", item.env), real);
});

test("excluded runtime directories and hard-linked copies remain excluded", (t) => {
  const item = fixture(t), excluded = path.join(item.root, "runtime-bin"); fs.mkdirSync(excluded);
  const owned = candidate(excluded), copied = path.join(item.first, path.basename(owned)); fs.linkSync(owned, copied);
  const real = candidate(item.second);
  setEnvironmentValue(item.env, "PATH", [excluded, item.first, item.second].join(path.delimiter));
  assert.equal(resolveExecutable("tool", item.env, excluded), real);
});

test("executable prefix reads stay bounded and every opened descriptor is closed", (t) => {
  const item = fixture(t), file = candidate(item.first); fs.truncateSync(file, 32 * 1024 * 1024);
  const read = fs.readSync, close = fs.closeSync; let bytes = 0, closed = 0;
  t.mock.method(fs, "readSync", (...args) => { const result = read(...args); bytes += result; return result; });
  t.mock.method(fs, "closeSync", (...args) => { closed += 1; return close(...args); });
  assert.equal(resolveExecutable("tool", item.env), file); assert.equal(bytes, 4096); assert.equal(closed, 1);
});

test("a file replaced after opening is skipped instead of being mistaken for the inspected executable", (t) => {
  const item = fixture(t), first = candidate(item.first), second = candidate(item.second);
  const replacement = path.join(item.root, "replacement"); fs.writeFileSync(replacement, "replacement", { mode: 0o755 });
  const retired = path.join(item.root, "retired-original");
  const open = fs.openSync; let swapped = false;
  t.mock.method(fs, "openSync", (file, ...args) => {
    const descriptor = open(file, ...args);
    if (file === first && !swapped) {
      replaceOpenedCandidate(first, replacement, retired, descriptor);
      swapped = true;
    }
    return descriptor;
  });
  assert.equal(resolveExecutable("tool", item.env), second);
  assert.equal(swapped, true, "The replacement must complete before the resolver rejects it");
});

test("execute-only regular files retain compatibility when prefix inspection is denied", (t) => {
  const item = fixture(t), first = candidate(item.first), original = fs.openSync;
  t.mock.method(fs, "openSync", (file, ...args) => {
    if (file === first) throw Object.assign(new Error("read denied"), { code: "EACCES" });
    return original(file, ...args);
  });
  assert.equal(resolveExecutable("tool", item.env), first);
});

test("a FIFO in PATH is rejected without a blocking open", { skip: process.platform === "win32" }, (t) => {
  const item = fixture(t), fifo = path.join(item.first, "tool"), real = candidate(item.second);
  const made = spawnSync("mkfifo", [fifo], { encoding: "utf8" }); assert.equal(made.status, 0, made.stderr); fs.chmodSync(fifo, 0o755);
  const result = isolatedQuery(`import {resolveExecutable} from ${JSON.stringify(moduleUrl)};console.log(JSON.stringify(resolveExecutable('tool',process.env)));`, item.env);
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout), real);
});

test("a regular file swapped to FIFO between stat and open does not hang", { skip: process.platform === "win32" }, (t) => {
  const item = fixture(t), target = candidate(item.first), real = candidate(item.second), fifo = path.join(item.root, "fifo");
  const made = spawnSync("mkfifo", [fifo], { encoding: "utf8" }); assert.equal(made.status, 0, made.stderr); fs.chmodSync(fifo, 0o755);
  const code = `import fs from 'node:fs';import {resolveExecutable} from ${JSON.stringify(moduleUrl)};
const open=fs.openSync;let swapped=false;fs.openSync=(file,...args)=>{if(file===${JSON.stringify(target)}&&!swapped){swapped=true;fs.renameSync(${JSON.stringify(fifo)},file);}return open(file,...args);};
console.log(JSON.stringify(resolveExecutable('tool',process.env)));`;
  const result = isolatedQuery(code, item.env); assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout), real);
});

test("a handle that is no longer a regular file is never read", (t) => {
  const item = fixture(t), first = candidate(item.first), second = candidate(item.second);
  const open = fs.openSync, fstat = fs.fstatSync, read = fs.readSync; let unwanted, readSpecialFile = false;
  t.mock.method(fs, "openSync", (file, ...args) => { const fd = open(file, ...args); if (file === first) unwanted = fd; else unwanted = undefined; return fd; });
  t.mock.method(fs, "fstatSync", (fd, ...args) => { const stat = fstat(fd, ...args); if (fd === unwanted) stat.isFile = () => false; return stat; });
  t.mock.method(fs, "readSync", (fd, ...args) => { if (fd === unwanted) readSpecialFile = true; return read(fd, ...args); });
  assert.equal(resolveExecutable("tool", item.env), second);
  assert.equal(readSpecialFile, false);
});


test("a rejected replacement is not retried through duplicate PATH components", (t) => {
  const item = fixture(t), first = candidate(item.first), second = candidate(item.second);
  setEnvironmentValue(item.env, "PATH", [item.first, item.first, item.second].join(path.delimiter));
  const replacement = path.join(item.root, "replacement"); fs.writeFileSync(replacement, "changed", { mode: 0o755 });
  const retired = path.join(item.root, "retired-original");
  const open = fs.openSync; let count = 0, swapped = false;
  t.mock.method(fs, "openSync", (file, ...args) => {
    const descriptor = open(file, ...args);
    if (file === first && ++count === 1) {
      replaceOpenedCandidate(first, replacement, retired, descriptor);
      swapped = true;
    }
    return descriptor;
  });
  assert.equal(resolveExecutable("tool", item.env), second);
  assert.equal(swapped, true, "The replacement must complete before duplicate-path rejection");
  assert.equal(count, 1);
});

test("a rejected inode cannot be accepted through another hard-linked PATH name", (t) => {
  const item = fixture(t), first = candidate(item.first);
  const third = path.join(item.root, "third"); fs.mkdirSync(third);
  const second = path.join(item.second, path.basename(first)); fs.linkSync(first, second);
  const real = candidate(third);
  setEnvironmentValue(item.env, "PATH", [item.first, item.second, third].join(path.delimiter));
  const open = fs.openSync, read = fs.readSync; let rejectedDescriptor, aliasOpened = false;
  t.mock.method(fs, "openSync", (file, ...args) => {
    const fd = open(file, ...args);
    if (file === first) rejectedDescriptor = fd; else rejectedDescriptor = undefined;
    if (file === second) aliasOpened = true;
    return fd;
  });
  t.mock.method(fs, "readSync", (fd, ...args) => {
    if (fd === rejectedDescriptor) throw Object.assign(new Error("inspection failed"), { code: "EIO" });
    return read(fd, ...args);
  });
  assert.equal(resolveExecutable("tool", item.env), real);
  assert.equal(aliasOpened, false);
});
