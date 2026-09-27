import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assertSafeManagedRoot, canonicalizePotentialPath, isPathInside } from "./platform.js";

// A deliberately bounded SwiftPM grammar, not a Swift compiler/plugin parser.
// Unknown build/test options fail before storage preparation when opted in.
const VALUES = new Set([
  "--package-path", "--scratch-path", "--build-path", "--cache-path", "--config-path", "--security-path",
  "--swift-sdks-path", "--experimental-swift-sdks-path", "--toolset", "--pkg-config-path", "--manifest-cache",
  "--netrc-file", "--resolver-fingerprint-checking", "--resolver-signing-entity-checking", "--default-registry-url",
  "-c", "--configuration", "--triple", "--sdk", "--toolchain", "--swift-sdk", "--destination", "--arch",
  "-j", "--jobs", "--product", "--target", "--sanitize", "--index-store-mode", "--build-system",
  "--explicit-target-dependency-import-check", "--link-time-optimization", "--debug-info-format", "-debug-info-format",
  "--sbom-spec", "--sbom-output-dir", "--sbom-filter",
  "--traits", "--num-workers", "--filter", "--skip", "-s", "--specifier", "--xunit-output", "--attachments-path",
  "-Xcc", "-Xcxx", "-Xswiftc", "-Xlinker", "-Xmanifest", "-Xbuild-tools-swiftc"
]);
const FLAGS = new Set([
  "--sbom-warning-only", "--enable-keychain", "--disable-keychain", "--auto-index-store",
  "--enable-parseable-module-interfaces", "--enable-coverage", "--disable-coverage", "--print-pif-manifest-graph",
  "-v", "--verbose", "--very-verbose", "--vv", "-q", "--quiet", "--disable-sandbox", "--netrc",
  "--enable-netrc", "--disable-netrc", "--enable-signature-validation", "--disable-signature-validation",
  "--enable-dependency-cache", "--disable-dependency-cache", "--enable-build-manifest-caching", "--disable-build-manifest-caching",
  "--enable-experimental-prebuilts", "--disable-experimental-prebuilts", "--disable-package-manifest-caching",
  "--color-diagnostics", "--no-color-diagnostics", "--enable-prefetching", "--disable-prefetching",
  "--force-resolved-versions", "--disable-automatic-resolution", "--only-use-versions-from-resolved-file", "--skip-update",
  "--disable-scm-to-registry-transformation", "--use-registry-identity-for-scm", "--replace-scm-with-registry",
  "--enable-code-coverage", "--disable-code-coverage", "--build-tests", "--show-bin-path", "--print-manifest-job-graph",
  "--enable-index-store", "--disable-index-store", "--static-swift-stdlib", "--no-static-swift-stdlib",
  "--use-integrated-swift-driver", "--explicit-module-build", "--enable-dead-strip", "--disable-dead-strip",
  "--disable-local-rpath", "--enable-all-traits", "--disable-default-traits", "--skip-build", "--parallel", "--no-parallel",
  "--enable-xctest", "--disable-xctest", "--enable-swift-testing", "--disable-swift-testing", "--enable-test-discovery",
  "--enable-testable-imports", "--disable-testable-imports", "-l", "--list-tests", "--show-codecov-path",
  "--show-code-coverage-path", "--show-coverage-path"
]);
const HELP = new Set(["-h", "-help", "--help", "--version"]);
const PATH_OPTIONS = new Set(["--package-path", "--scratch-path", "--build-path", "--cache-path"]);
const MARKER = ".clean-development-swiftpm.json";

function failure(message) {
  return Object.assign(new Error(`SwiftPM routing: ${message}. Use --session skip for an unchanged native invocation.`), { code: "ERR_SWIFTPM_ROUTING" });
}

export function inspectSwiftpmCommand(args) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) throw failure("arguments must be strings without NUL bytes");
  const result = { command: args[0] || null, passthrough: !["build", "test"].includes(args[0]), paths: {}, outputs: [], error: null };
  if (result.passthrough) return result;
  if (args.length > 512) { result.error = "argument inspection limit exceeded"; return result; }
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index], equal = arg.indexOf("="), key = equal < 0 ? arg : arg.slice(0, equal);
    if (HELP.has(arg)) { result.passthrough = true; return result; }
    // No positional arguments are supported by this build/test adapter. A child
    // option after -- cannot be reinterpreted as a package selector.
    if (arg === "--" && index === args.length - 1) break;
    if (VALUES.has(key)) {
      const value = equal < 0 ? args[++index] : arg.slice(equal + 1);
      if (value === undefined || value === "" || (PATH_OPTIONS.has(key) && value.startsWith("-"))) {
        result.error = `missing or ambiguous value for ${key}`; break;
      }
      if (PATH_OPTIONS.has(key)) {
        if (Object.hasOwn(result.paths, key)) { result.error = `duplicate ${key}`; break; }
        result.paths[key] = value;
      }
      if (["--xunit-output", "--attachments-path", "--sbom-output-dir"].includes(key)) result.outputs.push({ option: key, path: value, disposition: "user-deliverable; unchanged" });
    } else if (!FLAGS.has(arg)) {
      result.error = "unrecognised build/test argument (including response files or multi-root workspace options)"; break;
    }
  }
  return result;
}

export function swiftpmWorkspace(args, cwd) {
  const invocation = inspectSwiftpmCommand(args);
  const effectiveCwd = path.resolve(cwd, invocation.paths["--package-path"] || ".");
  const configCwd = canonicalizePotentialPath(effectiveCwd);
  let root = configCwd, manifest = null;
  if (!invocation.passthrough) {
    for (let current = root; ; current = path.dirname(current)) {
      const candidate = path.join(current, "Package.swift");
      try { fs.lstatSync(candidate); root = current; manifest = candidate; break; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (path.dirname(current) === current) break;
    }
  }
  const slug = path.basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "package";
  const id = `swiftpm-${slug}-${crypto.createHash("sha256").update(root).digest("hex").slice(0, 16)}`;
  return { id, root, effectiveCwd, configCwd, manifest, invocation };
}

const overlaps = (a, b) => a === b || isPathInside(a, b) || isPathInside(b, a);
const nativeEnvironmentPresent = (env, name) => Object.keys(env).some((key) => key.toLowerCase() === name.toLowerCase() && env[key] !== undefined);

/** Read-only command-local plan. Scratch contains products AND intermediates;
 * it is retained separately, never registered with Cargo's disposable storage. */
export function planSwiftpm(args, { config, cwd, env, workspace = swiftpmWorkspace(args, cwd), projectRoots = [] }) {
  const { invocation } = workspace;
  const result = { status: "passthrough", additions: [], scratch: { path: null, disposition: "native; unchanged" },
    cache: { path: null, disposition: "native; unchanged" }, outputs: [...invocation.outputs], workspace };
  if (config.enabled === false || config.tools?.swift !== true || invocation.passthrough) return result;
  if (invocation.error) throw failure(invocation.error);
  if (!fs.statSync(workspace.configCwd).isDirectory()) throw failure("package selection is not an existing directory");
  if (!workspace.manifest || !fs.statSync(workspace.manifest).isFile()) throw failure("no regular Package.swift at the selected package");
  const nativeScratch = invocation.paths["--scratch-path"] !== undefined || invocation.paths["--build-path"] !== undefined
    || nativeEnvironmentPresent(env, "SWIFTPM_BUILD_DIR");
  if (nativeScratch) result.scratch.disposition = "explicit native flag/environment; unchanged, not owned";
  else if (config.swiftpmWorkspaceRoot) {
    const base = assertSafeManagedRoot(config.swiftpmWorkspaceRoot, env);
    const home = canonicalizePotentialPath(config.locations.home);
    const sources = [workspace.root, cwd, ...projectRoots].map(canonicalizePotentialPath).filter((root) => root !== home);
    const protectedPaths = [config.root, config.cacheRoot, config.buildRoot, config.scratchRoot,
      config.locations.dataDir, config.locations.configDir, ...sources].map(canonicalizePotentialPath);
    if (protectedPaths.some((directory) => overlaps(base, directory))) throw failure("retained workspace root must be disjoint from source, disposable storage and application data");
    // Existing historical Cargo ownership must not make these retained products
    // deletable even when the currently configured disposable roots have moved.
    for (let current = base; ; current = path.dirname(current)) {
      try { fs.lstatSync(path.join(current, ".clean-development-owned.json")); throw failure("retained workspace root is within an owned Cargo build"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (path.dirname(current) === current) break;
    }
    result.scratch = { path: path.join(base, workspace.id, "scratch"), base, disposition: "retained products and intermediates; never pruned" };
    result.additions.push("--scratch-path", result.scratch.path);
  }
  // SWIFTPM_CACHE_PATH is not a portable documented interface. A caller setting
  // it still gets an untouched native cache selection, not a guessed override.
  if (invocation.paths["--cache-path"] !== undefined) {
    result.cache.disposition = "explicit native flag; unchanged, not owned";
  } else if (nativeEnvironmentPresent(env, "SWIFTPM_CACHE_PATH")) {
    result.cache.disposition = "unverified caller environment setting; native selection unchanged";
  } else {
    result.cache = { path: path.join(config.cacheRoot, "swiftpm"), base: config.cacheRoot, disposition: "shared cache; no Clean Development eviction" };
    result.additions.push("--cache-path", result.cache.path);
  }
  result.status = result.additions.length ? "predicted" : "passthrough";
  return result;
}

function realDirectory(directory) {
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync.native(directory) !== directory) throw failure("storage path is not a canonical real directory");
  return info;
}

function childDirectory(parent, child) {
  realDirectory(parent);
  try { fs.mkdirSync(child, { mode: 0o700 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  realDirectory(child);
}

function verifyMarker(directory, workspace) {
  const file = path.join(directory, MARKER);
  let fd;
  try {
    const before = fs.lstatSync(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size > 8192n) throw failure("missing or invalid retained workspace marker");
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const same = (value) => value.isFile() && !value.isSymbolicLink() && ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every((key) => value[key] === before[key]);
    if (!same(fs.fstatSync(fd, { bigint: true }))) throw failure("retained workspace marker changed");
    const buffer = Buffer.alloc(8193);
    let length = 0;
    while (length < buffer.length) { const count = fs.readSync(fd, buffer, length, buffer.length - length, length); if (!count) break; length += count; }
    if (length > 8192 || !same(fs.fstatSync(fd, { bigint: true })) || !same(fs.lstatSync(file, { bigint: true }))) throw failure("retained workspace marker changed");
    const value = JSON.parse(buffer.toString("utf8", 0, length));
    if (value.schemaVersion !== 1 || value.owner !== "clean-development-swiftpm" || value.workspaceId !== workspace.id || value.packageRoot !== workspace.root) throw failure("unowned retained workspace; no adoption or repair attempted");
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** Dispatch only. Base directories must already exist; never recreate a missing
 * volume or delete an incomplete workspace. SwiftPM retains its native locking. */
export function prepareSwiftpm(plan) {
  // Validate every required base before making any changes.
  for (const item of [plan.scratch, plan.cache]) if (item.path) realDirectory(item.base);
  if (plan.scratch.path) {
    const parent = path.dirname(plan.scratch.path);
    let created = false;
    realDirectory(plan.scratch.base);
    try { fs.mkdirSync(parent, { mode: 0o700 }); created = true; }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    realDirectory(parent);
    if (created) {
      fs.writeFileSync(path.join(parent, MARKER), JSON.stringify({ schemaVersion: 1, owner: "clean-development-swiftpm",
        workspaceId: plan.workspace.id, packageRoot: plan.workspace.root }) + "\n", { flag: "wx", mode: 0o600 });
    }
    verifyMarker(parent, plan.workspace);
    childDirectory(parent, plan.scratch.path);
  }
  if (plan.cache.path) childDirectory(plan.cache.base, plan.cache.path);
}
