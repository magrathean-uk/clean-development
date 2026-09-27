import assert from "node:assert/strict";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const CLI = path.join(REPO, "bin/clean-development.js");
const enabled = process.env.CLEAN_DEVELOPMENT_STRICT_TEST === "1";
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
function snapshot(root) {
  return fs.readdirSync(root).sort().flatMap((name) => {
    const file = path.join(root, name), stat = fs.lstatSync(file);
    return [[name, stat.mode, stat.isFile() ? sha(fs.readFileSync(file)) : stat.isSymbolicLink() ? fs.readlinkSync(file) : null],
      ...(stat.isDirectory() ? snapshot(file).map(([key, ...value]) => [`${name}/${key}`, ...value]) : [])];
  });
}
function fixture(root, name) {
  const base = path.join(root, name); fs.mkdirSync(base, { mode: 0o700 });
  for (const dir of ["source", "managed", "artifacts", "credentials", "undeclared"]) fs.mkdirSync(path.join(base, dir), { mode: 0o700 });
  const source = path.join(base, "source"), managed = path.join(base, "managed"), artifacts = path.join(base, "artifacts");
  fs.mkdirSync(path.join(source, ".git")); fs.writeFileSync(path.join(source, ".git/config"), "git sentinel\n");
  fs.writeFileSync(path.join(source, "main.c"), '#include <stdio.h>\nint main(void) { puts("strict-c-ok"); return 0; }\n');
  fs.writeFileSync(path.join(source, "main.go"), 'package main\nimport "fmt"\nfunc main() { fmt.Println("strict-go-ok") }\n');
  fs.writeFileSync(path.join(source, "go.mod"), "module strict.example/fixture\ngo 1.23\n");
  fs.writeFileSync(path.join(base, "credentials", "key"), "synthetic credential sentinel\n");
  fs.writeFileSync(path.join(base, "undeclared", "sentinel"), "external sentinel\n");
  const policy = { version: 1, sources: [source], managed, artifacts: [artifacts], env: {
    PATH: "/usr/local/go/bin:/usr/bin:/bin", GOROOT: "/usr/local/go", GOTOOLCHAIN: "local", GOPROXY: "off", CGO_ENABLED: "0", APPROVED_ONLY: "explicit" } };
  const file = path.join(base, "policy.json"); fs.writeFileSync(file, JSON.stringify(policy));
  return { base, source, managed, artifacts, policy, file };
}
function strictArgs(item, argv) { return [CLI, "strict", "--experimental", "--policy", item.file, "--", ...argv]; }
function run(item, argv, input, prefix = []) {
  const result = childProcess.spawnSync(prefix[0] ?? process.execPath,
    prefix.length ? [...prefix.slice(1), process.execPath, ...strictArgs(item, argv)] : strictArgs(item, argv), {
      cwd: item.source, input, env: { PATH: process.env.PATH, HOME: path.join(item.base, "credentials"),
        DUMMY_SECRET: "must-not-inherit", CLEAN_DEVELOPMENT_SESSION_MODE: "persist", CARGO_TARGET_DIR: path.join(item.source, "target") },
      timeout: 90000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
  if (result.error) throw result.error;
  return { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr };
}
function passes(result) { assert.equal(result.status, 0, result.stderr.toString()); }
function work(item) {
  const names = fs.readdirSync(item.managed); assert.equal(names.length, 1);
  return path.join(item.managed, names[0], "work");
}
async function signalRun(item, signal, code, extra = "") {
  const handler = signal === "SIGKILL" ? "" : `signal.signal(signal.${signal},lambda *a:sys.exit(${code}))`;
  const program = `import signal,sys,time,os\n${extra}\n${handler}\nprint("READY",flush=True)\nwhile True:time.sleep(0.05)`;
  const child = childProcess.spawn(process.execPath, strictArgs(item, ["/usr/bin/python3", "-c", program]), {
    cwd: item.source, env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = "", sent = false;
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  child.stderr.on("data", (bytes) => { errors += bytes; });
  child.stdout.on("data", (bytes) => {
    output += bytes;
    if (!sent && output.includes("READY\n")) { sent = true; child.kill(signal); }
  });
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject); child.once("close", (status, killed) => resolve({ status, signal: killed }));
  }).finally(() => clearTimeout(timer));
  assert.ok(sent, `workload readiness missing: ${errors}`);
  return { ...result, output, errors };
}

const ATTACK = String.raw`import os,sys,json,errno,subprocess,ctypes,socket
source,private,unknown,artifact,port=sys.argv[1:6]
work=os.environ['CLEAN_DEVELOPMENT_STRICT_WORK']
results=[]
def denied(label,op):
    try:
        op()
    except OSError as error:
        results.append({'case':label,'errno':error.errno})
    else:
        raise AssertionError('isolation failed: '+label)
def write(p):
    with open(p,'wb') as f:f.write(b'forbidden')
for label,p in [('source-bytes',source+'/main.c'),('source-create',source+'/target/new'),('git',source+'/.git/config'),('credentials',private+'/key'),('undeclared',unknown+'/sentinel'),('system','/usr/bin/env'),('etc','/etc/shadow'),('proc-root','/proc/1/root'+private+'/key'),('sys','/sys/kernel/uevent_helper')]:
    denied(label,lambda p=p:write(p))
denied('source-create-direct',lambda:write(source+'/should-not-exist'))
denied('source-chmod',lambda:os.chmod(source+'/main.c',0o777))
denied('source-unlink',lambda:os.unlink(source+'/main.c'))
denied('source-rename',lambda:os.rename(source+'/main.c',artifact+'/moved'))
denied('source-hardlink',lambda:os.link(source+'/main.c',work+'/hardlink'))
denied('credential-read',lambda:open(private+'/key','rb').read())
denied('source-escape-link',lambda:open(source+'/escape','rb').read())
link=work+'/back-to-source-'+('nested' if len(sys.argv)>6 else 'direct')
os.symlink(source+'/main.c',link)
denied('writable-link-to-source',lambda:write(link))
libc=ctypes.CDLL(None,use_errno=True)
class Header(ctypes.Structure):_fields_=[('version',ctypes.c_uint),('pid',ctypes.c_int)]
class Caps(ctypes.Structure):_fields_=[('effective',ctypes.c_uint),('permitted',ctypes.c_uint),('inheritable',ctypes.c_uint)]
h=Header(0x20080522,0); caps=(Caps*2)()
assert libc.capget(ctypes.byref(h),caps)==0
assert all(c.effective==c.permitted==c.inheritable==0 for c in caps)
assert libc.prctl(39,0,0,0,0)==1 # PR_GET_NO_NEW_PRIVS
assert libc.mount(None,source.encode(),None,4096|32,None)==-1 # bind-remount
assert ctypes.get_errno()==errno.EPERM
results.append({'case':'remount-source-rw','errno':ctypes.get_errno()})
denied('chroot',lambda:os.chroot(work))
s=socket.socket();s.settimeout(1)
denied('host-loopback',lambda:s.connect(('127.0.0.1',int(port))))
s.close()
assert 'DUMMY_SECRET' not in os.environ
assert os.environ['APPROVED_ONLY']=='explicit'
denied('control-fd-closed',lambda:os.fstat(3))
denied('ready-fd-closed',lambda:os.fstat(4))
write(work+'/allowed-'+('nested' if len(sys.argv)>6 else 'direct'))
if len(sys.argv)==6:
    nested=subprocess.run([sys.executable,__file__,*sys.argv[1:],'nested'],start_new_session=True,capture_output=True,text=True,timeout=10)
    assert nested.returncode==0,nested.stderr
    results.extend([dict(row,case='setsid-grandchild/'+row['case']) for row in json.loads(nested.stdout)])
print(json.dumps(results))
`;

test("strict REAL LINUX: builds, hostile nested writes and process semantics", { skip: !enabled, timeout: 180000 }, async (t) => {
  assert.equal(process.platform, "linux", "explicit strict acceptance requires Linux");
  assert.notEqual(process.getuid(), 0, "run explicit acceptance as a disposable non-root account");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cd-strict-real-")));
  const report = { status: "failed", boundary: "real rootless Linux namespace execution", root, machine: { platform: process.platform, arch: process.arch,
    kernel: os.release(), uid: process.getuid(), node: process.version }, versions: {}, results: [] };
  for (const [name, executable, args] of [["unshare", "/usr/bin/unshare", ["--version"]], ["setpriv", "/usr/bin/setpriv", ["--version"]],
    ["tini", "/usr/bin/tini", ["--version"]], ["gcc", "/usr/bin/gcc", ["--version"]], ["go", "/usr/local/go/bin/go", ["version"]]]) {
    const value = childProcess.spawnSync(executable, args, { encoding: "utf8", timeout: 5000 });
    assert.equal(value.status, 0, `${name} must be installed independently: ${value.error || value.stderr}`);
    report.versions[name] = { output: value.stdout.trim().split("\n")[0], executable, sha256: sha(fs.readFileSync(executable)) };
  }
  report.sourceFiles = Object.fromEntries(["src/strict.js", "src/strict-bootstrap.sh", "src/cli.js", "test/strict-linux.test.js"].map((name) => [name, sha(fs.readFileSync(path.join(REPO, name)))]));
  t.after(() => {
    fs.writeFileSync(path.join(root, "evidence.json"), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
    console.log(`Retained strict evidence: ${path.join(root, "evidence.json")}`);
  });
  await t.test("real C and Go builds write only managed intermediates and explicitly declared finals", () => {
    const item = fixture(root, "real-builds"), before = snapshot(item.source);
    const result = run(item, ["/bin/sh", "-ec", 'gcc main.c -o "$CLEAN_DEVELOPMENT_STRICT_WORK/intermediate"; "$CLEAN_DEVELOPMENT_STRICT_WORK/intermediate"; gcc main.c -o "$1/c-release"; "$1/c-release"; go telemetry off; go build -o "$1/go-release" main.go; "$1/go-release"', "build", item.artifacts]);
    passes(result); assert.equal(result.stdout.toString(), "strict-c-ok\nstrict-c-ok\nstrict-go-ok\n");
    assert.deepEqual(snapshot(item.source), before); assert.equal(fs.existsSync(path.join(item.source, "target")), false);
    const files = [path.join(work(item), "intermediate"), path.join(item.artifacts, "c-release"), path.join(item.artifacts, "go-release")];
    assert.ok(snapshot(path.join(work(item), "go-build")).some((row) => row[2]), "real Go cache is populated");
    report.results.push({ case: "real-builds", status: "passed", exit: result.status, stdout: result.stdout.toString(), stderr: result.stderr.toString(),
      artifacts: files.map((file) => ({ path: file, bytes: fs.statSync(file).size, sha256: sha(fs.readFileSync(file)) })) });
    files.forEach((file) => assert.ok(fs.statSync(file).size > 1000));
    const repeat = run(item, ["true"]); assert.notEqual(repeat.status, 0); assert.match(repeat.stderr.toString(), /empty dedicated/);
  });
  await t.test("direct and setsid nested processes cannot modify source, credentials, toolchains or undeclared locations", async () => {
    const item = fixture(root, "boundary-attacks");
    fs.symlinkSync(path.join(item.base, "credentials", "key"), path.join(item.source, "escape"));
    fs.writeFileSync(path.join(item.source, "attack.py"), ATTACK);
    const before = snapshot(item.source), credentials = snapshot(path.join(item.base, "credentials")), outside = snapshot(path.join(item.base, "undeclared"));
    const server = net.createServer((socket) => socket.destroy()); await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const result = run(item, ["/usr/bin/python3", "attack.py", item.source, path.join(item.base, "credentials"), path.join(item.base, "undeclared"), item.artifacts, String(server.address().port)]);
      passes(result); const attacks = JSON.parse(result.stdout); assert.equal(attacks.length, 44);
      assert.deepEqual(snapshot(item.source), before); assert.deepEqual(snapshot(path.join(item.base, "credentials")), credentials); assert.deepEqual(snapshot(path.join(item.base, "undeclared")), outside);
      assert.equal(fs.existsSync(path.join(item.source, "target")), false); assert.equal(fs.readdirSync(item.artifacts).length, 0);
      report.results.push({ case: "hostile-writes", status: "passed", attacks });
    } finally { await new Promise((resolve) => server.close(resolve)); }
  });
  await t.test("undeclared final output fails instead of falling back or moving artifacts", () => {
    const item = fixture(root, "forbidden-final"), before = snapshot(item.source);
    const result = run(item, ["gcc", "main.c", "-o", "./release"]);
    assert.notEqual(result.status, 0); assert.match(result.stderr.toString(), /Read-only file system/);
    assert.deepEqual(snapshot(item.source), before); assert.equal(fs.readdirSync(item.artifacts).length, 0);
    report.results.push({ case: "forbidden-final", status: "passed", exit: result.status, stderr: result.stderr.toString() });
  });
  await t.test("literal argv, cwd and binary stdio survive; command exit status is unchanged", () => {
    const item = fixture(root, "argv-streams"), argv = ["", " spaced value ", "café 東京", "'\";$()!\\", "line1\nline2", "--experimental", "--"];
    const payload = Buffer.from([0, 1, 2, 13, 10, 255, 128, 67]);
    const result = run(item, ["/usr/bin/python3", "-c", 'import sys,os,json;sys.stderr.write(json.dumps({"argv":sys.argv[1:],"cwd":os.getcwd()}));sys.stdout.buffer.write(sys.stdin.buffer.read());sys.exit(37)', ...argv], payload);
    assert.equal(result.status, 37); assert.deepEqual(result.stdout, payload); assert.deepEqual(JSON.parse(result.stderr), { argv, cwd: item.source });
    report.results.push({ case: "argv-streams-exit", status: "passed", exit: result.status, inputSha256: sha(payload), outputSha256: sha(result.stdout) });
  });
  await t.test("an equals-bearing executable name is not parsed as an environment assignment", () => {
    const item = fixture(root, "equals-executable");
    const program = path.join(item.source, "odd=tool");
    fs.writeFileSync(program, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 });
    item.policy.env.PATH = `${item.source}:/usr/bin:/bin`;
    item.policy.env.TEST_SECRET = "not-a-host-process-argument";
    fs.writeFileSync(item.file, JSON.stringify(item.policy));
    const result = run(item, ["odd=tool", "", "literal = ", "café"]);
    passes(result); assert.equal(result.stdout.toString(), "\nliteral = \ncafé\n");
    report.results.push({ case: "equals-executable", status: "passed", exit: result.status });
  });
  for (const [signal, status] of [["SIGINT", 37], ["SIGTERM", 38], ["SIGHUP", 39], ["SIGQUIT", 40], ["SIGUSR1", 41], ["SIGUSR2", 42]]) {
    await t.test(`${signal} reaches the workload handler and preserves its custom exit`, async () => {
      const item = fixture(root, signal), result = await signalRun(item, signal, status);
      assert.equal(result.status, status, result.errors); report.results.push({ case: signal, status: "passed", exit: result.status });
    });
  }
  await t.test("uncaught child termination retains conventional 128+signal status", () => {
    const item = fixture(root, "child-signal"), result = run(item, ["/usr/bin/python3", "-c", "import os,signal;os.kill(os.getpid(),signal.SIGTERM)"]);
    assert.equal(result.status, 143); report.results.push({ case: "child-SIGTERM", status: "passed", exit: result.status });
  });
  await t.test("killing the wrapper kills a detached nested heartbeat via namespace lifetime", async () => {
    const item = fixture(root, "parent-death");
    const extra = `import subprocess\nsubprocess.Popen([sys.executable,'-c','import os,time; f=open(os.environ["CLEAN_DEVELOPMENT_STRICT_WORK"]+"/heartbeat","ab",buffering=0); [(f.write(b"x"),time.sleep(.01)) for _ in range(1000)]'],start_new_session=True,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\ntime.sleep(.1)`;
    const result = await signalRun(item, "SIGKILL", 0, extra);
    assert.equal(result.signal, "SIGKILL");
    const file = path.join(work(item), "heartbeat"), bytes = fs.readFileSync(file).length;
    await new Promise((resolve) => setTimeout(resolve, 200)); assert.equal(fs.readFileSync(file).length, bytes);
    assert.ok(bytes > 0); report.results.push({ case: "wrapper-SIGKILL", status: "passed", retainedHeartbeatBytes: bytes });
  });
  await t.test("kernel permission failure is fail-closed, without an unsandboxed workload", () => {
    const item = fixture(root, "unshare-denied");
    const syscall = { x64: 272, arm64: 97 }[process.arch]; assert.ok(syscall, "record a seccomp syscall number for this architecture");
    // Test-only filter adds a denial; it never relaxes host restrictions. BPF:
    // load syscall number, deny unshare with EPERM, allow everything else.
    const filter = Buffer.alloc(32);
    [[0x20, 0, 0, 0], [0x15, 0, 1, syscall], [0x06, 0, 0, 0x50001], [0x06, 0, 0, 0x7fff0000]].forEach(([code, jt, jf, k], index) => {
      filter.writeUInt16LE(code, index * 8); filter[index * 8 + 2] = jt; filter[index * 8 + 3] = jf; filter.writeUInt32LE(k, index * 8 + 4);
    });
    const file = path.join(item.base, "deny-unshare.bpf"); fs.writeFileSync(file, filter);
    const result = run(item, ["/bin/sh", "-c", 'echo escaped > "$1/should-not-exist"', "sh", item.artifacts], undefined,
      ["/usr/bin/setpriv", "--no-new-privs", "--seccomp-filter", file]);
    assert.notEqual(result.status, 0); assert.match(result.stderr.toString(), /unshare failed: Operation not permitted/);
    assert.equal(fs.readdirSync(item.artifacts).length, 0);
    report.results.push({ case: "kernel-denies-unshare", status: "passed", exit: result.status, stderr: result.stderr.toString() });
  });
  report.status = report.results.length === 14 ? "passed" : "failed";
  assert.equal(report.status, "passed");
});
