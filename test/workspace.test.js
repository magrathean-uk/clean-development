import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { detectStack, identifyWorkspace, MANIFESTS } from "../src/workspace.js";
import { withoutCleanDevelopmentEnvironment } from "../scripts/harness-utils.mjs";

// Identity is a slug plus a hash of the canonical workspace path, not the
// spelling used to reach it or its shared Git metadata. Discover ancestors of
// the physical directory while preserving the command's lexical effectiveCwd.
// Stack discovery stops at Git/home boundaries; tool identity retains its
// manifest-first/Git-fallback policy. Cargo's explicit resolved root wins.
// Do not case-fold or Unicode-normalize distinct native filesystem paths.
function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "clean-workspace-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function directory(...parts) {
  const value = path.join(...parts);
  fs.mkdirSync(value, { recursive: true });
  return value;
}

function manifest(root, name, content = "{}\n") {
  directory(root);
  fs.writeFileSync(path.join(root, name), content);
}

function link(t, target, alias) {
  try {
    fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
    t.skip(`Directory links unavailable: ${error.code}`);
    return false;
  }
}

function snapshot(root) {
  const result = [];
  function visit(current) {
    for (const name of fs.readdirSync(current).sort()) {
      const file = path.join(current, name);
      const stat = fs.lstatSync(file);
      const kind = stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "directory" : "file";
      result.push([path.relative(root, file), kind, stat.mode,
        kind === "link" ? fs.readlinkSync(file) : kind === "file" ? fs.readFileSync(file).toString("hex") : null]);
      if (kind === "directory") visit(file);
    }
  }
  visit(root);
  return result;
}

function assertRoot(actual, expected) {
  const canonical = fs.realpathSync.native(expected);
  assert.equal(actual.root, canonical);
  const digest = crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 10);
  // SwiftPM retains a longer digest of the same canonical path.
  assert.match(actual.id, new RegExp(`^[a-z0-9-]+-${digest}(?:[0-9a-f]{6})?$`));
}

for (const [tool, patterns] of Object.entries(MANIFESTS)) {
  test(`${tool}: root and subdirectory aliases keep the physical workspace identity`, (t) => {
    const root = fixture(t);
    const project = directory(root, "physical", "café-東京");
    const nested = directory(project, "src", "deep");
    const unrelated = directory(root, "unrelated");
    const content = tool === "cargo" ? "[workspace]\n" : "{}\n";
    manifest(project, patterns[0], content);
    manifest(unrelated, patterns[0], content);
    const rootAlias = path.join(unrelated, "root-alias");
    const nestedAlias = path.join(unrelated, "nested-alias");
    if (!link(t, project, rootAlias) || !link(t, nested, nestedAlias)) return;
    const before = snapshot(root);
    // A bare `swift` is passthrough; identity is defined for package commands.
    const args = Object.freeze(tool === "swift" ? ["build"] : []);
    const expected = identifyWorkspace(tool, args, project);
    assertRoot(expected, project);
    for (const cwd of [nested, rootAlias, nestedAlias, path.relative(process.cwd(), nestedAlias)]) {
      const actual = identifyWorkspace(tool, args, cwd);
      assertRoot(actual, project);
      assert.equal(actual.id, expected.id, cwd);
      assert.equal(actual.effectiveCwd, path.resolve(cwd), "discovery must not rewrite effectiveCwd");
    }
    assert.deepEqual(snapshot(root), before);
  });
}

test("stack evidence follows a subdirectory alias, not the alias parent's manifests", (t) => {
  const root = fixture(t);
  const project = directory(root, "physical");
  const nested = directory(project, "src");
  const unrelated = directory(root, "unrelated");
  manifest(project, "package.json", '{"packageManager":"pnpm@9.0.0"}\n');
  manifest(project, "pnpm-lock.yaml", "lockfileVersion: 9\n");
  manifest(unrelated, "composer.json");
  const alias = path.join(unrelated, "alias");
  if (!link(t, nested, alias)) return;
  const before = snapshot(root);
  const expected = detectStack(nested, { home: root });
  assert.equal(expected.root, project);
  assert.deepEqual(expected.tools, ["pnpm"]);
  assert.deepEqual(detectStack(alias, { home: root }), expected);
  assert.deepEqual(snapshot(root), before);
});

test("home boundary uses the same canonical spelling as the discovery start", (t) => {
  const root = fixture(t);
  const home = directory(root, "home");
  const project = directory(home, "Projects", "unmarked");
  manifest(home, "package.json");
  const alias = path.join(root, "home-alias");
  if (!link(t, home, alias)) return;
  const before = snapshot(root);
  for (const cwd of [project, path.join(alias, "Projects", "unmarked")]) {
    for (const selectedHome of [home, alias]) {
      const actual = detectStack(cwd, { home: selectedHome });
      assert.equal(actual.root, project);
      assert.deepEqual(actual.tools, []);
    }
  }
  assert.deepEqual(detectStack(alias, { home }).tools, ["npm", "npx"]);
  assert.deepEqual(snapshot(root), before);
});

for (const marker of ["directory", "file"]) {
  test(`Git ${marker} boundary and fallback follow physical ancestors through aliases`, (t) => {
    const root = fixture(t);
    manifest(root, "package.json");
    const project = directory(root, "checkout");
    const nested = directory(project, "src");
    if (marker === "directory") directory(project, ".git");
    else manifest(project, ".git", "gitdir: ../metadata\n");
    const alias = path.join(root, "alias");
    if (!link(t, nested, alias)) return;
    const before = snapshot(root);
    const detected = detectStack(alias, { home: root });
    assert.equal(detected.root, project);
    assert.deepEqual(detected.tools, []);
    const identity = identifyWorkspace("unknown-tool", [], alias);
    assertRoot(identity, project);
    assert.equal(identity.id, identifyWorkspace("unknown-tool", [], nested).id);
    // Git is not a new hard stop for tool-specific manifest selection.
    assertRoot(identifyWorkspace("npm", [], alias), root);
    assert.deepEqual(snapshot(root), before);
  });
}

test("nested manifests keep nearest-tool and enclosing-Cargo-workspace precedence", (t) => {
  const root = fixture(t);
  const workspace = directory(root, "workspace");
  const member = directory(workspace, "crates", "member");
  const second = directory(workspace, "crates", "second");
  manifest(workspace, "Cargo.toml", '[workspace]\nmembers = ["crates/*"]\n');
  for (const project of [member, second]) manifest(project, "Cargo.toml", '[package]\nname="member"\nversion="0.1.0"\n');
  manifest(workspace, "package.json");
  manifest(member, "package.json");
  manifest(workspace, "global.json");
  manifest(member, "Nested.csproj", "<Project />\n");
  const deep = directory(member, "src");
  const before = snapshot(root);
  assertRoot(identifyWorkspace("npm", [], deep), member);
  assertRoot(identifyWorkspace("dotnet", [], deep), member);
  assertRoot(identifyWorkspace("cargo", [], deep), workspace);
  assert.equal(identifyWorkspace("cargo", [], member).id, identifyWorkspace("cargo", [], second).id);
  assert.equal(detectStack(deep, { home: root }).root, member);
  assert.deepEqual(snapshot(root), before);
  manifest(member, "Cargo.toml", "[package]\nname='standalone'\nversion='0.1.0'\n[workspace]\n");
  assertRoot(identifyWorkspace("cargo", [], deep), member);
});

test("relative directory options use the supplied cwd without changing args or effectiveCwd", (t) => {
  const root = fixture(t);
  const caller = directory(root, "caller");
  const project = directory(root, "physical", "destination");
  const nested = directory(project, "src");
  const unrelated = directory(root, "unrelated");
  for (const location of [caller, project, unrelated]) {
    manifest(location, "package.json");
    manifest(location, "go.mod", "module example.invalid/fixture\n");
    manifest(location, "Cargo.toml", "[workspace]\n");
  }
  const alias = path.join(unrelated, "alias");
  if (!link(t, nested, alias)) return;
  const relative = path.relative(caller, alias);
  const before = snapshot(root);
  for (const [tool, flags] of [
    ["npm", ["--prefix", relative]], ["npx", [`--prefix=${relative}`]],
    ["pnpm", ["--dir", relative]], ["yarn", ["-C", relative]],
    ["go", ["-C", relative]], ["go", [`-C${relative}`]],
    ["cargo", ["-C", relative]], ["cargo", [`-C=${relative}`]]
  ]) {
    const args = Object.freeze([...flags, "--version"]);
    const actual = identifyWorkspace(tool, args, caller);
    assertRoot(actual, project);
    assert.equal(actual.effectiveCwd, alias);
    assert.deepEqual(args, [...flags, "--version"]);
    assertRoot(identifyWorkspace(tool, ["--", ...flags], caller), caller);
  }
  const manifestArgs = Object.freeze(["-C", path.relative(caller, project), "--manifest-path", "Cargo.toml"]);
  assertRoot(identifyWorkspace("cargo", manifestArgs, caller), project);
  assert.deepEqual(snapshot(root), before);
});

test("an authoritative Cargo root overrides static discovery and is canonicalised", (t) => {
  const root = fixture(t);
  const caller = directory(root, "caller");
  const selected = directory(root, "selected");
  manifest(caller, "Cargo.toml", "[workspace]\n");
  const alias = path.join(root, "selected-alias");
  if (!link(t, selected, alias)) return;
  const before = snapshot(root);
  const args = Object.freeze(["check"]);
  const actual = identifyWorkspace("cargo", args, caller, { root: alias });
  assertRoot(actual, selected);
  assert.equal(actual.effectiveCwd, caller);
  assert.deepEqual(snapshot(root), before);
});

test("default cwd is re-evaluated after chdir, with relative and dot-segment spellings", (t) => {
  const root = fixture(t);
  const first = directory(root, "one", "checkout");
  const second = directory(root, "two", "checkout");
  for (const project of [first, second]) {
    manifest(project, "package.json");
    directory(project, "src");
  }
  const moduleUrl = new URL("../src/workspace.js", import.meta.url).href;
  const script = `
    import { identifyWorkspace } from ${JSON.stringify(moduleUrl)};
    const values = [];
    for (const cwd of ${JSON.stringify([path.join(first, "src"), path.join(second, "src"), root])}) {
      process.chdir(cwd);
      values.push(identifyWorkspace("npm", [], cwd === ${JSON.stringify(root)} ? "./one/checkout/src/../src/." : undefined));
    }
    console.log(JSON.stringify(values));
  `;
  const before = snapshot(root);
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: root, encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const [a, b, again] = JSON.parse(result.stdout);
  assertRoot(a, first);
  assertRoot(b, second);
  assert.notEqual(a.id, b.id);
  assert.equal(a.id, again.id);
  assert.deepEqual(snapshot(root), before);
});

test("real linked worktrees sharing Git metadata and a commit retain separate identities", (t) => {
  const root = fixture(t);
  const home = directory(root, "home");
  const empty = directory(root, "empty");
  const env = Object.fromEntries(Object.entries(withoutCleanDevelopmentEnvironment()).filter(([key]) => !/^GIT_/i.test(key)));
  Object.assign(env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(home, "empty-config") });
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL, "");
  const version = spawnSync("git", ["--version"], { env, encoding: "utf8", timeout: 10000 });
  if (version.error?.code === "ENOENT") return t.skip("Git is unavailable");
  assert.equal(version.status, 0, version.stderr || version.error?.message);
  const git = (args) => {
    const result = spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "-c", `core.hooksPath=${empty}`, ...args], { cwd: root, env, encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout.trim();
  };
  const main = directory(root, "main", "checkout");
  git(["init", `--template=${empty}`, main]);
  git(["-C", main, "commit", "--allow-empty", "-m", "Disposable identity fixture"]);
  const linked = path.join(directory(root, "linked"), "checkout");
  git(["-C", main, "worktree", "add", "--detach", linked, "HEAD"]);
  assert.equal(git(["-C", main, "rev-parse", "HEAD"]), git(["-C", linked, "rev-parse", "HEAD"]));
  assert.equal(fs.lstatSync(path.join(main, ".git")).isDirectory(), true);
  assert.equal(fs.lstatSync(path.join(linked, ".git")).isFile(), true);
  const common = git(["-C", linked, "rev-parse", "--git-common-dir"]);
  assert.equal(fs.realpathSync.native(path.resolve(linked, common)), path.join(main, ".git"));
  for (const project of [main, linked]) directory(project, "src");
  const before = snapshot(root);
  for (const project of [main, linked]) assertRoot(identifyWorkspace("unknown-tool", [], path.join(project, "src")), project);
  assert.notEqual(identifyWorkspace("unknown-tool", [], main).id, identifyWorkspace("unknown-tool", [], linked).id);
  assert.deepEqual(snapshot(root), before);
  for (const project of [main, linked]) manifest(project, "Cargo.toml", "[workspace]\n");
  const withManifests = snapshot(root);
  for (const project of [main, linked]) assertRoot(identifyWorkspace("cargo", [], path.join(project, "src")), project);
  assert.notEqual(identifyWorkspace("cargo", [], main).id, identifyWorkspace("cargo", [], linked).id);
  assert.deepEqual(snapshot(root), withManifests);
});

test("Unicode and identical readable slugs do not collapse distinct root paths", (t) => {
  const root = fixture(t);
  const ids = [];
  for (const name of ["café", "cafè", "東京", "大阪"]) {
    const project = directory(root, name);
    manifest(project, "package.json");
    const actual = identifyWorkspace("npm", [], project);
    assertRoot(actual, project);
    assert.match(actual.id, name.startsWith("caf") ? /^caf-/ : /^workspace-/);
    ids.push(actual.id);
  }
  assert.equal(new Set(ids).size, ids.length);
});

for (const [kind, first, second] of [["case", "Checkout", "checkout"], ["Unicode normalization", "café", "cafe\u0301"]]) {
  test(`${kind}-distinct paths remain distinct when supported by the native filesystem`, (t) => {
    const root = fixture(t);
    const a = directory(root, first);
    const b = path.join(root, second);
    try {
      fs.mkdirSync(b);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      return t.skip(`Filesystem aliases these ${kind} spellings; no cross-platform folding claim`);
    }
    for (const project of [a, b]) manifest(project, "package.json");
    const firstIdentity = identifyWorkspace("npm", [], a);
    const secondIdentity = identifyWorkspace("npm", [], b);
    assertRoot(firstIdentity, a);
    assertRoot(secondIdentity, b);
    assert.notEqual(firstIdentity.id, secondIdentity.id);
  });
}

test("POSIX backslashes are literal filename characters, not Windows separators", { skip: process.platform === "win32" }, (t) => {
  const root = fixture(t);
  const literal = directory(root, "workspace\\component");
  const nested = directory(root, "workspace", "component");
  for (const project of [literal, nested]) manifest(project, "package.json");
  assertRoot(identifyWorkspace("npm", [], literal), literal);
  assert.notEqual(identifyWorkspace("npm", [], literal).id, identifyWorkspace("npm", [], nested).id);
});

test("Windows slash and backslash spellings share native identity", { skip: process.platform !== "win32" }, (t) => {
  const root = fixture(t);
  const project = directory(root, "checkout");
  const nested = directory(project, "src");
  manifest(project, "package.json");
  const expected = identifyWorkspace("npm", [], nested);
  assertRoot(expected, project);
  assert.equal(identifyWorkspace("npm", [], nested.replace(/\\/g, "/")).id, expected.id);
});

test("missing subdirectories retain read-only nearest-manifest fallback", (t) => {
  const root = fixture(t);
  const project = directory(root, "checkout");
  manifest(project, "package.json");
  const missing = path.join(project, "not-created", "child");
  const before = snapshot(root);
  assertRoot(identifyWorkspace("npm", [], missing), project);
  assert.equal(detectStack(missing, { home: root }).root, project);
  assert.deepEqual(snapshot(root), before);
});
