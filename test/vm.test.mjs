import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import childProcess, { spawn, spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { sim, mk } from "./helpers.mjs";
import { loadConf } from "../runtime/lib/conf.mjs";
import { VM_TOOLS, vmHome, sparseCopyFile, vmRunning, vmMove, colimaRehome, colimaRehomeRollback, limaDiskNames, parseLimaList, setLimaReaderForTests, READ_ONLY_PROFILE } from "../runtime/lib/vm.mjs";
import { cli, plugin } from "./helpers.mjs";
import { doctor } from "../runtime/lib/doctor.mjs";

function fixture(t, options) {
  const s = sim(options);
  t.after(() => fs.rmSync(s.root, { recursive: true, force: true }));
  const conf = loadConf(s.env);
  assert.equal(conf.valid, true, conf.errors.join("; "));
  return { ...s, conf };
}
function marker(source, tool = "lima") {
  fs.mkdirSync(path.join(source, { lima: "_config", colima: "_lima", tart: "vms" }[tool]), { recursive: true });
}
function hash(p) {
  const h = createHash("sha256"), buf = Buffer.alloc(4 * 1024 * 1024), fd = fs.openSync(p, "r");
  try { let n; while ((n = fs.readSync(fd, buf, 0, buf.length, null))) h.update(buf.subarray(0, n)); }
  finally { fs.closeSync(fd); }
  return h.digest("hex");
}
function snapshot(root) {
  const rows = [];
  const walk = (p) => {
    const st = fs.lstatSync(p);
    rows.push([path.relative(root, p), st.mode, st.size, st.mtimeMs, st.ino,
      st.isFile() ? fs.readFileSync(p).toString("hex") : st.isSymbolicLink() ? fs.readlinkSync(p) : null]);
    if (st.isDirectory()) for (const name of fs.readdirSync(p).sort()) walk(path.join(p, name));
  };
  walk(root); return rows;
}
function mockPs(t, response) {
  const original = childProcess.spawnSync;
  t.mock.method(childProcess, "spawnSync", (cmd, args, options) => cmd === "/bin/ps" ? response(args, options) : original(cmd, args, options));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

test("VM home API and sparse copy preserve bytes, permissions and mtime without overwriting", (t) => {
  const s = fixture(t);
  assert.deepEqual(VM_TOOLS, {
    colima: { env: "COLIMA_HOME", home: "colima-home", legacy: ["~/.colima"] },
    lima: { env: "LIMA_HOME", home: "lima-home", legacy: ["~/.lima"] },
    tart: { env: "TART_HOME", home: "tart-home", legacy: ["~/.tart"] }
  });
  assert.equal(vmHome(s.conf, "colima"), path.join(s.conf.labRoot, "VM", "colima-home"));
  assert.throws(() => vmHome(s.conf, "constructor"), /unknown VM tool/);
  const src = mk(path.join(s.root, "image"), Buffer.concat([Buffer.alloc(4096), Buffer.from("tail")]));
  fs.chmodSync(src, 0o640); fs.utimesSync(src, 1234567890.123456, 1234567890.123456);
  const dst = path.join(s.root, "copy"), result = sparseCopyFile(src, dst, { blockSize: 1024 });
  assert.equal(result.bytes, 4100);
  assert.equal(result.allocatedBytes, fs.statSync(dst).blocks * 512);
  assert.equal(hash(src), hash(dst));
  assert.equal(fs.statSync(dst).mode & 0o777, 0o640);
  assert.ok(Math.abs(fs.statSync(dst).mtimeMs - fs.statSync(src).mtimeMs) < 0.002);
  assert.throws(() => sparseCopyFile(src, dst), /EEXIST/);
  assert.equal(hash(src), hash(dst));
  assert.throws(() => sparseCopyFile(src, path.join(s.root, "bad"), { blockSize: 0 }), /blockSize/);
  fs.symlinkSync(src, path.join(s.root, "link"));
  assert.throws(() => sparseCopyFile(path.join(s.root, "link"), path.join(s.root, "bad")));
});

test("10 GiB sparse image with 200 MiB data stays below 250 MiB allocated", { timeout: 180000 }, (t) => {
  const s = fixture(t), probe = path.join(s.root, "sparse-probe");
  let fd = fs.openSync(probe, "wx");
  fs.ftruncateSync(fd, 1024 ** 3); fs.closeSync(fd);
  const sparse = fs.statSync(probe).blocks * 512 < 1024 * 1024;
  fs.unlinkSync(probe);
  if (!sparse) { t.skip("fixture filesystem does not report sparse allocation for a 1 GiB ftruncate file"); return; }
  const src = path.join(s.root, "image"), dst = path.join(s.root, "copy"), block = Buffer.alloc(1024 * 1024, 0xa5);
  fd = fs.openSync(src, "wx");
  try {
    fs.ftruncateSync(fd, 10 * 1024 ** 3);
    for (let i = 0; i < 200; i++) fs.writeSync(fd, block, 0, block.length, (i < 100 ? i : 5 * 1024 + i) * block.length);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  const result = sparseCopyFile(src, dst);
  assert.equal(result.bytes, 10 * 1024 ** 3);
  assert.ok(result.allocatedBytes <= 250 * 1024 ** 2, `allocated ${result.allocatedBytes} bytes`);
  t.diagnostic(`10 GiB copy allocated ${result.allocatedBytes} bytes`);
  assert.equal(hash(src), hash(dst));
});

test("live VM pid refuses a move; a dead pid permits a read-only preview", async (t) => {
  const s = fixture(t), source = path.join(s.home, ".colima");
  mk(path.join(source, "disk"), "VM image"); marker(source, "colima");
  const child = spawn("/bin/sleep", ["30"], { env: s.env, stdio: "ignore" });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await once(child, "spawn");
  mk(path.join(source, "_lima", "profile", "ha.pid"), String(child.pid));
  const live = vmRunning("colima", source, s.env);
  assert.notEqual(live.running, false);
  if (live.running === null) t.diagnostic("host ps inspection unavailable; live process is conservatively refused as unknown; start-time branches use fixture ps responses");
  assert.throws(() => vmMove(s.conf, s.env, "colima"), /running/);
  child.kill(); await once(child, "exit");
  assert.equal(vmRunning("colima", source, s.env).running, false);
  const before = snapshot(s.root);
  const result = vmMove(s.conf, s.env, "colima");
  assert.equal(result.status, "preview"); assert.equal(result.fileCount, 2);
  assert.deepEqual(snapshot(s.root), before);
});

test("pid reuse, inspection failures and invalid pid files are handled conservatively", (t) => {
  const s = fixture(t), source = path.join(s.home, ".lima");
  let response = { status: 0, stdout: new Date(Date.now() - 60000).toUTCString().replace(/ GMT$/, "") };
  mockPs(t, (args, options) => {
    assert.equal(options.timeout, 2000); assert.equal(options.env.LC_ALL, "C");
    return response;
  });
  const pid = mk(path.join(source, "instance", "ha.pid"), String(process.pid)); marker(source);
  assert.equal(vmRunning("lima", source, s.env).running, true);
  fs.utimesSync(pid, 1, 1);
  assert.equal(vmRunning("lima", source, s.env).running, false);
  response = { status: null, error: Object.assign(new Error("ps denied"), { code: "EPERM" }) };
  assert.equal(vmRunning("lima", source, s.env).running, null);
  fs.writeFileSync(pid, "not a pid");
  assert.equal(vmRunning("lima", source, s.env).running, null);
  assert.throws(() => vmMove(s.conf, s.env, "lima"), /state is unknown/);
  fs.unlinkSync(pid);
  assert.equal(vmRunning("lima", path.join(s.root, "missing"), s.env).running, null);
  const readdir = fs.readdirSync;
  t.mock.method(fs, "readdirSync", (p, ...args) => {
    if (p === source) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return readdir(p, ...args);
  });
  assert.equal(vmRunning("lima", source, s.env).running, null);
});

test("incomplete inspection stays unknown even with a readable live pid", (t) => {
  const s = fixture(t), source = path.join(s.home, ".lima"), denied = path.join(source, "a-denied");
  fs.mkdirSync(denied, { recursive: true }); mk(path.join(source, "live.pid"), String(process.pid));
  mockPs(t, () => ({ status: 0, stdout: new Date(Date.now() - 60000).toUTCString().replace(/ GMT$/, "") }));
  const readdir = fs.readdirSync;
  t.mock.method(fs, "readdirSync", (p, ...args) => {
    if (p === denied) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return readdir(p, ...args);
  });
  const result = vmRunning("lima", source, s.env);
  assert.equal(result.running, null);
  assert.ok(result.evidence.some((e) => e.status === "unknown"));
});

test("pid inspection refuses unknown state beyond its depth limit", (t) => {
  const s = fixture(t), source = path.join(s.home, ".lima");
  const included = mk(path.join(source, "a", "b", "c", "ha.pid"), String(process.pid));
  mk(path.join(source, "a", "b", "c", "d", "ha.pid"), "invalid pid beyond depth four");
  marker(source);
  mockPs(t, () => ({ status: 0, stdout: new Date(Date.now() - 60000).toUTCString().replace(/ GMT$/, "") }));
  assert.equal(vmRunning("lima", source, s.env).running, null);
  fs.unlinkSync(included);
  const before = snapshot(s.root), result = vmRunning("lima", source, s.env);
  assert.equal(result.running, null);
  assert.ok(result.evidence.some((e) => /depth/.test(e.reason)));
  assert.throws(() => vmMove(s.conf, s.env, "lima", { apply: true, experimental: true }), /state is unknown/);
  assert.deepEqual(snapshot(s.root), before);
});

test("tart run process inspection detects a live process and fails closed on errors", (t) => {
  const s = fixture(t), source = path.join(s.home, ".tart"); fs.mkdirSync(source);
  let response = { status: 0, stdout: `${process.pid} /opt/homebrew/bin/tart run fixture\n` };
  mockPs(t, () => response);
  assert.equal(vmRunning("tart", source, s.env).running, true);
  response = { status: 0, stdout: `${process.pid} /bin/sh -c tart run fixture\n` };
  assert.equal(vmRunning("tart", source, s.env).running, false);
  response = { status: null, error: new Error("timeout") };
  assert.equal(vmRunning("tart", source, s.env).running, null);
});

test("preview is write-free; experimental apply copies, links and parks the original with a manifest", (t) => {
  const s = fixture(t), source = path.join(s.home, ".lima"), destination = vmHome(s.conf, "lima");
  mk(path.join(source, "instance", "disk"), "image bytes"); marker(source);
  mk(path.join(source, "empty"), "");
  fs.chmodSync(path.join(source, "instance"), 0o750);
  fs.symlinkSync("instance/disk", path.join(source, "disk-link"));
  const before = snapshot(s.root), plan = vmMove(s.conf, s.env, "lima");
  assert.equal(plan.source, source); assert.equal(plan.destination, destination);
  assert.equal(plan.fileCount, 2); assert.equal(plan.apparentBytes, 11);
  assert.equal(plan.allocatedBytes, fs.statSync(path.join(source, "instance", "disk")).blocks * 512);
  assert.deepEqual(snapshot(s.root), before);
  assert.throws(() => vmMove(s.conf, s.env, "lima", { apply: true }), /vm move is experimental; pass --experimental --apply/);
  assert.deepEqual(snapshot(s.root), before);
  const result = vmMove(s.conf, s.env, "lima", { apply: true, experimental: true });
  assert.equal(result.status, "moved"); assert.equal(result.linked, true);
  assert.equal(fs.readlinkSync(source), destination);
  assert.equal(fs.readFileSync(path.join(destination, "instance", "disk"), "utf8"), "image bytes");
  assert.equal(fs.statSync(path.join(destination, "instance")).mode & 0o777, 0o750);
  assert.equal(fs.readlinkSync(path.join(destination, "disk-link")), "instance/disk");
  assert.match(result.trash, new RegExp(`/\\.Trash/lima-home-\\d{8}-\\d{6}$`));
  assert.equal(fs.readFileSync(path.join(result.original, "instance", "disk"), "utf8"), "image bytes");
  const manifest = fs.readFileSync(path.join(result.trash, "MANIFEST.txt"), "utf8").trim().split("\n").map((line) => line.split("\t"));
  assert.deepEqual(manifest.map(([rel, size]) => [JSON.parse(rel), Number(size)]), [["empty", 0], ["instance/disk", 11]]);
  assert.equal(manifest[1][2], hash(path.join(result.original, "instance", "disk")));
});

test("non-empty or linked destinations, linked sources, missing volumes and overlaps refuse without writes", (t) => {
  const s = fixture(t), source = path.join(s.home, ".colima"), destination = vmHome(s.conf, "colima");
  mk(path.join(source, "disk")); marker(source, "colima"); mk(path.join(destination, "existing"));
  let before = snapshot(s.root);
  assert.throws(() => vmMove(s.conf, s.env, "colima"), /not an empty real directory/);
  assert.deepEqual(snapshot(s.root), before);
  fs.rmSync(destination, { recursive: true });
  fs.symlinkSync(source, destination);
  assert.throws(() => vmMove(s.conf, s.env, "colima"), /redirected/);
  fs.unlinkSync(destination);
  fs.symlinkSync(source, path.join(s.root, "linked-source"));
  assert.throws(() => vmMove(s.conf, s.env, "colima", { from: path.join(s.root, "linked-source") }), /real directory/);
  before = snapshot(s.root);
  assert.throws(() => vmMove(s.conf, { ...s.env, DEV_STORAGE_VOLUME_TEST: "absent" }, "colima"), /not mounted/);
  assert.throws(() => vmMove(s.conf, s.env, "colima", { from: s.vol }), /overlap/);
  assert.throws(() => vmMove(s.conf, s.env, "unknown"), /unknown VM tool/);
  assert.deepEqual(snapshot(s.root), before);
});

test("empty existing destination is allowed; sockets are skipped and listed, FIFOs refuse", (t) => {
  const s = fixture(t), source = path.join(s.home, ".lima"), destination = vmHome(s.conf, "lima");
  mk(path.join(source, "disk")); marker(source); fs.mkdirSync(destination, { recursive: true });
  const socket = mk(path.join(source, "control.sock")), lstat = fs.lstatSync;
  t.diagnostic("socket metadata is simulated; this sandbox denies Unix-socket creation");
  t.mock.method(fs, "lstatSync", (p, ...args) => {
    const st = lstat(p, ...args);
    return p === socket ? Object.assign(Object.create(st), { isFile: () => false, isSocket: () => true }) : st;
  });
  const result = vmMove(s.conf, s.env, "lima", { apply: true, experimental: true });
  assert.deepEqual(result.skippedSockets, ["control.sock"]);
  assert.equal(fs.existsSync(path.join(destination, "control.sock")), false);
  t.mock.restoreAll();
  const other = path.join(s.root, "fifo-home"); marker(other, "colima");
  const r = spawnSync("/usr/bin/mkfifo", [path.join(other, "pipe")], { env: s.env });
  assert.equal(r.status, 0);
  assert.throws(() => vmMove(s.conf, s.env, "colima", { from: other }), /unsupported special file/);
});

test("copy or hash failure removes only the partial tree and retains the source", (t) => {
  const s = fixture(t), source = path.join(s.home, ".lima"), destination = vmHome(s.conf, "lima");
  mk(path.join(source, "disk")); marker(source);
  const before = snapshot(source), write = fs.writeSync;
  t.mock.method(fs, "writeSync", () => { throw new Error("injected copy failure"); });
  assert.throws(() => vmMove(s.conf, s.env, "lima", { apply: true, experimental: true }), /injected copy failure/);
  t.mock.restoreAll();
  assert.deepEqual(snapshot(source), before); assert.equal(fs.existsSync(destination), false);
  assert.deepEqual(fs.readdirSync(path.dirname(destination)), []);
  const read = fs.readSync;
  let corrupted = false;
  t.mock.method(fs, "readSync", (fd, buf, ...args) => {
    const n = read(fd, buf, ...args);
    if (!corrupted && n > 0) { buf[0] ^= 255; corrupted = true; }
    return n;
  });
  assert.throws(() => vmMove(s.conf, s.env, "lima", { apply: true, experimental: true }), /sha256 mismatch/);
  t.mock.restoreAll();
  assert.deepEqual(snapshot(source), before); assert.deepEqual(fs.readdirSync(path.dirname(destination)), []);
  assert.equal(fs.writeSync, write);
});

test("EXDEV leaves the original in place and reports manual Trash handling", (t) => {
  const s = fixture(t), source = path.join(s.home, ".colima");
  mk(path.join(source, "disk")); marker(source, "colima");
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (from === source) throw Object.assign(new Error("cross-device rename"), { code: "EXDEV" });
    return rename(from, to);
  });
  const result = vmMove(s.conf, s.env, "colima", { apply: true, experimental: true });
  t.mock.restoreAll();
  assert.equal(result.status, "original-retained"); assert.equal(result.linked, false);
  assert.equal(result.message, "original retained; move it to Trash yourself");
  assert.equal(fs.lstatSync(source).isDirectory(), true);
  assert.equal(hash(path.join(source, "disk")), hash(path.join(result.destination, "disk")));
  assert.ok(fs.existsSync(path.join(result.trash, "MANIFEST.txt")));
});

test("insufficient free space refuses before creating the destination", (t) => {
  const s = fixture(t), source = path.join(s.home, ".colima"); mk(path.join(source, "disk")); marker(source, "colima");
  t.mock.method(fs, "statfsSync", () => ({ bavail: 0, bsize: 4096 }));
  const before = snapshot(s.root);
  assert.throws(() => vmMove(s.conf, s.env, "colima"), /insufficient free space/);
  assert.deepEqual(snapshot(s.root), before);
  t.mock.restoreAll();
});


test("entry cap and deadline make pid inspection unknown and remain write-free", (t) => {
  const s = fixture(t), source = path.join(s.home, ".lima");
  marker(source); mk(path.join(source, "a")); mk(path.join(source, "z.pid"), String(process.pid));
  const before = snapshot(s.root);
  const capped = vmRunning("lima", source, s.env, { maxEntries: 1 });
  assert.equal(capped.running, null);
  assert.ok(capped.evidence.some((e) => /entry/.test(e.reason)));
  const expired = vmRunning("lima", source, s.env, { deadline: 0 });
  assert.equal(expired.running, null);
  assert.ok(expired.evidence.some((e) => /deadline/.test(e.reason)));
  assert.deepEqual(snapshot(s.root), before);
});

test("protected sources are refused before writes even when they hold tool markers", (t) => {
  const s = fixture(t);
  s.conf.DEV_TOP_ALLOW = new Set(["machine", "source", "shared", "projects"]);
  mockPs(t, () => ({ status: 0, stdout: "" }));
  for (const rel of ["dev/source", "dev/shared", "dev/projects", "dev/machine/state"]) {
    const source = path.join(s.home, rel); marker(source, "tart");
    const nested = path.join(source, "project"); marker(nested, "tart");
    const alias = path.join(s.root, "alias"); fs.symlinkSync(source, alias);
    for (const from of [source, nested, path.join(alias, "project")]) {
      const before = snapshot(s.root);
      assert.throws(() => vmMove(s.conf, s.env, "tart", { from, apply: true, experimental: true }), /protected VM source/);
      assert.deepEqual(snapshot(s.root), before);
    }
    fs.unlinkSync(alias);
  }
  // An ancestor of protected trees (a small ~/dev that happens to hold vms/) is refused too (review round 2).
  marker(path.join(s.home, "dev"), "tart");
  { const before = snapshot(s.root);
    assert.throws(() => vmMove(s.conf, s.env, "tart", { from: path.join(s.home, "dev"), apply: true, experimental: true }), /protected VM source/);
    assert.deepEqual(snapshot(s.root), before); }
  marker(s.home, "tart");
  for (const from of [s.home, path.parse(s.home).root]) {
    const before = snapshot(s.root);
    assert.throws(() => vmMove(s.conf, s.env, "tart", { from, apply: true, experimental: true }), /protected VM source/);
    assert.deepEqual(snapshot(s.root), before);
  }
});

test("each tool requires its own real markers and accepts recognised layouts", (t) => {
  const s = fixture(t);
  mockPs(t, () => ({ status: 0, stdout: "" }));
  for (const tool of ["tart", "lima", "colima"]) {
    const source = path.join(s.home, `.${tool}`); mk(path.join(source, "unrelated"));
    const before = snapshot(s.root);
    assert.throws(() => vmMove(s.conf, s.env, tool), /tool markers/);
    assert.deepEqual(snapshot(s.root), before);
    marker(source, tool);
    assert.equal(vmMove(s.conf, s.env, tool).status, "preview");
    const name = { tart: "vms", lima: "_config", colima: "_lima" }[tool];
    fs.rmdirSync(path.join(source, name));
    fs.symlinkSync(s.root, path.join(source, name));
    assert.throws(() => vmMove(s.conf, s.env, tool), /tool markers/);
    fs.unlinkSync(path.join(source, name));
    if (tool !== "tart") {
      mk(path.join(source, "profile", `${tool}.yaml`), "{}");
      assert.equal(vmMove(s.conf, s.env, tool).status, "preview");
    }
  }
});

test("a legacy parent link into the lab permits its real VM child", (t) => {
  const s = fixture(t), legacy = path.join(s.home, "dev/machine/state/colima"), target = path.join(s.conf.labRoot, "legacy");
  const source = path.join(target, "old-home"); marker(source, "colima");
  fs.mkdirSync(path.dirname(legacy), { recursive: true }); fs.symlinkSync(target, legacy);
  const before = snapshot(s.root);
  assert.equal(vmMove(s.conf, s.env, "colima", { from: path.join(legacy, "old-home") }).status, "preview");
  assert.deepEqual(snapshot(s.root), before);
});

test("fragmented 1 GiB sparse image copies 4 KiB per MiB below 64 MiB allocated", { timeout: 120000 }, (t) => {
  const s = fixture(t), src = path.join(s.root, "fragmented"), dst = path.join(s.root, "copy");
  const fd = fs.openSync(src, "wx"), size = 1024 ** 3, block = Buffer.alloc(4096, 0x5a);
  try {
    fs.ftruncateSync(fd, size);
    if (fs.fstatSync(fd).blocks * 512 >= 1024 * 1024) {
      t.skip("fixture filesystem does not report sparse allocation for a 1 GiB ftruncate file"); return;
    }
    for (let pos = 0; pos < size; pos += 1024 * 1024) fs.writeSync(fd, block, 0, block.length, pos);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  const result = sparseCopyFile(src, dst);
  assert.equal(result.bytes, size);
  assert.ok(result.allocatedBytes < 64 * 1024 ** 2, `allocated ${result.allocatedBytes} bytes`);
  t.diagnostic(`fragmented 1 GiB copy allocated ${result.allocatedBytes} bytes`);
  assert.equal(hash(src), hash(dst));
});

test("link-back failure restores the original and keeps the destination and Trash manifest", (t) => {
  const s = fixture(t), source = path.join(s.home, ".lima"), destination = vmHome(s.conf, "lima");
  marker(source); const disk = mk(path.join(source, "disk"), "original VM bytes"), before = snapshot(source);
  const inode = fs.statSync(disk).ino, symlink = fs.symlinkSync;
  t.mock.method(fs, "symlinkSync", (target, link, ...args) => {
    if (link === source) throw Object.assign(new Error("injected link-back failure"), { code: "EPERM" });
    return symlink(target, link, ...args);
  });
  assert.throws(() => vmMove(s.conf, s.env, "lima", { apply: true, experimental: true }), (e) => {
    assert.match(e.message, /injected link-back failure; original restored; destination copy kept at /);
    assert.ok(e.message.includes(destination)); return true;
  });
  assert.deepEqual(snapshot(source), before);
  assert.equal(fs.statSync(path.join(source, "disk")).ino, inode);
  assert.equal(hash(path.join(source, "disk")), hash(path.join(destination, "disk")));
  const trash = path.join(s.home, ".Trash"), parked = fs.readdirSync(trash);
  assert.equal(parked.length, 1);
  assert.deepEqual(fs.readdirSync(path.join(trash, parked[0])), ["MANIFEST.txt"]);
});

test("sparse copy coalesces adjacent non-zero 4 KiB runs and preserves a partial tail", (t) => {
  const s = fixture(t), src = mk(path.join(s.root, "runs"), Buffer.concat([
    Buffer.alloc(4096), Buffer.alloc(8192, 0xa5), Buffer.alloc(4096), Buffer.alloc(4096, 0x5a), Buffer.from("tail")
  ])), dst = path.join(s.root, "copy"), writes = [], write = fs.writeSync;
  t.mock.method(fs, "writeSync", (fd, buf, offset, length, position) => {
    writes.push([position, length]); return write(fd, buf, offset, length, position);
  });
  sparseCopyFile(src, dst);
  assert.deepEqual(writes, [[4096, 8192], [16384, 4100]]);
  assert.equal(hash(src), hash(dst));
});

test("link-back collision preserves the new entry, parked original and destination", (t) => {
  const s = fixture(t), source = path.join(s.home, ".lima"), destination = vmHome(s.conf, "lima");
  marker(source); mk(path.join(source, "disk"), "VM bytes");
  const symlink = fs.symlinkSync;
  t.mock.method(fs, "symlinkSync", (target, link, ...args) => {
    if (link === source) mk(source, "concurrent file");
    return symlink(target, link, ...args);
  });
  assert.throws(() => vmMove(s.conf, s.env, "lima", { apply: true, experimental: true }), /original restoration failed: source path is occupied/);
  assert.equal(fs.readFileSync(source, "utf8"), "concurrent file");
  const trash = path.join(s.home, ".Trash"), parked = path.join(trash, fs.readdirSync(trash)[0]);
  assert.equal(fs.readFileSync(path.join(parked, ".lima", "disk"), "utf8"), "VM bytes");
  assert.equal(fs.readFileSync(path.join(destination, "disk"), "utf8"), "VM bytes");
  assert.ok(fs.existsSync(path.join(parked, "MANIFEST.txt")));
});

test("a default inspection entry cap refuses vmMove without writes", (t) => {
  const s = fixture(t), source = path.join(s.home, ".lima"); marker(source);
  const before = snapshot(s.root), readdir = fs.readdirSync;
  t.mock.method(fs, "readdirSync", (p, ...args) => p === source ? Array(10001).fill("unknown") : readdir(p, ...args));
  assert.throws(() => vmMove(s.conf, s.env, "lima", { apply: true, experimental: true }), /inspection entry cap exceeded/);
  t.mock.restoreAll();
  assert.deepEqual(snapshot(s.root), before);
});

test("deadline reached during inspection refuses vmMove without writes", (t) => {
  const s = fixture(t), source = path.join(s.home, ".lima"); marker(source);
  const before = snapshot(s.root), readdir = fs.readdirSync;
  let clock = 1000;
  t.mock.method(Date, "now", () => clock);
  t.mock.method(fs, "readdirSync", (p, ...args) => {
    const names = readdir(p, ...args); if (p === source) clock += 5001; return names;
  });
  assert.throws(() => vmMove(s.conf, s.env, "lima", { apply: true, experimental: true }), /inspection deadline exceeded/);
  t.mock.restoreAll();
  assert.deepEqual(snapshot(s.root), before);
});

test("Darwin hole-reclamation failure removes only the incomplete copy", { skip: process.platform !== "darwin" }, (t) => {
  const s = fixture(t), src = mk(path.join(s.root, "holes"), Buffer.concat([Buffer.alloc(4096), Buffer.from("tail")]));
  const before = snapshot(src), names = fs.readdirSync(s.root), dst = path.join(s.root, "copy"), spawn = childProcess.spawnSync;
  t.mock.method(childProcess, "spawnSync", (cmd, ...args) => cmd === "/usr/bin/perl"
    ? { status: 1, stderr: "injected punch failure" } : spawn(cmd, ...args));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.throws(() => sparseCopyFile(src, dst), /cannot reclaim sparse holes: injected punch failure/);
  assert.deepEqual(snapshot(src), before);
  assert.deepEqual(fs.readdirSync(s.root), names);
});

// ---- 0.6.2 Colima home: shim and rehome of instances Colima created in lima-home while it followed env.zsh's LIMA_HOME.
const KEY_A = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA lima";
const KEY_B = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB lima";
// The rehome refuses while any colima or limactl process runs on the host; hide the host's own VMs from the fixtures.
const HOST_VM = /(?:^|\/)(?:colima|limactl)(?:\s|$)/;
function hideHostVms(t, extra = "") {
  const original = childProcess.spawnSync;
  t.mock.method(childProcess, "spawnSync", (cmd, args, options) => {
    const r = original(cmd, args, options);
    if (cmd !== "/bin/ps" || args.join(" ") !== "-axo pid=,args=" || typeof r.stdout !== "string") return r;
    return { ...r, stdout: r.stdout.split("\n").filter((l) => !HOST_VM.test(l.replace(/^\s*\d+\s+/, ""))).join("\n") + extra };
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}
// Stands in for Lima's reading of an instance: stopped, with one data disk named like the instance (plus `extra`).
function fakeLima(t, { status = "Stopped", extra = [], missing = false } = {}) {
  setLimaReaderForTests(missing ? () => null : (name) => ({ status, disks: [name, ...extra] }));
  t.after(() => setLimaReaderForTests(null));
}
function colimaLab(t) {
  hideHostVms(t);
  const s = fixture(t);
  fakeLima(t);
  const lima = vmHome(s.conf, "lima"), colima = vmHome(s.conf, "colima");
  mk(path.join(lima, "_config", "user.pub"), `${KEY_A}\n`);
  mk(path.join(colima, "_lima", "_config", "user.pub"), `${KEY_B}\n`);
  mk(path.join(colima, "_lima", "colima", "lima.yaml"), "disk: 20GiB\n");
  mk(path.join(colima, "sample-vm", "colima.yaml"), "cpu: 2\n");
  const inst = path.join(lima, "colima-sample-vm");
  mk(path.join(inst, "lima.yaml"), "disk: 20GiB\nadditionalDisks:\n    - name: colima-sample-vm\n      format: false\n      fsType: ext4\nmounts:\n  - location: /x\n");
  mk(path.join(inst, "disk"), "root disk");
  mk(path.join(lima, "_disks", "colima-sample-vm", "datadisk"), "data disk");
  mk(path.join(lima, "fedora44-agent", "lima.yaml"), "disk: 10GiB\n");
  return { ...s, lima, colima, inst };
}

test("colima shim pins LIMA_HOME to $COLIMA_HOME/_lima and fails fast when external storage is unavailable", (t) => {
  const s = fixture(t);
  const colimaHome = vmHome(s.conf, "colima"), out = path.join(s.root, "colima-call");
  fs.mkdirSync(path.dirname(colimaHome), { recursive: true });
  const fake = mk(path.join(s.root, "brew", "colima"), `#!/bin/sh\nprintf '%s|%s\\n' "$LIMA_HOME" "$*" > ${JSON.stringify(out)}\n`);
  fs.chmodSync(fake, 0o755);
  const shim = path.join(plugin, "machine", "colima");
  const run = (env) => spawnSync("/bin/sh", [shim, "start", "-p", "sample-vm"], { env: { PATH: "/usr/bin:/bin", ...env }, encoding: "utf8" });
  const base = { COLIMA_HOME: colimaHome, LIMA_HOME: vmHome(s.conf, "lima"), DEV_STORAGE_VOLUME_TEST: "mounted", CLEAN_DEV_COLIMA: fake };
  const r = run(base);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(out, "utf8"), `${colimaHome}/_lima|start -p sample-vm\n`);
  assert.equal(run({ ...base, COLIMA_HOME: "" }).status, 78);
  const absent = run({ ...base, COLIMA_HOME: path.join(s.root, "Volumes", "missing", "VM", "colima-home") });
  assert.equal(absent.status, 78); assert.match(absent.stderr, /configured VM storage/);
  const self = mk(path.join(s.root, "selfbin", "colima"), fs.readFileSync(shim)); fs.chmodSync(self, 0o755);
  assert.equal(spawnSync("/bin/sh", [self, "list"], { env: { PATH: "/usr/bin:/bin", ...base, CLEAN_DEV_COLIMA: self }, encoding: "utf8" }).status, 127);
  const aliasInvoked = path.join(s.root, "alias-invoked");
  const alias = mk(path.join(s.root, "otherbin", "colima"), `#!/bin/sh\nprintf called > ${JSON.stringify(aliasInvoked)}\n${fs.readFileSync(shim, "utf8")}`); fs.chmodSync(alias, 0o755);
  assert.equal(spawnSync("/bin/sh", [self, "list"], { env: { PATH: "/usr/bin:/bin", ...base, CLEAN_DEV_COLIMA: alias }, encoding: "utf8" }).status, 127, "another copy of the shim is never the real binary");
  assert.equal(fs.existsSync(aliasInvoked), false, "the case-varied shim header is recognised before execution");
});

test("limaDiskNames reads block lists in any field order and refuses every form it cannot fully read", () => {
  assert.deepEqual(limaDiskNames("disk: 1\n"), []);
  assert.deepEqual(limaDiskNames("additionalDisks: []\n"), []);
  assert.deepEqual(limaDiskNames("additionalDisks:\n  - name: a1\n    format: false\n  - \"b.2\"\nmounts: []\n"), ["a1", "b.2"]);
  assert.deepEqual(limaDiskNames("additionalDisks:\n- name: a1\n  fsType: ext4\nmounts: []\n"), ["a1"], "unindented list");
  assert.deepEqual(limaDiskNames("additionalDisks:\n  - format: false\n    fsArgs:\n      - -N\n    name: 'late'\n"), ["late"], "name after other fields");
  for (const bad of ["additionalDisks: [a, b]\n", "additionalDisks:\n  - {name: a}\n", "additionalDisks:\n  - format: false\n",
    "additionalDisks:\n  - name: a\n    name: b\n", "additionalDisks:\n\t- name: a\n", "additionalDisks:\n  - name: a\n - name: b\n",
    "additionalDisks:\n  - *disk\n", "additionalDisks:\n  - name: ../x\n", "\"additionalDisks\":\n  - name: a\n",
    "vm:\n  additionalDisks:\n    - name: a\n", "additionalDisks:\n  - name: a\n  - name: a\n", "additionalDisks:\n  - name: a\n    fsArgs: *args\n",
    "<<: *base\nadditionalDisks: []\n", "{additionalDisks: [{name: custom}]}\n", "? additionalDisks\n: - name: a\n",
    "disk: 1\nprovision:\n  - script: echo additionalDisks\n", "\"additional\\u0044isks\":\n  - name: custom\n", "'disk': 1\n",
    "!!str additionalDisks:\n  - name: a\n", "*k: 1\n", "- disk\n", " \"additional\\u0044isks\":\n   - name: custom\n",
    "disk: 1\r\"additional\\u0044isks\":\r  - name: custom\r", "\ufeffadditionalDisks:\n  - name: a\n", "additionalDisks:\n  - name: 0x10\n",
    "additionalDisks:\n  - name: yes\n", "additionalDisks:\n  - 1e3\n", "additionalDisks:\n  - name: \"a\\x41\"\n"]) assert.equal(limaDiskNames(bad), null, JSON.stringify(bad));
  assert.deepEqual(limaDiskNames("additionalDisks:\n  - name: \"0x10\"\n  - 'colima-b'\n"), ["0x10", "colima-b"], "quoted names are strings");
  assert.deepEqual(limaDiskNames("# additionalDisks are optional\nadditionalDisks:\n  - name: a\nprovision:\n  - script: |\n      [ -e /x ] && echo ok\n"), ["a"], "comments and indented shell lines are fine");
});

test("colima-rehome previews, moves instance and disk by rename with a manifest, and rolls back", (t) => {
  const s = colimaLab(t);
  const ino = fs.statSync(path.join(s.inst, "disk")).ino;
  const preview = colimaRehome(s.conf, s.env);
  assert.equal(preview.status, "preview");
  assert.deepEqual(preview.instances.map((i) => [i.instance, i.profile, i.moves.length]), [["colima-sample-vm", "sample-vm", 2]]);
  assert.deepEqual(preview.refused, []);
  assert.notEqual(preview.keys.from, preview.keys.to); assert.match(preview.keyNote, /new instance id every boot/);
  assert.deepEqual(preview.next, ["colima start -p sample-vm && colima ssh -p sample-vm -- true"]);
  assert.ok(fs.existsSync(s.inst));
  // The CLI child reads the fixture through the real, sandboxed limactl: it runs and answers, whatever Lima makes of it.
  const cliPreview = cli(s, ["vm", "colima-rehome", "--json"]);
  assert.equal(cliPreview.status, 0, cliPreview.stderr); assert.equal(JSON.parse(cliPreview.stdout).from, s.lima);
  const moved = colimaRehome(s.conf, s.env, { apply: true });
  assert.equal(moved.status, "moved");
  const dst = path.join(s.colima, "_lima", "colima-sample-vm");
  assert.equal(fs.statSync(path.join(dst, "disk")).ino, ino, "rename, not copy");
  assert.equal(fs.readFileSync(path.join(s.colima, "_lima", "_disks", "colima-sample-vm", "datadisk"), "utf8"), "data disk");
  assert.ok(!fs.existsSync(s.inst)); assert.ok(fs.existsSync(path.join(s.lima, "fedora44-agent", "lima.yaml")));
  assert.ok(moved.manifest.startsWith(path.join(s.home, "dev", "machine", "records", "clean-development")));
  assert.equal(JSON.parse(fs.readFileSync(moved.manifest, "utf8")).status, "moved");
  assert.equal(colimaRehome(s.conf, s.env).instances.length, 0);
  assert.equal(colimaRehomeRollback(s.conf, s.env, moved.manifest).status, "preview");
  assert.ok(fs.existsSync(dst));
  assert.equal(colimaRehomeRollback(s.conf, s.env, moved.manifest, { apply: true }).status, "rolled back");
  assert.equal(fs.statSync(path.join(s.inst, "disk")).ino, ino);
  assert.ok(fs.existsSync(path.join(s.lima, "_disks", "colima-sample-vm", "datadisk")));
  assert.ok(!fs.existsSync(path.join(s.colima, ".cd-rehome.lock")));
  assert.throws(() => colimaRehomeRollback(s.conf, s.env, moved.manifest, { apply: true }), /not a resumable colima-rehome manifest/);
});

test("colima-rehome reverts completed renames when a later one fails, and an interrupted rollback resumes", (t) => {
  const s = colimaLab(t);
  const real = fs.renameSync;
  const injected = t.mock.method(fs, "renameSync", (a, b) => { if (a === s.inst) { const e = new Error("injected EACCES"); e.code = "EACCES"; throw e; } return real(a, b); });
  assert.throws(() => colimaRehome(s.conf, s.env, { apply: true }), /injected EACCES; every completed rename reverted/);
  injected.mock.restore();
  assert.ok(fs.existsSync(path.join(s.lima, "_disks", "colima-sample-vm", "datadisk")));
  const records = path.join(s.home, "dev", "machine", "records", "clean-development");
  const failed = JSON.parse(fs.readFileSync(path.join(records, fs.readdirSync(records)[0]), "utf8"));
  assert.equal(failed.status, "reverted"); assert.deepEqual(failed.done, []);
  assert.ok(!fs.existsSync(path.join(s.colima, ".cd-rehome.lock")));
  // A rollback interrupted after the instance went back but before its disk: the retry moves only the disk.
  const moved = colimaRehome(s.conf, s.env, { apply: true, now: new Date(Date.now() + 1000) });
  fs.renameSync(path.join(s.colima, "_lima", "colima-sample-vm"), s.inst);
  const resumed = colimaRehomeRollback(s.conf, s.env, moved.manifest, { apply: true });
  assert.deepEqual(resumed.moves.map((m) => path.basename(path.dirname(m.from))), ["_disks"]);
  assert.ok(fs.existsSync(path.join(s.lima, "_disks", "colima-sample-vm", "datadisk")));
  assert.equal(JSON.parse(fs.readFileSync(moved.manifest, "utf8")).status, "rolled back");
});

test("colima-rehome refuses links, missing or unreferenced disks, and a held fence; the shim honours the fence", (t) => {
  let s = colimaLab(t);
  const outside = path.join(s.root, "outside"); fs.mkdirSync(outside);
  fs.mkdirSync(path.join(s.colima, "_lima"), { recursive: true });
  fs.symlinkSync(outside, path.join(s.colima, "_lima", "_disks"));
  assert.throws(() => colimaRehome(s.conf, s.env, { apply: true }), /not a real lab directory/);
  assert.deepEqual(fs.readdirSync(outside), []);
  s = colimaLab(t);
  fs.writeFileSync(path.join(s.inst, "lima.yaml"), "disk: 20GiB\n");
  assert.match(colimaRehome(s.conf, s.env).refused[0].refused, /_disks\/colima-sample-vm exists but lima.yaml does not reference it/);
  fs.writeFileSync(path.join(s.inst, "lima.yaml"), "additionalDisks:\n  - name: colima-sample-vm\n  - name: elsewhere\n");
  assert.match(colimaRehome(s.conf, s.env).refused[0].refused, /referenced disk elsewhere is not in/);
  s = colimaLab(t);
  const fence = mk(path.join(s.colima, ".cd-rehome.lock"), `${process.pid} now\n`);
  assert.throws(() => colimaRehome(s.conf, s.env, { apply: true }), /cd-rehome.lock exists/);
  assert.ok(fs.existsSync(s.inst));
  const fake = mk(path.join(s.root, "brew", "colima"), "#!/bin/sh\nexit 0\n"); fs.chmodSync(fake, 0o755);
  const r = spawnSync("/bin/sh", [path.join(plugin, "machine", "colima"), "start"], { encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", COLIMA_HOME: s.colima, DEV_STORAGE_VOLUME_TEST: "mounted", CLEAN_DEV_COLIMA: fake } });
  assert.equal(r.status, 75); assert.match(r.stderr, /colima-rehome is running or was interrupted/);
  const shimRun = () => spawnSync("/bin/sh", [path.join(plugin, "machine", "colima"), "start"], { encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", COLIMA_HOME: s.colima, DEV_STORAGE_VOLUME_TEST: "mounted", CLEAN_DEV_COLIMA: fake } });
  fs.writeFileSync(fence, "");
  assert.equal(shimRun().status, 75, "an empty fence is held");
  fs.writeFileSync(fence, "999999 interrupted\n");
  const stale = shimRun();
  assert.equal(stale.status, 75, "a fence left by a killed rehome is held until inspected"); assert.match(stale.stderr, /remove the fence, then finish with/);
  fs.rmSync(fence);
  assert.equal(shimRun().status, 0);
  assert.deepEqual(fs.readdirSync(s.colima).filter((n) => n.startsWith(".cd-colima-run.")), [], "run marker removed after the command");
});

test("colima-rehome and the shim exclude each other: a running colima command blocks apply and rollback", (t) => {
  const s = colimaLab(t);
  const job = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
  t.after(() => job.kill("SIGKILL"));
  // What the shim leaves while `colima ssh` or `colima start` runs.
  const marker = mk(path.join(s.colima, `.cd-colima-run.${job.pid}`), `${job.pid}\n`);
  assert.throws(() => colimaRehome(s.conf, s.env, { apply: true }), /colima commands are running \(pid \d+\); nothing moved/);
  assert.ok(fs.existsSync(s.inst)); assert.ok(!fs.existsSync(path.join(s.colima, ".cd-rehome.lock")));
  fs.rmSync(marker);
  const moved = colimaRehome(s.conf, s.env, { apply: true });
  mk(marker, `${job.pid}\n`);
  assert.throws(() => colimaRehomeRollback(s.conf, s.env, moved.manifest, { apply: true }), /colima commands are running/);
  fs.rmSync(marker);
  mk(path.join(s.colima, ".cd-colima-run.999999"), "999999\n");
  assert.equal(colimaRehomeRollback(s.conf, s.env, moved.manifest, { apply: true }).status, "rolled back", "a dead run marker does not block");
});

test("colima-rehome rollback reconciles planned moves by filesystem truth after a crash before journalling", (t) => {
  const s = colimaLab(t);
  const moved = colimaRehome(s.conf, s.env, { apply: true });
  const m = JSON.parse(fs.readFileSync(moved.manifest, "utf8"));
  fs.writeFileSync(moved.manifest, JSON.stringify({ ...m, status: "moving", done: [] }));
  const preview = colimaRehomeRollback(s.conf, s.env, moved.manifest);
  assert.equal(preview.moves.length, 2);
  assert.equal(colimaRehomeRollback(s.conf, s.env, moved.manifest, { apply: true }).status, "rolled back");
  assert.ok(fs.existsSync(path.join(s.inst, "lima.yaml")));
  assert.ok(fs.existsSync(path.join(s.lima, "_disks", "colima-sample-vm", "datadisk")));
  mk(path.join(s.colima, "_lima", "colima-sample-vm", "x"));
  fs.writeFileSync(moved.manifest, JSON.stringify({ ...m, status: "moving" }));
  assert.throws(() => colimaRehomeRollback(s.conf, s.env, moved.manifest), /both locations exist/);
});

test("colima-rehome refuses running, locked, occupied or unparseable instances and moves nothing", async (t) => {
  const job = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
  t.after(() => job.kill("SIGKILL"));
  const cases = [
    ["ha.pid of a running process", (s) => mk(path.join(s.inst, "ha.pid"), `${job.pid}\n`), /instance running/],
    ["ha.sock left by a running host agent", (s) => mk(path.join(s.inst, "ha.sock"), ""), /ha\.sock present/],
    ["disk locked", (s) => fs.symlinkSync(s.inst, path.join(s.lima, "_disks", "colima-sample-vm", "in_use_by")), /disk locked/],
    ["destination exists", (s) => mk(path.join(s.colima, "_lima", "colima-sample-vm", "x")), /destination exists/],
    ["inline disk list", (s) => fs.writeFileSync(path.join(s.inst, "lima.yaml"), "additionalDisks: [colima-sample-vm]\n"), /not understood/]
  ];
  for (const [name, setup, reason] of cases) {
    await t.test(name, (tt) => {
      const s = colimaLab(tt);
      setup(s);
      const r = colimaRehome(s.conf, s.env, { apply: true });
      assert.equal(r.status, "nothing to move");
      assert.equal(r.refused.length, 1); assert.match(r.refused[0].refused, reason);
      assert.ok(fs.existsSync(path.join(s.inst, "lima.yaml")));
    });
  }
});

test("colima-rehome refuses when external storage is unavailable", (t) => {
  const s = colimaLab(t);
  assert.throws(() => colimaRehome(s.conf, { ...s.env, DEV_STORAGE_VOLUME_TEST: "absent" }), /not mounted/);
});

test("doctor reports Colima migration issues only when the host extension enables its shim", (t) => {
  const s = colimaLab(t);
  const row = (r, name) => r.results.find((x) => x.name === name);
  let r = doctor(s.env, { gui: false });
  assert.equal(row(r, "colima shim"), undefined);
  assert.equal(row(r, "colima instances in lima-home"), undefined);
  mk(path.join(s.home, "dev", "machine", "env.private.zsh"), "# host extension\n");
  r = doctor(s.env, { gui: false });
  assert.ok(row(r, "colima shim").warn);
  assert.match(row(r, "colima instances in lima-home").detail, /^colima-sample-vm: run/);
  mk(path.join(s.home, "dev", "machine", "bin", "colima"), "#!/bin/sh\n");
  colimaRehome(s.conf, s.env, { apply: true });
  r = doctor(s.env, { gui: false });
  assert.equal(row(r, "colima shim"), undefined); assert.equal(row(r, "colima instances in lima-home"), undefined);
});

test("colima-rehome refuses while any Colima or Lima process runs, including a colima child that outlived its shim", (t) => {
  hideHostVms(t, "\n 4242 /opt/homebrew/bin/colima start -p sample-vm\n");
  const s = fixture(t);
  fakeLima(t);
  const lima = vmHome(s.conf, "lima"), inst = path.join(lima, "colima-sample-vm");
  mk(path.join(inst, "lima.yaml"), "additionalDisks:\n  - name: colima-sample-vm\n");
  mk(path.join(lima, "_disks", "colima-sample-vm", "datadisk"), "data");
  fs.mkdirSync(path.join(vmHome(s.conf, "colima"), "_lima"), { recursive: true });
  assert.throws(() => colimaRehome(s.conf, s.env, { apply: true }), /Colima\/Lima processes are running \(4242 \/opt\/homebrew\/bin\/colima start/);
  assert.ok(fs.existsSync(inst)); assert.ok(!fs.existsSync(path.join(vmHome(s.conf, "colima"), ".cd-rehome.lock")));
});

test("colima-rehome requires Lima's own reading to agree on the disks and to report the instance stopped", (t) => {
  for (const [name, options, reason] of [
    ["extra disk only Lima sees", { extra: ["custom"] }, /lima.yaml reads as disks \[colima-sample-vm\] but limactl reports \[colima-sample-vm custom\]/],
    ["running by Lima's account", { status: "Running" }, /limactl reports Running/],
    ["Lima unavailable", { missing: true }, /limactl cannot confirm/]]) {
    const s = colimaLab(t);
    fakeLima(t, options);
    const r = colimaRehome(s.conf, s.env);
    assert.deepEqual(r.instances, [], name); assert.match(r.refused[0].refused, reason, name);
  }
});

test("parseLimaList requires a config object; the sandbox profile denies writes", () => {
  const row = (o) => JSON.stringify({ name: "colima-x", status: "Stopped", ...o });
  assert.deepEqual(parseLimaList(row({ config: { additionalDisks: [{ name: "colima-x" }, "d2"] } }), "colima-x"), { status: "Stopped", disks: ["colima-x", "d2"] });
  assert.deepEqual(parseLimaList(row({ config: {} }), "colima-x"), { status: "Stopped", disks: [] });
  for (const bad of [row({ additionalDisks: [{ name: "colima-x" }] }), row({ config: null }), row({ config: [] }), row({ config: { additionalDisks: {} } }),
    row({ config: { additionalDisks: [{}] } }), "not json", row({ config: {} }) + "\n" + row({ config: {} })]) assert.equal(parseLimaList(bad, "colima-x"), null, bad);
  const probe = path.join(process.env.CLEAN_DEV_TEST_DIR, `sbx-${process.pid}`);
  const r = spawnSync("/usr/bin/sandbox-exec", ["-p", READ_ONLY_PROFILE, "/bin/sh", "-c", 'echo x > "$0"', probe], { encoding: "utf8" });
  assert.notEqual(r.status, 0); assert.ok(!fs.existsSync(probe));
});

test("colima-rehome rollback refuses a disk change since the move and a manifest outside records", (t) => {
  const s = colimaLab(t);
  const moved = colimaRehome(s.conf, s.env, { apply: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(moved.manifest, "utf8")).instances.map((i) => [i.instance, i.disks]), [["colima-sample-vm", ["colima-sample-vm"]]]);
  const yaml = path.join(s.colima, "_lima", "colima-sample-vm", "lima.yaml");
  fs.writeFileSync(yaml, "additionalDisks:\n  - name: colima-sample-vm\n  - name: extra\n");
  fakeLima(t, { extra: ["extra"] });
  assert.throws(() => colimaRehomeRollback(s.conf, s.env, moved.manifest), /disks changed since the move \(now \[colima-sample-vm extra\], moved \[colima-sample-vm\]\)/);
  const elsewhere = mk(path.join(s.root, "colima-rehome-2026-11-06T00-00-00-000Z.json"), fs.readFileSync(moved.manifest));
  assert.throws(() => colimaRehomeRollback(s.conf, s.env, elsewhere), /manifest must be a colima-rehome-\*\.json file directly in/);
  assert.ok(fs.existsSync(path.join(s.colima, "_lima", "colima-sample-vm")), "nothing moved");
});
