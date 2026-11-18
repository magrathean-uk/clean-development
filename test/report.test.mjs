import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { cli, mk, sim } from "./helpers.mjs";
import { report, reportText } from "../runtime/lib/report.mjs";
import { VERSION } from "../runtime/lib/conf.mjs";

const CACHE_VARIABLES = [
  "DEVCACHE", "CLEAN_DEVELOPMENT_ROOT", "CLEAN_DEVELOPMENT_CACHE_ROOT", "CLEAN_DEVELOPMENT_BUILD_ROOT",
  "CLEAN_DEVELOPMENT_SCRATCH_ROOT", "CLEAN_DEV_BUILDS", "CLEAN_DEV_SCRATCH", "XCODE_DERIVED_DATA_PATH",
  "DEVLIBRARY", "SWIFTPM_SHARED_CACHE", "CLANG_MODULE_CACHE_PATH", "HOMEBREW_CACHE", "XDG_CACHE_HOME",
  "GOCACHE", "GOMODCACHE", "BUN_INSTALL_CACHE_DIR", "pnpm_config_store_dir", "npm_config_cache",
  "YARN_CACHE_FOLDER", "UV_CACHE_DIR", "PIP_CACHE_DIR", "HF_HUB_CACHE", "HF_ASSETS_CACHE", "TORCH_HOME",
  "NUGET_PACKAGES", "PYTHONPYCACHEPREFIX", "PLAYWRIGHT_BROWSERS_PATH"
];

// Content and metadata snapshot, deliberately excluding atime (reads may update it).
export function snapshot(root) {
  const entries = [];
  function visit(p) {
    const s = fs.lstatSync(p);
    entries.push([path.relative(root, p), s.mode, s.size, s.mtimeMs, s.ctimeMs,
      s.isSymbolicLink() ? fs.readlinkSync(p) : s.isFile() ? fs.readFileSync(p).toString("base64") : null]);
    if (s.isDirectory()) for (const name of fs.readdirSync(p).sort()) visit(path.join(p, name));
  }
  visit(root);
  return entries;
}

function routed(s, mounted) {
  const root = mounted ? s.ext : s.int;
  fs.mkdirSync(root, { recursive: true });
  return { ...s.env, ...Object.fromEntries(CACHE_VARIABLES.map((name) => [name, path.join(root, "deps", name)])),
    DEVCACHE: root, CLEAN_DEVELOPMENT_ROOT: root, TMPDIR: "/var/folders/terminal/T/" };
}

test("report shows recorded restart reasons and behind homes without changing check status or writing", () => {
  const s = sim(); s.env = routed(s, true);
  assert.deepEqual(report(s.env).homes, []);
  assert.doesNotMatch(cli(s, ["report", "--check"]).stdout, /agent homes:|^restart /m);
  const file = mk(path.join(s.home, "dev/machine/state/clean-development/homes.txt"), [
    `home ${s.home}/.claude claude ${VERSION} 123456abcdef 234567abcdef restart=skill-text`,
    `home ${s.home}/account with spaces codex 0.7.1 - - restart=skill-text`,
    `home ${s.home}/numbered/1 claude ${VERSION} 123456abcdef 234567abcdef running-older restart=none`,
    `home ${s.home}/numbered/2 claude disabled - - restart=none`,
    `home ${s.home}/numbered/3 claude absent - -`
  ].join("\r\n") + "\r\n");
  const before = snapshot(s.root);
  for (const check of [[], ["--check"]]) {
    const result = cli(s, ["report", "--json", ...check]);
    assert.equal(result.status, 0, result.stderr);
    const homes = JSON.parse(result.stdout).homes;
    assert.equal(homes.length, 5);
    assert.equal(homes[1].path, `${s.home}/account with spaces`);
    assert.equal(homes[2].runningOlder, true);
    assert.equal(homes[0].runningOlder, false);
    assert.deepEqual(homes.map((home) => home.restartReason), ["skill-text", "skill-text", "none", "none", "none"]);
    const text = cli(s, ["report", ...check]);
    assert.equal(text.status, 0, text.stderr);
    assert.ok(text.stdout.includes(`agent homes: 2/5 current (${VERSION})`));
    for (const row of ["account with spaces: 0.7.1", "numbered/1: "+VERSION+" running-older", "numbered/2: disabled", "numbered/3: absent"])
      assert.ok(text.stdout.includes(row), text.stdout);
    assert.deepEqual(text.stdout.split("\n").filter((line) => line.startsWith("restart ")), [
      `restart ${s.home}/.claude skill-text`,
      `restart ${s.home}/account with spaces skill-text`,
      `restart ${s.home}/numbered/1 none`,
      `restart ${s.home}/numbered/2 none`,
      `restart ${s.home}/numbered/3 none`
    ]);
  }
  assert.deepEqual(snapshot(s.root), before);
  fs.writeFileSync(file, `home ${s.home}/numbered/1 claude ${VERSION} - - running-older\n`);
  const legacy = cli(s, ["report", "--check"]);
  assert.match(legacy.stdout, /agent homes: 1\/1 current/);
  assert.ok(legacy.stdout.includes(`restart ${s.home}/numbered/1 none\n`));
});

test("report refuses malformed inventory trailing fields and retries after repair", () => {
  const s = sim(); s.env = routed(s, true);
  const file = mk(path.join(s.home, "dev/machine/state/clean-development/homes.txt"));
  for (const line of ["home /fixture unknown 1.0.0 - -", "home /fixture claude 1.0.0 bad -",
    "home /fixture claude 1.0.0 - - unknown", "home /fixture claude 1.0.0 -",
    "home /fixture claude 1.0.0 - - restart=unknown", "home /fixture claude 1.0.0 - - restart=none restart=skill-text"]) {
    fs.writeFileSync(file, line+"\n");
    const run = cli(s, ["report", "--check"]);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /invalid agent home inventory line/);
    console.log(`negative home inventory: exit ${run.status}; ${run.stderr.trim()}`);
  }
  fs.writeFileSync(file, `home /fixture claude ${VERSION} - -\n`);
  assert.equal(cli(s, ["report", "--check"]).status, 0);
});

test("report inventories both mode roots, drives and escaped caches without writes", () => {
  for (const mounted of [true, false]) {
    const s = sim({ mounted });
    s.env = routed(s, mounted);
    mk(path.join(s.int, "deps", "internal"), "123");
    if (mounted) mk(path.join(s.ext, "builds", "external"), "12345");
    mk(path.join(s.home, ".npm", "cache"), "1234567");
    mk(path.join(s.home, "Library", "Caches", "pip", "cache"), "1234");
    mk(path.join(s.home, "Library", "Developer", "Xcode", "DerivedData", "cache"));
    if (mounted) mk(path.join(s.vol, ".cache", "escaped"), "123456789");
    const before = snapshot(s.root);
    const result = report(s.env);
    assert.equal(result.mode, mounted ? "external" : "internal");
    assert.equal(result.roots[0].bytes, 3);
    assert.equal(result.roots[1].bytes, mounted ? 5 : null);
    assert.equal(typeof result.drives[0].free, "number");
    assert.equal(typeof result.drives[1].free, mounted ? "number" : "object");
    assert.equal(result.routing.length, 0);
    assert.ok(result.caches.some((c) => c.path === path.join(s.home, ".npm") && c.bytes === 7));
    assert.ok(result.caches.some((c) => c.path.endsWith("Library/Caches/pip")));
    assert.ok(result.caches.some((c) => c.path.endsWith("Xcode/DerivedData")));
    if (mounted) assert.ok(result.caches.some((c) => c.path === path.join(s.vol, ".cache")));
    assert.match(reportText(result), /internal free: \d+ bytes/);
    assert.match(reportText(result), /external free:/);
    for (const args of [["report"], ["report", "--json"], ["report", "--check"]]) {
      const run = cli(s, args);
      assert.equal(run.status, 0, run.stderr);
    }
    assert.deepEqual(snapshot(s.root), before);
  }
});

test("report --check rejects each escaped cache variable in terminal and agent shells", () => {
  const s = sim();
  for (const agent of [false, true]) {
    s.env = routed(s, true);
    if (agent) Object.assign(s.env, { CODEX_THREAD_ID: "report-thread", CLEAN_DEV_SCRATCH: path.join(s.ext, "scratch", "own"),
      TMPDIR: path.join(s.ext, "scratch", "own", "tmp") });
    for (const name of CACHE_VARIABLES) {
      const env = { ...s.env, [name]: path.join(s.home, "escaped") };
      assert.ok(report(env).routing.some((r) => r.name === name), name);
    }
    s.env.npm_config_cache = path.join(s.home, ".npm");
    const before = snapshot(s.root);
    const run = cli(s, ["report", "--check"]);
    assert.equal(run.status, 1);
    assert.match(run.stdout, /routing: npm_config_cache=.*\(outside root\)/);
    console.log(`negative routing (${agent ? "agent" : "terminal"}): exit ${run.status}; ${run.stdout.split("\n").find((line) => line.includes("npm_config_cache"))}`);
    assert.deepEqual(snapshot(s.root), before);
  }
});

test("terminal macOS TMPDIR passes; agent TMPDIR must be its own scratch tmp", () => {
  const s = sim();
  s.env = routed(s, true);
  assert.equal(cli(s, ["report", "--check"]).status, 0);
  for (const harness of ["CODEX_THREAD_ID", "CLAUDE_CODE_SESSION_ID"]) {
    s.env[harness] = "report-session";
    s.env.CLEAN_DEV_SCRATCH = path.join(s.ext, "scratch", "own");
    for (const bad of ["/var/folders/terminal/T/", path.join(s.ext, "scratch", "other", "tmp"), path.join(s.ext, "deps", "tmp")]) {
      s.env.TMPDIR = bad;
      const run = cli(s, ["report", "--json", "--check"]);
      assert.equal(run.status, 1);
      assert.ok(JSON.parse(run.stdout).routing.some((r) => r.name === "TMPDIR"));
    }
    s.env.TMPDIR = path.join(s.env.CLEAN_DEV_SCRATCH, "tmp");
    assert.equal(cli(s, ["report", "--check"]).status, 0);
    delete s.env[harness];
  }
});

test("report detects relative paths, prefix lookalikes and redirected routed caches", () => {
  const s = sim();
  s.env = routed(s, true);
  const outside = path.join(s.root, "outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(s.ext, "redirect"));
  for (const value of ["relative/cache", `${s.ext}-other/npm`, path.join(s.ext, "redirect", "missing")]) {
    assert.ok(report({ ...s.env, npm_config_cache: value }).routing.some((r) => r.name === "npm_config_cache"));
  }
  fs.symlinkSync(outside, path.join(s.ext, "link"));
  mk(path.join(outside, "large"), "not counted in root");
  assert.equal(report(s.env).roots[1].bytes, 2 * Buffer.byteLength(outside));
});

test("report rejects apply and unsupported arguments without writes", () => {
  const s = sim(), before = snapshot(s.root);
  for (const args of [["--apply"], ["--apply", "anything"], ["--unknown"], ["--project", s.home]]) {
    const run = cli(s, ["report", ...args]);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /unknown argument:/);
    console.log(`negative report options: exit ${run.status}; ${run.stderr.trim()}`);
  }
  assert.deepEqual(snapshot(s.root), before);
});


test("report uses the supplied check option regardless of process arguments", () => {
  const s = sim(), argv = process.argv;
  try {
    process.argv = argv.slice(0, 2);
    assert.deepEqual(report(s.env, { check: true }).roots, []);
    process.argv.push("--check");
    assert.equal(report(s.env).roots.length, 2);
  } finally {
    process.argv = argv;
  }
});

test("report --check never scans caches or sizes roots; plain report still does", () => {
  const s = sim();
  s.env = routed(s, true);
  mk(path.join(s.ext, "deps", "sentinel"), "12345");
  const marker = path.join(s.root, "sizing-called");
  const guard = mk(path.join(s.root, "guard.mjs"), `import fs from "node:fs";
const forbidden = () => { fs.writeFileSync(${JSON.stringify(marker)}, "called"); throw new Error("sizing forbidden"); };
fs.readdirSync = forbidden;
fs.statfsSync = forbidden;
`);
  s.env.NODE_OPTIONS = `--import=${pathToFileURL(guard).href}`;
  for (const args of [["report", "--check"], ["report", "--check", "--json"]]) {
    const run = cli(s, args);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(fs.existsSync(marker), false, "--check called sizing code");
    if (args.includes("--json")) {
      const result = JSON.parse(run.stdout);
      assert.deepEqual(result.roots, []);
      assert.deepEqual(result.drives, []);
      assert.deepEqual(result.caches, []);
    }
  }
  const full = cli(s, ["report", "--json"]);
  assert.equal(full.status, 0, full.stderr);
  assert.equal(fs.existsSync(marker), true, "guard must catch plain report sizing");
  assert.match(full.stdout, /sizing forbidden/);
  console.log("negative sizing guard: plain report reaches sizing forbidden; --check does not");
});


test("report and shell routing agree on agent ID boundaries and Claude precedence", () => {
  const s = sim();
  s.env = routed(s, true);
  const rejected = ["", "KEY1", "12345678901", "aaaaaaaa-to-be-unset", "placeholder-123456789012",
    "123456789012-STUB", "123456789012_null_id", "é123456789012", "bad/123456789012"];
  const accepted = ["maintree0001", "019a2b3c-4d5e-7f60-8a9b-c0d1e2f3a4b5", "myplaceholder123", "id-MixedCase123"];
  for (const harness of ["CODEX_THREAD_ID", "CLAUDE_CODE_SESSION_ID"]) {
    for (const [ids, agent] of [[rejected, false], [accepted, true]]) for (const id of ids) {
      const env = { ...s.env, [harness]: id, CLEAN_DEV_SCRATCH: path.join(s.ext, "scratch", "own") };
      assert.equal(report(env).routing.some((r) => r.name === "TMPDIR"), agent, `${harness}=${id}`);
      if (id === "KEY1" || id === accepted[1]) {
        const run = cli({ ...s, env }, ["report", "--check"]);
        assert.equal(run.status, agent ? 1 : 0, run.stdout + run.stderr);
        console.log(`ID check ${harness}=${id}: exit ${run.status}`);
      }
      env.TMPDIR = path.join(env.CLEAN_DEV_SCRATCH, "tmp");
      assert.equal(report(env).routing.length, 0, `correct scratch: ${harness}=${id}`);
    }
  }
  const base = { ...s.env, CODEX_THREAD_ID: accepted[1] };
  assert.equal(report({ ...base, CLAUDE_CODE_SESSION_ID: "KEY1" }).routing.length, 0, "nonempty Claude ID takes precedence even if rejected");
  assert.ok(report({ ...base, CLAUDE_CODE_SESSION_ID: "" }).routing.some((r) => r.name === "TMPDIR"), "empty Claude ID falls back to Codex");
});
