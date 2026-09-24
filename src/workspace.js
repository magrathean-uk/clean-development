import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MANIFESTS = {
  cargo: ["Cargo.toml"],
  go: ["go.work", "go.mod"],
  npm: ["package.json"],
  npx: ["package.json"],
  pnpm: ["pnpm-workspace.yaml", "package.json"],
  yarn: ["package.json"],
  bun: ["package.json"],
  uv: ["pyproject.toml", "uv.lock"],
  pip: ["pyproject.toml", "requirements.txt", "setup.py"],
  pip3: ["pyproject.toml", "requirements.txt", "setup.py"],
  dotnet: ["global.json", "*.sln", "*.csproj"],
  composer: ["composer.json"]
};

const NODE_LOCKFILES = Object.freeze({
  npm: ["package-lock.json", "npm-shrinkwrap.json"],
  pnpm: ["pnpm-lock.yaml"],
  yarn: ["yarn.lock"],
  bun: ["bun.lock", "bun.lockb"]
});

function directoryNames(directory) {
  try {
    return fs.readdirSync(directory);
  } catch {
    return [];
  }
}

function projectEvidence(names) {
  return [
    "Cargo.toml", "go.work", "go.mod", "package.json", "pyproject.toml", "uv.lock",
    "requirements.txt", "setup.py", "global.json", "composer.json", "pnpm-workspace.yaml"
  ].some((name) => names.includes(name)) || names.some((name) => name.endsWith(".sln") || name.endsWith(".csproj"));
}

function nearestProjectRoot(start, home = os.homedir()) {
  const resolvedStart = path.resolve(start);
  const resolvedHome = path.resolve(home);
  const startsBelowHome = resolvedStart !== resolvedHome && resolvedStart.startsWith(`${resolvedHome}${path.sep}`);
  let current = resolvedStart;
  while (true) {
    // A manifest in the user's home describes commands run from home itself. It
    // must not absorb unrelated workspaces below home that have no root marker.
    if (startsBelowHome && current === resolvedHome) {
      return { root: resolvedStart, names: directoryNames(resolvedStart) };
    }
    const names = directoryNames(current);
    if (projectEvidence(names)) return { root: current, names };
    if (names.includes(".git")) return { root: current, names };
    const parent = path.dirname(current);
    if (parent === current) return { root: path.resolve(start), names: directoryNames(start) };
    current = parent;
  }
}

function packageManagerFromManifest(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")).packageManager;
    if (typeof value !== "string") return null;
    const name = value.split("@")[0];
    return ["npm", "pnpm", "yarn", "bun"].includes(name) ? name : null;
  } catch {
    return null;
  }
}

export function detectStack(cwd = process.cwd(), { home = os.homedir() } = {}) {
  const located = nearestProjectRoot(cwd, home);
  const root = safeRealpath(located.root);
  const { names } = located;
  const present = new Set(names);
  const tools = [];
  const evidence = {};
  const conflicts = [];
  const add = (tool, files) => {
    if (!tools.includes(tool)) tools.push(tool);
    evidence[tool] = files.map((file) => path.join(root, file));
  };

  if (present.has("Cargo.toml")) add("cargo", ["Cargo.toml"]);
  const goFiles = ["go.work", "go.mod"].filter((name) => present.has(name));
  if (goFiles.length) add("go", goFiles);

  if (present.has("package.json") || present.has("pnpm-workspace.yaml")) {
    const declared = packageManagerFromManifest(path.join(root, "package.json"));
    const locked = Object.entries(NODE_LOCKFILES)
      .filter(([, files]) => files.some((file) => present.has(file)))
      .map(([manager]) => manager);
    const workspaceManager = present.has("pnpm-workspace.yaml") ? ["pnpm"] : [];
    const managers = [...new Set([...(declared ? [declared] : []), ...workspaceManager, ...locked])];
    if (managers.length > 1) conflicts.push({ family: "node", tools: managers, reason: "multiple package-manager declarations or lockfiles" });
    for (const manager of managers.length ? managers : ["npm"]) {
      const files = ["package.json", ...(manager === "pnpm" && present.has("pnpm-workspace.yaml") ? ["pnpm-workspace.yaml"] : []), ...(NODE_LOCKFILES[manager] || []).filter((file) => present.has(file))]
        .filter((file) => present.has(file));
      add(manager, files);
      if (manager === "npm") add("npx", files);
    }
  }

  const pythonFiles = ["pyproject.toml", "uv.lock", "requirements.txt", "setup.py"].filter((name) => present.has(name));
  if (pythonFiles.length) {
    if (present.has("uv.lock")) add("uv", pythonFiles.filter((name) => ["pyproject.toml", "uv.lock"].includes(name)));
    if (!present.has("uv.lock") || present.has("requirements.txt") || present.has("setup.py")) {
      add("pip", pythonFiles);
      add("pip3", pythonFiles);
    }
  }

  const dotnetFiles = names.filter((name) => name === "global.json" || name.endsWith(".sln") || name.endsWith(".csproj"));
  if (dotnetFiles.length) add("dotnet", dotnetFiles);
  if (present.has("composer.json")) add("composer", ["composer.json"]);

  return {
    root,
    tools,
    evidence,
    conflicts
  };
}

function argumentValue(args, names) {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") break;
    for (const name of names) {
      if (argument === name && args[index + 1]) return args[index + 1];
      if (argument.startsWith(`${name}=`)) return argument.slice(name.length + 1);
    }
  }
  return null;
}

function commandCwd(tool, args, cwd) {
  if (tool === "cargo") {
    const manifest = argumentValue(args, ["--manifest-path"]);
    if (manifest) return path.dirname(path.resolve(cwd, manifest));
  }
  if (tool === "go") {
    const changed = argumentValue(args, ["-C"]);
    if (changed) return path.resolve(cwd, changed);
  }
  if (["npm", "npx", "pnpm", "yarn"].includes(tool)) {
    const prefix = argumentValue(args, ["--prefix", "--dir", "-C"]);
    if (prefix) return path.resolve(cwd, prefix);
  }
  return path.resolve(cwd);
}

function hasManifest(directory, patterns) {
  let names;
  try {
    names = fs.readdirSync(directory);
  } catch {
    return false;
  }
  return patterns.some((pattern) => {
    if (!pattern.startsWith("*.")) return names.includes(pattern);
    return names.some((name) => name.endsWith(pattern.slice(1)));
  });
}

function findRoot(start, patterns) {
  let current = path.resolve(start);
  let gitFallback = null;
  while (true) {
    if (patterns && hasManifest(current, patterns)) return current;
    if (!gitFallback && (fs.existsSync(path.join(current, ".git")))) gitFallback = current;
    const parent = path.dirname(current);
    if (parent === current) return gitFallback || path.resolve(start);
    current = parent;
  }
}

function isCargoWorkspaceManifest(file) {
  try {
    return /^\s*\[workspace\]\s*(?:#.*)?$/m.test(fs.readFileSync(file, "utf8"));
  } catch {
    return false;
  }
}

function findCargoRoot(start) {
  let current = path.resolve(start);
  let nearestManifest = null;
  let gitFallback = null;
  while (true) {
    const manifest = path.join(current, "Cargo.toml");
    if (fs.existsSync(manifest)) {
      nearestManifest ||= current;
      if (isCargoWorkspaceManifest(manifest)) return current;
    }
    if (!gitFallback && fs.existsSync(path.join(current, ".git"))) gitFallback = current;
    const parent = path.dirname(current);
    if (parent === current) return nearestManifest || gitFallback || path.resolve(start);
    current = parent;
  }
}

function safeRealpath(value) {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

function slug(value) {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return cleaned || "workspace";
}

export function identifyWorkspace(tool, args = [], cwd = process.cwd()) {
  const effectiveCwd = commandCwd(tool, args, cwd);
  const root = safeRealpath(tool === "cargo" ? findCargoRoot(effectiveCwd) : findRoot(effectiveCwd, MANIFESTS[tool]));
  const digest = crypto.createHash("sha256").update(root).digest("hex").slice(0, 10);
  const id = `${slug(path.basename(root))}-${digest}`;
  return { id, root, effectiveCwd };
}
