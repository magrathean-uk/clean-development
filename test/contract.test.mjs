import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cli, hook, mk, plugin, sim, snapshot } from "./helpers.mjs";
import { loadConf, VERSION } from "../runtime/lib/conf.mjs";
import { installPackage } from "../installer.mjs";

const self = fileURLToPath(import.meta.url);
const contractFile = process.env.CLEAN_DEV_CONTRACT_FILE || path.join(plugin, "CONTRACT.md");
const source = () => fs.readFileSync(contractFile, "utf8");
const sorted = (values) => [...values].sort();
const equalSet = (actual, expected, label) => assert.deepEqual(sorted(actual), sorted(expected), label);

// Deliberately small grammar: exact ## headings, text fences and pipe tables, no Markdown renderer.
function section(text, name) {
  const chunks = text.replaceAll("\r\n", "\n").split(/^## /m).slice(1);
  const matches = chunks.filter((chunk) => chunk.split("\n")[0].trim() === name);
  assert.equal(matches.length, 1, `contract section: ${name}`);
  return matches[0].slice(matches[0].indexOf("\n") + 1);
}
function fence(text, name) {
  const block = section(text, name).match(/^```text\n([\s\S]*?)^```\s*$/gm);
  assert.equal(block?.length, 1, `contract text fence: ${name}`);
  return block[0].replace(/^```text\n/, "").replace(/^```\s*$/m, "").trimEnd() + "\n";
}
function table(text, name, columns) {
  const lines = section(text, name).split("\n").filter((line) => line.trim().startsWith("|"));
  assert.ok(lines.length > 2, `contract table: ${name}`);
  const cells = lines.map((line) => {
    assert.match(line.trim(), /^\|.*\|$/, `contract row: ${name}`);
    const values = line.trim().slice(1, -1).split("|").map((v) => v.trim().replace(/^`(.*)`$/, "$1"));
    assert.equal(values.length, columns, `contract columns: ${name}`);
    assert.ok(values.every(Boolean), `contract empty cell: ${name}`);
    return values;
  });
  assert.ok(cells[1].every((v) => /^:?-{3,}:?$/.test(v)), `contract separator: ${name}`);
  const rows = cells.slice(2);
  equalSet(new Set(rows.map((row) => row.slice(0, columns - 1).join("/"))), rows.map((row) => row.slice(0, columns - 1).join("/")), `contract duplicate row: ${name}`);
  return rows;
}
const entries = (name) => Object.fromEntries(table(source(), name, 2));
function checkShapes(samples) {
  const fields = entries("JSON fields");
  for (const [name, objects] of Object.entries(samples)) {
    assert.ok(fields[name], `contract JSON object: ${name}`);
    assert.ok(objects.length, `unexercised JSON object: ${name}`);
    const tokens = fields[name].split(",").map((s) => s.trim());
    const allowed = tokens.map((s) => s.replace(/\?$/, ""));
    assert.equal(new Set(allowed).size, allowed.length, `duplicate JSON field: ${name}`);
    for (const object of objects) {
      for (const key of Object.keys(object)) assert.ok(allowed.includes(key), `contract JSON ${name}: unexpected ${key}`);
      for (const token of tokens.filter((s) => !s.endsWith("?"))) assert.ok(Object.hasOwn(object, token), `contract JSON ${name}: missing ${token}`);
    }
    equalSet(new Set(objects.flatMap(Object.keys)), allowed, `contract JSON ${name}: field coverage`);
  }
}
function json(run, status = 0) {
  assert.equal(run.status, status, run.stdout + run.stderr);
  return JSON.parse(status === 3 ? run.stderr : run.stdout);
}
function fixture(mounted = false) {
  const s = sim({ mounted });
  const tmp = path.join(s.root, "terminal-tmp");
  fs.mkdirSync(tmp);
  s.env.TMPDIR = tmp;
  return s;
}
function routed(s, overrides = {}, load = true) {
  const script = (load ? '. "$1"; ' : '') + '"$2" -e \'process.stdout.write(JSON.stringify(process.env))\'';
  const run = spawnSync("/bin/zsh", ["-f", "-c", script, "contract", path.join(plugin, "machine/env.zsh"), process.execPath], {
    cwd: s.root, env: { ...s.env, ...overrides }, encoding: "utf8", timeout: 15000
  });
  return json(run);
}
function cleanupFixture() {
  const s = fixture();
  const clock = mk(path.join(s.root, "clock.mjs"), `import fs from "node:fs";
Date.now = () => ${Date.now() + 40 * 86400000};
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  if (from === process.env.CONTRACT_FAIL_MOVE) throw Object.assign(new Error("fixture move failure"), { code: "EXDEV" });
  return rename(from, to);
};\n`);
  s.env.NODE_OPTIONS = `--import=${pathToFileURL(clock).href}`;
  s.env.CLEAN_DEV_WORK = path.join(s.home, "dev/machine");
  s.candidate = path.join(s.env.CLEAN_DEV_WORK, "jobs/contract/done");
  mk(path.join(s.candidate, ".done"));
  mk(path.join(s.candidate, "file"), "12345");
  return s;
}
function installer(s, args) {
  return spawnSync(process.execPath, [path.join(plugin, "installer.mjs"), ...args], { cwd: s.root, env: s.env, encoding: "utf8", timeout: 30000 });
}

// Inventory actual inputs rather than freezing a second list of user settings in the test.
function packageSources() {
  const files = ["machine/env.zsh", "install.sh", "installer.mjs", "install-lock.mjs"];
  function visit(dir) {
    for (const entry of fs.readdirSync(path.join(plugin, dir), { withFileTypes: true })) {
      const name = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) visit(name); else if (entry.isFile()) files.push(name);
    }
  }
  visit("runtime");
  return Object.fromEntries(files.map((name) => [name, fs.readFileSync(path.join(plugin, name), "utf8")]));
}
const uncomment = (text, shell = false) => text.split("\n")
  .filter((line) => !line.trimStart().startsWith(shell ? "#" : "//")).join("\n");
const tokens = (text, pattern) => [...text.matchAll(pattern)].map((m) => m[1] || m[2]);
function shellReads(text) {
  return tokens(uncomment(text, true), /\$(?:\{#?([A-Za-z_][A-Za-z_0-9]*)|([A-Za-z_][A-Za-z_0-9]*))/g);
}
function jsReads(text) {
  const code = uncomment(text);
  const names = tokens(code, /(?<![\w.$/"'])(?:process\.)?env\s*(?:\.\s*([A-Za-z_][A-Za-z_0-9]*)|\[\s*["']([A-Za-z_][A-Za-z_0-9]*)["']\s*\])/g);
  for (const [, fields] of code.matchAll(/\{([^{}]+)\}\s*=\s*(?:process\.)?env\b/g)) {
    for (const field of fields.split(",")) {
      const match = field.trim().match(/^([A-Za-z_][A-Za-z_0-9]*)(?:\s*[:=]|\s*$)/);
      assert.ok(match, `untracked destructured environment read: ${field.trim()}`);
      names.push(match[1]);
    }
  }
  return names;
}
function policyKeys(files) {
  const shell = files["machine/env.zsh"].match(/case "\$__cd_k" in\s*([\s\S]*?)\)\s*;;/);
  assert.ok(shell, "storage shell key inventory");
  const shellKeys = shell[1].replace(/\\\s*\n/g, "").split("|").map((s) => s.trim());
  const conf = files["runtime/lib/conf.mjs"];
  const declaration = conf.match(/const keys = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(declaration, "storage runtime key inventory");
  const runtimeKeys = tokens(declaration[1], /"([A-Z][A-Z_0-9]*)"/g);
  for (const [, name] of declaration[1].matchAll(/\.\.\.(?:Object\.keys\()?([A-Z_]+)\)?/g)) {
    const block = conf.match(new RegExp(`const ${name} = ([\\[{])([\\s\\S]*?)[\\]}];`));
    assert.ok(block, `storage key group ${name}`);
    runtimeKeys.push(...tokens(block[2], block[1] === "{" ? /\b([A-Z][A-Z_0-9]*)\s*:/g : /"([A-Z][A-Z_0-9]*)"/g));
  }
  equalSet(new Set(shellKeys), new Set(runtimeKeys), "storage accepted keys in shell and runtime");
  return new Set(runtimeKeys);
}
function activePolicyKeys(files, accepted) {
  const shell = files["machine/env.zsh"];
  const start = shell.indexOf("# The runtime computes dependent defaults");
  assert.ok(start >= 0, "storage shell use boundary");
  const used = new Set(shellReads(shell.slice(start)).filter((name) => accepted.has(name)));
  const conf = uncomment(files["runtime/lib/conf.mjs"]);
  const runtime = Object.entries(files).filter(([name]) => name.startsWith("runtime/")).map(([, text]) => uncomment(text)).join("\n");
  const properties = new Set(tokens(runtime, /\b(?:conf|\w+\.conf)\s*(?:\.\s*([A-Za-z_][A-Za-z_0-9]*)|\[\s*["']([A-Za-z_][A-Za-z_0-9]*)["']\s*\])/g));
  const consumers = Object.entries(files).filter(([name]) => name.startsWith("runtime/") && name !== "runtime/lib/conf.mjs")
    .map(([, text]) => uncomment(text)).join("\n");
  for (const property of tokens(consumers, /\.\s*([A-Za-z_][A-Za-z_0-9]*)|\[\s*["']([A-Za-z_][A-Za-z_0-9]*)["']\s*\]/g)) properties.add(property);
  const mapping = new Map([...conf.matchAll(/\b([A-Za-z_][A-Za-z_0-9]*)\s*:\s*v(?:\.([A-Z][A-Z_0-9]*)|\[\s*["']([A-Z][A-Z_0-9]*)["']\s*\])/g)].map((m) => [m[2] || m[3], m[1]]));
  for (const key of tokens(conf, /\bv(?:\.([A-Z][A-Z_0-9]*)|\[\s*["']([A-Z][A-Z_0-9]*)["']\s*\])/g)) {
    if (!mapping.has(key) || properties.has(mapping.get(key))) used.add(key);
  }
  for (const property of properties) {
    const key = property.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
    if (accepted.has(key)) used.add(key);
    for (const [name, field] of mapping) if (field === property) used.add(name);
  }
  return used;
}
function checkInputContract(text, files) {
  const accepted = policyKeys(files), active = activePolicyKeys(files, accepted);
  const settings = table(text, "Storage settings", 3);
  const documented = new Set(settings.map(([name]) => name));
  assert.equal(documented.size, settings.length, "contract duplicate storage setting");
  const ignoredText = section(text, "Storage settings").split(/^### Ignored\s*$/m);
  assert.equal(ignoredText.length, 2, "storage ignored list");
  const ignoredNames = tokens(ignoredText[1], /`([A-Z][A-Z_0-9]*)`/g), ignored = new Set(ignoredNames);
  assert.equal(ignored.size, ignoredNames.length, "contract duplicate ignored storage key");
  for (const name of active) assert.ok(documented.has(name), `contract storage settings: undocumented ${name}`);
  for (const name of documented) assert.ok(active.has(name), `contract storage settings: unread ${name}`);
  equalSet(ignored, [...accepted].filter((name) => !active.has(name)), "contract ignored storage keys");
  const home = "/contract-fixture-home", defaults = loadConf({ HOME: home }, { text: "" });
  assert.ok(defaults.valid, "storage runtime defaults are valid");
  for (const [name, value] of settings) {
    const field = Object.hasOwn(defaults, name) ? name : name.toLowerCase().replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    assert.ok(Object.hasOwn(defaults, field), `contract storage default field: ${name}`);
    const expanded = value.replaceAll("${EXTERNAL_VOLUME}", defaults.externalVolume)
      .replaceAll("${EXTERNAL_ROOT}", defaults.externalRoot).replaceAll("$HOME", home);
    assert.equal(expanded, String(defaults[field]), `contract storage default: ${name}`);
  }

  const reads = new Set();
  for (const [name, code] of Object.entries(files)) {
    const shell = !name.endsWith(".mjs");
    for (const input of shell ? shellReads(code) : jsReads(code)) reads.add(input);
    if (!shell) for (const [, index] of uncomment(code).matchAll(/(?<![\w.$/"'])(?:process\.)?env\s*\[\s*([^\]]+)\s*\]/g)) {
      assert.ok(/^["'][A-Za-z_][A-Za-z_0-9]*["']$/.test(index.trim()) || (name === "runtime/lib/report.mjs" && index.trim() === "name"),
        `untracked dynamic environment read: ${name} [${index.trim()}]`);
    }
  }
  const cacheList = files["runtime/lib/report.mjs"].match(/const CACHE_VARIABLES = \[([\s\S]*?)\]/);
  assert.ok(cacheList, "runtime cache variable inventory");
  for (const name of tokens(cacheList[1], /"([A-Za-z_][A-Za-z_0-9]*)"/g)) reads.add(name);
  // These are shell locals, a shell-provided version marker, and fault-injection controls, not user settings.
  const nonUser = new Set(["n", "node", "path_node", "src", "rt", "ZSH_VERSION", "DEV_STORAGE_VOLUME_TEST",
    "CLEAN_DEV_PROBE_RETRY_MS", "CLEAN_DEV_TEST_BIN_DIR", "CLEAN_DEV_TEST_BOOT", "CLEAN_DEV_TEST_LOCK_REFUSE",
    "CLEAN_DEV_TEST_STATFS_TYPE", "CLEAN_DEV_TEST_STOP_AT"]);
  const variables = new Set(table(text, "User variables", 2).map(([name]) => name));
  const exports = new Set(table(text, "Routing exports", 2).map(([name]) => name));
  for (const name of reads) {
    if (name.startsWith("__") || nonUser.has(name) || accepted.has(name)) continue;
    assert.ok(variables.has(name) || exports.has(name), `contract user variables: undocumented ${name}`);
  }
  for (const name of variables) assert.ok(reads.has(name), `contract user variables: unread ${name}`);
  assert.match(section(text, "Compatibility"), /Every 1\.x release keeps every item in this contract\. Removing or renaming a contract item requires 2\.0\./,
    "contract compatibility rule");
}

test("contract user variables, storage settings and compatibility follow source reads", () => {
  checkInputContract(source(), packageSources());
});

test("contract storage path defaults agree with a fixture shell", () => {
  const s = fixture(), files = packageSources(), shell = files["machine/env.zsh"];
  fs.unlinkSync(s.config);
  const marker = "\nunset STORAGE_CONF_VERSION", end = shell.lastIndexOf(marker);
  assert.ok(end >= 0, "shell storage capture point");
  const start = shell.indexOf("# The runtime computes dependent defaults");
  const names = [...activePolicyKeys(files, policyKeys(files))].filter((name) => shellReads(shell.slice(start)).includes(name));
  const capture = `\nprintf '%s\\n' ${names.map((name) => `"$${name}"`).join(" ")}\n`;
  const file = mk(path.join(s.root, "capture-env.zsh"), shell.slice(0, end) + capture + shell.slice(end));
  const run = spawnSync("/bin/zsh", ["-f", file], {
    cwd: s.root, env: { ...s.env, DEV_ENV_INSPECT_ONLY: "1" }, encoding: "utf8", timeout: 15000
  });
  assert.equal(run.status, 0, run.stderr);
  const defaults = loadConf({ HOME: s.home }, { text: "" });
  const values = names.map((name) => defaults[name.toLowerCase().replace(/_([a-z])/g, (_, c) => c.toUpperCase())]);
  assert.deepEqual(run.stdout.trimEnd().split("\n"), values, "contract shell storage defaults");
});

test("contract input inventory rejects missing and unread entries", () => {
  const text = source(), files = packageSources();
  const reject = (label, fn, diagnostic) => assert.throws(fn, (error) => {
    assert.match(error.message, diagnostic);
    console.log(`negative ${label}: ${error.message.split("\n")[0]}`);
    return true;
  });
  reject("new user variable", () => checkInputContract(text, { ...files, "install.sh": files["install.sh"] + '\n: "${CLEAN_DEV_FUTURE:-}"\n' }), /undocumented CLEAN_DEV_FUTURE/);
  reject("bracket user variable", () => checkInputContract(text, { ...files, "installer.mjs": files["installer.mjs"] + '\nprocess.env["CLEAN_DEV_FUTURE"];\n' }), /undocumented CLEAN_DEV_FUTURE/);
  reject("destructured user variable", () => checkInputContract(text, { ...files, "installer.mjs": files["installer.mjs"] + '\nconst { CLEAN_DEV_FUTURE: future } = process.env;\n' }), /undocumented CLEAN_DEV_FUTURE/);
  reject("dynamic user variable", () => checkInputContract(text, { ...files, "installer.mjs": files["installer.mjs"] + '\nenv[untracked];\n' }), /untracked dynamic environment read/);
  reject("unread user variable", () => checkInputContract(text.replace("| CLEAN_DEV_NODE |", "| CLEAN_DEV_MISSING | Unused. |\n| CLEAN_DEV_NODE |"), files), /unread CLEAN_DEV_MISSING/);
  reject("new storage read", () => checkInputContract(text, { ...files, "runtime/lib/hook.mjs": files["runtime/lib/hook.mjs"] + "\nconf.BIG_DOWNLOAD_GB;\n" }), /undocumented BIG_DOWNLOAD_GB/);
  reject("aliased storage read", () => checkInputContract(text, { ...files, "runtime/lib/hook.mjs": files["runtime/lib/hook.mjs"] + "\npolicy.BIG_DOWNLOAD_GB;\n" }), /undocumented BIG_DOWNLOAD_GB/);
  reject("unknown storage read", () => checkInputContract(text, { ...files, "runtime/lib/conf.mjs": files["runtime/lib/conf.mjs"].replace("const v = parsed.values;", 'const v = parsed.values; if (v["FUTURE_STORAGE"]) warnings.push("future");') }), /undocumented FUTURE_STORAGE/);
  reject("unread storage key", () => checkInputContract(text.replace("| MODELS_ROOT | /Volumes/${EXTERNAL_VOLUME}/models |", "| MISSING_ROOT | none | Unused. |\n| MODELS_ROOT | /Volumes/${EXTERNAL_VOLUME}/models |"), files), /unread MISSING_ROOT/);
  reject("extra ignored key", () => checkInputContract(text.replace("### Ignored\n", "### Ignored\n`MISSING_STORAGE` "), files), /contract ignored storage keys/);
  reject("storage default", () => checkInputContract(text.replace("| INTERNAL_MIN_FREE_GB | 40 |", "| INTERNAL_MIN_FREE_GB | 41 |"), files), /contract storage default: INTERNAL_MIN_FREE_GB/);
  reject("compatibility", () => checkInputContract(text.replace("requires 2.0.", "requires a later release."), files), /contract compatibility rule/);
});

// Parser boundary tests also make accidental table/fence omissions fail clearly.
test("contract parser delimiters and malformed input", () => {
  const minimal = "## A\n```text\nhello\n```\n\n| Name | Value |\n| --- | --- |\n| one | two |\n";
  assert.equal(fence(minimal.replaceAll("\n", "\r\n"), "A"), "hello\n");
  assert.deepEqual(table(minimal, "A", 2), [["one", "two"]]);
  for (const broken of [minimal.replace("## A", "## B"), minimal + minimal,
    minimal.replace("```\n\n", "\n\n")]) assert.throws(() => fence(broken, "A"));
  for (const broken of [minimal.replace("| one | two |", "| one | |"), minimal + "| one | other |\n",
    minimal.replace("| one | two |", "| one | two | extra |"), minimal.replace("| --- | --- |", "| x | y |")]) assert.throws(() => table(broken, "A", 2));
  console.log("negative parser: rejected missing/duplicate sections, open fence, empty/extra cells, duplicate row and bad separator");
});

test("contract CLI usage and option inventory", () => {
  const s = fixture(), text = source();
  for (const args of [[], ["help"], ["--help"], ["-h"], ["unknown", "--write", "--help"]]) {
    const run = cli(s, args);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, fence(text, "CLI usage"), "contract CLI usage");
  }
  const run = installer(s, ["--help"]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, fence(text, "Installer usage"), "contract installer usage");
  const cliSource = fs.readFileSync(path.join(plugin, "runtime/bin/clean-development.mjs"), "utf8");
  const installSource = fs.readFileSync(path.join(plugin, "installer.mjs"), "utf8");
  const flags = (s) => new Set(s.match(/--[a-z][a-z-]*|(?<!\w)-h\b/g));
  equalSet(flags(cliSource), flags(section(text, "CLI usage")), "contract CLI flags");
  const installerCases = [...installSource.matchAll(/case "(-[^\"]+)":/g)].map((m) => m[1]);
  equalSet(new Set(installerCases), flags(section(text, "Installer usage")), "contract installer flags");
  const dir = path.join(s.root, "-directory"); fs.mkdirSync(dir);
  assert.equal(cli(s, ["init", "--", "-directory"]).status, 0);
});

test("contract exit codes from success, failure and retry fixture runs", () => {
  const s = fixture(), codes = new Set();
  const expect = (run, code, message) => {
    assert.equal(run.status, code, run.stdout + run.stderr);
    if (message) assert.match(run.stderr + run.stdout, message);
    codes.add(String(run.status));
  };
  expect(cli(s, ["version"]), 0);
  s.env = routed(s);
  expect(cli(s, ["report", "--check"]), 0);
  const normal = s.env.npm_config_cache;
  s.env.npm_config_cache = path.join(s.home, "escaped");
  expect(cli(s, ["report", "--check"]), 1, /outside root/);
  s.env.npm_config_cache = normal;
  expect(cli(s, ["report", "--check"]), 0);
  const policy = fs.readFileSync(s.config);
  fs.writeFileSync(s.config, "UNKNOWN_KEY=1\n");
  expect(cli(s, ["report", "--check"]), 1, /unknown policy key/);
  expect(cli(s, ["cleanup"]), 2, /invalid storage policy/);
  fs.writeFileSync(s.config, policy);
  expect(cli(s, ["init", "--write"]), 0);
  const before = fs.readFileSync(path.join(s.root, ".clean-development.json"));
  expect(cli(s, ["init", "--write"]), 1, /exists; retaining/);
  assert.deepEqual(fs.readFileSync(path.join(s.root, ".clean-development.json")), before);
  for (const args of [["unknown"], ["version", "--unknown"], ["cleanup", "--project"], ["cleanup", "--skip", "1"]]) expect(cli(s, args), 2);
  expect(cli(s, ["cleanup", "--apply"]), 3, /needs a list id/);
  expect(cli(s, ["cleanup", "--apply", "wrong"]), 3, /list changed or id does not match/);
  const moving = cleanupFixture(), list = json(cli(moving, ["cleanup", "--json"]));
  moving.env.CONTRACT_FAIL_MOVE = moving.candidate;
  expect(cli(moving, ["cleanup", "--apply", list.id, "--json"]), 1, /EXDEV/);
  delete moving.env.CONTRACT_FAIL_MOVE;
  expect(cli(moving, ["cleanup", "--apply", list.id, "--json"]), 0);
  expect(installer(s, ["--rollback"]), 2, /needs a transaction ID/);
  expect(installer(s, ["--rollback", "missing"]), 1, /no committed transaction/);
  expect(installer(s, ["--recover", "missing"]), 1, /no unfinished transaction/);
  // Relocate only system Node candidates in fixture copies; never hide or change host tools.
  const quote = (v) => "'" + v.replaceAll("'", "'\\''") + "'";
  for (const name of ["clean-development", "cd-hook"]) {
    const launcher = fs.readFileSync(path.join(plugin, "runtime/bin", name), "utf8")
      .replaceAll("/opt/homebrew/bin/node", quote(path.join(s.root, "missing-homebrew-node")))
      .replaceAll("/usr/local/bin/node", quote(path.join(s.root, "missing-local-node")));
    const file = mk(path.join(s.root, "launchers", name), launcher);
    const run = spawnSync("/bin/sh", [file, ...(name === "cd-hook" ? ["session-start", "claude"] : ["version"])], {
      cwd: s.root, env: { HOME: s.home, PATH: path.join(s.root, "no-node-on-path") }, encoding: "utf8", timeout: 15000
    });
    expect(run, name === "cd-hook" ? 0 : 127, /Node.js 20.12 or later not found/);
  }
  expect(spawnSync("/bin/sh", [path.join(plugin, "install.sh"), "--help"], {
    cwd: s.root, env: { ...s.env, CLEAN_DEV_NODE: path.join(s.root, "missing-node") }, encoding: "utf8", timeout: 15000
  }), 1, /CLEAN_DEV_NODE is not executable/);
  equalSet(codes, table(source(), "Exit codes", 2).map(([code]) => code), "contract exit codes");
});

test("contract report JSON includes all populated and unavailable branches", () => {
  const samples = { report: [], drive: [], measurement: [], routing: [], home: [] };
  for (const mounted of [true, false]) {
    const s = fixture(mounted);
    s.env = routed(s);
    mk(path.join(s.home, ".npm/cache"));
    mk(path.join(s.home, "dev/machine/state/clean-development/homes.txt"),
      `home ${s.home}/current claude ${VERSION} 123456abcdef 234567abcdef running-older\n`+
      `home ${s.home}/behind codex 0.7.1 - -\n`);
    s.env.npm_config_cache = path.join(s.home, "escaped");
    // In internal mode the absent external root supplies the error measurement shape.
    const before = snapshot(s.root);
    for (const args of [["report", "--json"], ["report", "--json", "--check"]]) {
      const result = json(cli(s, args), args.includes("--check") ? 1 : 0);
      samples.report.push(result); samples.drive.push(...result.drives);
      samples.measurement.push(...result.roots, ...result.caches); samples.routing.push(...result.routing);
      samples.home.push(...result.homes);
      if (args.includes("--check")) for (const name of ["roots", "drives", "caches"]) assert.deepEqual(result[name], []);
    }
    assert.deepEqual(snapshot(s.root), before);
  }
  checkShapes(samples);
});

test("contract cleanup JSON includes preview, move, failure and refusal branches", () => {
  const samples = { preview: [], item: [], apply: [], moved: [], failed: [], volume: [], refused: [] };
  const s = cleanupFixture();
  let result = json(cli(s, ["cleanup", "--json"]));
  samples.preview.push(result); samples.item.push(...result.items);
  assert.equal(result.items.length, 1);
  const before = snapshot(s.root);
  samples.refused.push(json(cli(s, ["cleanup", "--apply", "wrong", "--json"]), 3));
  assert.deepEqual(snapshot(s.root), before);
  for (const skip of ["0", "1,1", "2", "1,"]) assert.equal(cli(s, ["cleanup", "--apply", result.id, "--skip", skip]).status, 2);
  s.env.CONTRACT_FAIL_MOVE = s.candidate;
  const failed = json(cli(s, ["cleanup", "--apply", result.id, "--json"]), 1);
  samples.apply.push(failed); samples.failed.push(...failed.failed);
  delete s.env.CONTRACT_FAIL_MOVE;
  const skipped = json(cli(s, ["cleanup", "--apply", result.id, "--skip", "1", "--json"]));
  assert.deepEqual(skipped.moved, []); samples.apply.push(skipped);
  const moved = json(cli(s, ["cleanup", "--apply", result.id, "--json"]));
  samples.apply.push(moved); samples.moved.push(...moved.moved); samples.volume.push(...moved.volumes);
  assert.equal(moved.moved.length, 1);
  assert.ok(moved.moved[0].destination.startsWith(s.home + "/.Trash/"));
  assert.ok(fs.existsSync(moved.moved[0].manifest));
  samples.refused.push(json(cli(s, ["cleanup", "--apply", result.id, "--json"]), 3));
  mk(path.join(s.home, "dev/source/broken/.clean-development.json"), "{bad");
  result = json(cli(s, ["cleanup", "--json"]));
  assert.ok(result.skipped.length); samples.preview.push(result);
  checkShapes(samples);
});

test("contract routing export inventory and values in fixture shells", () => {
  const spec = entries("Routing exports"), observed = new Set();
  for (const mounted of [true, false]) for (const agent of [true, false]) {
    const s = fixture(mounted), ids = agent ? { CODEX_THREAD_ID: "019a2b3c-4d5e-7f60-8a9b-c0d1e2f3a4b5" } : {};
    const before = routed(s, ids, false);
    const result = routed(s, ids), R = mounted ? s.ext : s.int, M = path.join(s.home, "dev/machine");
    const key = agent ? "x-c0d1e2f3a4b5" : "shell";
    // zsh adds its own bookkeeping independently of env.zsh.
    for (const name of Object.keys(result)) if (!["PWD", "OLDPWD", "SHLVL", "_"].includes(name) && result[name] !== before[name]) observed.add(name);
    if (Object.hasOwn(result, "TMPDIR")) observed.add("TMPDIR");
    for (const [name, expression] of Object.entries(spec)) {
      if (name === "CLEAN_DEV_SCRATCH" && !agent) { assert.equal(result[name], undefined); continue; }
      let expected;
      switch (name) {
        case "CLEAN_DEV_VERSION": expected = VERSION; break;
        case "CLEAN_DEV_MODE": expected = mounted ? "external" : "internal"; break;
        case "CLEAN_DEV_STAMP": expected = `${mounted ? "external" : "internal"}|${R}|${agent ? key : ""}`; break;
        case "CLEAN_DEV_WORK": expected = mounted ? path.join(s.vol, "dev") : M; break;
        case "CLEAN_DEV_SCRATCH": expected = path.join(R, "scratch", key); break;
        case "TMPDIR": expected = agent ? path.join(R, "scratch", key, "tmp") : s.env.TMPDIR.startsWith("/Volumes/")
          ? spawnSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).stdout.trim() : s.env.TMPDIR; break;
        case "PATH": expected = `${M}/bin:/usr/bin:/bin`; break;
        default: expected = expression.replace(/\bLAB_ROOT\b/g, `${s.vol}/dev/lab`).replace(/\bMODELS_ROOT\b/g, `${s.vol}/models`)
          .replace(/\bEXTERNAL_VOLUME\b/g, "External").replace(/\bH\b/g, s.home).replace(/\bM\b/g, M).replace(/\bR\b/g, R).replace(/\bK\b/g, key);
      }
      assert.equal(result[name], expected, `contract routing ${name}`);
    }
  }
  equalSet(observed, Object.keys(spec), "contract routing exports");
  const s = fixture();
  for (const [id, accepted] of [["KEY1", false], ["12345678901", false], ["maintree0001", true],
    ["é123456789012", false], ["bad/123456789012", false], ["aaaaaaaa-to-be-unset", false],
    ["placeholder-123456789012", false], ["123456789012-STUB", false], ["123456789012_null_id", false],
    ["myplaceholder123", true], ["id-MixedCase123", true], ["123456789012-Stub", true]]) {
    const env = routed(s, { CODEX_THREAD_ID: id });
    assert.equal(!!env.CLEAN_DEV_SCRATCH, accepted, `agent id ${id}`);
    assert.equal(cli({ ...s, env }, ["report", "--check"]).status, 0);
  }
  const id = "019a2b3c-4d5e-7f60-8a9b-c0d1e2f3a4b5";
  assert.equal(routed(s, { CODEX_THREAD_ID: id, CLAUDE_CODE_SESSION_ID: "KEY1" }).CLEAN_DEV_SCRATCH, undefined);
  assert.match(routed(s, { CODEX_THREAD_ID: id, CLAUDE_CODE_SESSION_ID: "" }).CLEAN_DEV_SCRATCH, /x-c0d1e2f3a4b5$/);
  assert.match(routed(s, { CODEX_THREAD_ID: id, CLAUDE_CODE_SESSION_ID: id }).CLEAN_DEV_SCRATCH, /c-c0d1e2f3a4b5$/);
  const before = snapshot(s.root);
  routed(s, { DEV_ENV_INSPECT_ONLY: "1", CODEX_THREAD_ID: "inspect123456789" });
  assert.deepEqual(snapshot(s.root), before);
});

test("contract schema keys and types for both project versions", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(plugin, "schemas/project-config.schema.json")));
  const rows = table(source(), "Project schema", 3);
  equalSet(schema.oneOf.map((s) => String(s.properties.schemaVersion.const)), ["1", "2"], "contract schema versions");
  for (const branch of schema.oneOf) {
    const version = String(branch.properties.schemaVersion.const);
    assert.equal(branch.type, "object"); assert.equal(branch.additionalProperties, false);
    assert.deepEqual(branch.required, ["schemaVersion"]);
    const expected = Object.fromEntries(rows.filter(([v]) => v === "both" || v === version).map(([, key, type]) => [key, type]));
    const actual = Object.fromEntries(Object.entries(branch.properties).map(([key, p]) => [key,
      p.const !== undefined ? "integer (const 1 or 2 matching version)" : p.type === "array" ? `array of ${p.items.type}` : p.type || "any"]));
    assert.deepEqual(actual, expected, `contract schema v${version}`);
  }
});

test("contract hook command, envelope and context branches", () => {
  const command = fence(source(), "Hook command").trim();
  for (const harness of ["claude", "codex"]) {
    const fragment = JSON.parse(fs.readFileSync(path.join(plugin, `fragments/${harness}-hooks.json`)));
    assert.deepEqual(Object.keys(fragment.hooks), ["SessionStart"]);
    const [group] = fragment.hooks.SessionStart, [handler] = group.hooks;
    assert.equal(handler.command, command.replace("<claude|codex>", harness), "contract hook command");
    assert.equal(handler.timeout, 30); assert.equal(group.matcher, "startup|resume|clear|compact|fork");
    const s = fixture(), before = snapshot(s.root);
    for (const event of ["stop", "session-end", "unknown"]) {
      const result = hook(s, event, harness); assert.equal(result.status, 0); assert.equal(result.stdout, "");
    }
    const result = hook(s, "session-start", harness), data = json(result);
    assert.equal(result.stdout.trim().split("\n").length, 1);
    equalSet(Object.keys(data), ["hookSpecificOutput"], "hook envelope");
    equalSet(Object.keys(data.hookSpecificOutput), ["hookEventName", "additionalContext"], "hook output");
    assert.equal(data.hookSpecificOutput.hookEventName, "SessionStart");
    assert.equal(fence(source(), "Hook context").trim(), "clean-development: mode=<mode>; root=<root>; free=<N GB|unknown>");
    assert.match(data.hookSpecificOutput.additionalContext, new RegExp(`^clean-development: mode=internal; root=${s.int.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}; free=(?:[0-9.]+ GB|unknown)$`));
    assert.deepEqual(snapshot(s.root), before);
    fs.appendFileSync(s.config, "\nINTERNAL_MIN_FREE_GB=999999999\n");
    assert.match(json(hook(s, "session-start", harness)).hookSpecificOutput.additionalContext, /; cleanup available: ask to review candidates$/);
    fs.writeFileSync(s.config, "INVALID_KEY=1\n");
    assert.match(json(hook(s, "session-start", harness)).hookSpecificOutput.additionalContext, /; storage.conf problems: using internal defaults$/);
    assert.equal(json(hook({ ...s, env: { ...s.env, HOME: "/" } }, "session-start", harness)).hookSpecificOutput.additionalContext, "clean-development: storage context unavailable");
  }
});

test("contract install layout, records, locks and rollback paths", { skip: process.platform !== "darwin" && "Installer locks require Darwin APFS" }, () => {
  const s = fixture(), spec = entries("Install layout"), M = path.join(s.home, "dev/machine");
  const expand = (value) => value.replace(/^H(?=\/|$)/, s.home).replace(/^M(?=\/|$)/, M).replace(/\bV\b/g, VERSION);
  const at = (name) => { assert.ok(spec[name], `contract install entry: ${name}`); return expand(spec[name]); };
  const parent = path.join(s.root, "source"), src = path.join(parent, "clean-development");
  fs.mkdirSync(parent); fs.mkdirSync(src);
  // A fixture package excludes host sidecars, then declares every optional target explicitly.
  for (const name of ["runtime", "machine", "scripts", "fragments"]) fs.cpSync(path.join(plugin, name), path.join(src, name), { recursive: true });
  for (const name of ["installer.mjs", "install-lock.mjs"]) fs.copyFileSync(path.join(plugin, name), path.join(src, name));
  const sidecars = ["machine/env.private.zsh", "machine/clean-env-allow.list", "machine/clean-development/codex-homes.list",
    "machine/clean-development/claude-settings.list", "machine/clean-development/claude-profiles.list", "clean-development/machine/colima"];
  for (const relative of sidecars.filter((p) => !p.endsWith("/colima"))) fs.chmodSync(mk(path.join(parent, relative), "# fixture\n"), 0o600);
  fs.chmodSync(mk(path.join(parent, ".clean-development-private-sidecars.json"), JSON.stringify({ schemaVersion: 1, sidecars })), 0o600);
  fs.unlinkSync(s.config); // Exercise the source-policy installation path too, in internal mode only.
  mk(at("cli"), "previous launcher\n");
  let staged, held;
  const installed = installPackage(src, s.env, { config: true, onPhase: (phase) => {
    if (phase === "staged") {
      staged = fs.readdirSync(path.dirname(at("release"))).find((name) => name.includes(".installing-"));
      held = fs.existsSync(at("install-lock"));
    }
  } });
  const receipt = JSON.parse(fs.readFileSync(installed.receipt)), T = receipt.id;
  assert.equal(installed.runtime, at("release"), "contract release path");
  for (const entry of ["rollback-installer", "rollback-lock-module"]) {
    assert.ok(fs.existsSync(at(entry)), `contract installed ${entry}`);
    assert.ok(fs.statSync(at(entry)).isFile(), `contract installed ${entry}`);
  }
  assert.equal(installed.receipt, at("receipt").replace(/\bT\b/g, T), "contract receipt path");
  assert.equal(installed.rollbackRecord, at("record").replace(/\bT\b/g, T).replace(/\bF\b/g, "none"), "contract rollback path");
  assert.equal(path.join(path.dirname(installed.runtime), staged), at("staging").replace(/\bT\b/g, T), "contract staging path");
  assert.ok(held); assert.equal(fs.existsSync(at("install-lock")), false);
  const targets = ["cli", "hook", "environment", "policy", "claude", "codex", ...Object.keys(spec).filter((name) => name.startsWith("optional-"))];
  equalSet(installed.files, targets.map(at), "contract activation paths");
  for (const target of targets) assert.ok(fs.statSync(at(target)).isFile(), `contract installed ${target}`);
  assert.ok(fs.existsSync(at("backup").replace(/\bT\b/g, T).replace(/\bI\b/g, "0")));
  assert.ok(fs.lstatSync(path.dirname(path.dirname(at("hook")))).isDirectory());
  assert.ok(fs.readFileSync(at("hook"), "utf8").includes(`rt='${at("release")}'`));
  for (const sub of ["deps", "builds", "scratch", "trash"]) assert.ok(fs.statSync(path.join(s.int, sub)).isDirectory());
  const recordText = fs.readFileSync(installed.rollbackRecord, "utf8");
  assert.match(recordText, /Source commit: unavailable \(source is not a Git checkout\)/);
  assert.ok(recordText.includes(`'${at("rollback-installer")}' --rollback '${T}'`));
  const again = installPackage(src, s.env, { config: true, recordDir: path.join(s.root, "custom-records") });
  assert.equal(path.dirname(again.rollbackRecord), path.join(s.root, "custom-records"));
  assert.notEqual(installed.receipt, again.receipt);
  // Check the guard/log location while a deliberately stranded dead legacy lock is recovered.
  mk(at("install-lock"), JSON.stringify({ pid: 2147483647, token: "contract-dead-owner", acquiredAt: new Date().toISOString() }));
  const run = spawnSync(process.execPath, [path.join(src, "installer.mjs"), "--rollback", JSON.parse(fs.readFileSync(again.receipt)).id], {
    cwd: s.root, env: s.env, encoding: "utf8", timeout: 30000
  });
  assert.equal(run.status, 0, run.stderr); assert.match(run.stderr, /install.lock recovered explicitly/);
  assert.ok(fs.existsSync(at("log"))); assert.equal(fs.existsSync(at("recovery-lock")), false);
  const retry = spawnSync(process.execPath, [path.join(src, "installer.mjs"), "--rollback", JSON.parse(fs.readFileSync(again.receipt)).id], {
    cwd: s.root, env: s.env, encoding: "utf8", timeout: 30000
  });
  assert.equal(retry.status, 1); assert.match(retry.stderr, /no committed transaction/);
});

test("contract negative fixture copies reject each kind of drift", () => {
  const mutations = [
    ["CLI usage", "  version\n", "  changed-version\n", "CLI usage"],
    ["exit codes", "| 3 | Cleanup", "| 4 | Cleanup", "exit codes"],
    ["report JSON", "| report | mode,", "| report | renamed_mode,", "JSON report: unexpected mode"],
    ["report JSON", "caches, homes, errors |", "caches, errors |", "JSON report: unexpected homes"],
    ["report JSON", "| home | path,", "| home | renamed_path,", "JSON home: unexpected path"],
    ["cleanup JSON", "| preview | mode,", "| preview | renamed_mode,", "JSON preview: unexpected mode"],
    ["routing export", "| DEVCACHE | R |", "| RENAMED_CACHE | R |", "routing RENAMED_CACHE"],
    ["schema keys", "| 2 | heavy |", "| 2 | renamed_heavy |", "schema v2"],
    ["hook command", "cd-hook\" session-start <", "cd-hook\" renamed-start <", "hook command"],
    ["install layout", "| cli | M/bin/clean-development |", "| cli | M/bin/renamed-cli |", "activation paths"],
    ["install layout", "| rollback-lock-module | M/runtime/clean-development/V/install-lock.mjs |",
      "| rollback-lock-module | M/runtime/clean-development/V/missing-lock.mjs |", "contract installed rollback-lock-module"]
  ];
  for (const [pattern, from, to, diagnostic] of mutations) {
    if (pattern === "install layout" && process.platform !== "darwin") continue;
    const s = fixture(), original = source();
    assert.ok(original.includes(from), `mutation anchor: ${pattern}`);
    const file = mk(path.join(s.root, "CONTRACT.md"), original.replace(from, to));
    const childEnv = { ...process.env, CLEAN_DEV_CONTRACT_FILE: file };
    delete childEnv.NODE_TEST_CONTEXT; // A fresh test runner, not Node's inherited child-test context.
    const run = spawnSync(process.execPath, ["--test", `--test-name-pattern=contract ${pattern}`, self], {
      cwd: s.root, env: childEnv, encoding: "utf8", timeout: 90000
    });
    assert.equal(run.status, 1, `negative ${pattern}: expected test failure\n${run.stdout}\n${run.stderr}`);
    assert.ok(run.stdout.includes(diagnostic), `negative ${pattern}: wrong failure\n${run.stdout}`);
    console.log(`negative drift ${pattern}: exit ${run.status}; ${diagnostic}`);
  }
});


test("contract participates in the standalone document guard", () => {
  // A containing monorepo whose marketplace name is private: the package documents must not use it.
  const s = fixture(), top = path.join(s.root, "monorepo"), root = path.join(top, "clean-development");
  const file = mk(path.join(root, "CONTRACT.md"), source());
  mk(path.join(top, "README.md"), "# Example monorepo\n");
  mk(path.join(top, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "example-private" }));
  const scan = () => spawnSync(process.execPath, [path.join(plugin, "scripts/check-standalone.mjs"), root], {
    cwd: s.root, env: s.env, encoding: "utf8", timeout: 15000
  });
  const good = scan();
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /1 package documents/);
  fs.appendFileSync(file, "\nprivate example-private reference\n");
  const bad = scan();
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /CONTRACT.md:.*private-marketplace/);
  console.log("negative standalone: exit 1; CONTRACT.md: private-marketplace");
});
