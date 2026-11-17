#!/usr/bin/env node
// Guard: the package documents must read correctly in the public repository on their own.
// Usage: node scripts/check-standalone.mjs [package-root]
// Checks README.md, AGENTS.md, CONTRIBUTING.md, CONTRACT.md and docs/**/*.md under the package root for monorepo-only forms, and
// runtime/**/*.mjs, installer.mjs and install.sh for the code forms: the strings they print must name neither the
// monorepo's repair script nor a person.
// Inside a containing monorepo (the package root is the clean-development/ directory of a checkout that has its own
// README.md) it also checks the root README.md and bootstrap/restore-kit/RESTORE-DEV-ENV.md for the mirror claim, and
// the package documents for the name in the monorepo's .claude-plugin/marketplace.json, which is private there.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve, relative, basename } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(process.argv[2] || join(here, ".."));
const top = dirname(pkg);
const inMonorepo = basename(pkg) === "clean-development" && existsSync(join(top, "README.md"));

// The containing marketplace's name, when this runs inside a monorepo that has one; the package never spells it.
function privateName() {
  const manifest = join(top, ".claude-plugin", "marketplace.json");
  if (!inMonorepo || !existsSync(manifest)) return null;
  const name = JSON.parse(readFileSync(manifest, "utf8")).name;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Each form: name, pattern, hint. Lines are checked one by one, fenced code included.
const FORMS = [
  ["source-path", /~\/dev\/source/, "personal ~/dev/source path"],
  // A package-prefixed path: preceded by a backtick, space, bracket or pipe, not by a path character.
  ["package-prefix", /(?<![\w~./-])clean-development\/(?=[\w.<])/, "path with a clean-development/ prefix; paths are relative to the package root"],
  ["marketplace-manifest", /marketplace\.json/, "the marketplace manifests belong to the containing monorepo, not this package"],
  // A backticked path starting with bin/: the package has runtime/bin/ and no bin/ directory.
  ["root-bin-path", /`bin\/[^`\s]*`/, "bin/ exists only at the monorepo root; the package has runtime/bin/"],
  ["mirror-claim", /mirrored\s+(?:to|from|with)\b/i, "the public repository is not a mirror; state monorepo to public by pull request"],
];
const name = privateName();
if (name) FORMS.unshift(["private-marketplace", new RegExp(escape(name)), "private marketplace or repository name"]);
// Code forms, for the runtime and the installer: their strings and comments ship in the package.
const CODE_FORMS = [
  ["private-name", / by G\)|\bby G,/, "a private name; the package names no person"],
];

function walk(dir, ext = ".md", out = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, ext, out);
    else if (name.endsWith(ext)) out.push(p);
  }
  return out;
}

function scan(file, forms, base) {
  const problems = [];
  readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    for (const [name, re, hint] of forms) if (re.test(line)) problems.push(`${relative(base, file)}:${i + 1}: ${name}: ${hint}`);
  });
  return problems;
}

const files = ["README.md", "AGENTS.md", "CONTRIBUTING.md", "CONTRACT.md"].map((f) => join(pkg, f)).filter(existsSync);
if (existsSync(join(pkg, "docs"))) files.push(...walk(join(pkg, "docs")));
const problems = files.flatMap((f) => scan(f, FORMS, pkg));
const code = ["installer.mjs", "install.sh"].map((f) => join(pkg, f)).filter(existsSync);
if (existsSync(join(pkg, "runtime"))) code.push(...walk(join(pkg, "runtime"), ".mjs"));
problems.push(...code.flatMap((f) => scan(f, CODE_FORMS, pkg)));

if (inMonorepo) {
  const mirror = FORMS.filter(([name]) => name === "mirror-claim");
  for (const f of ["README.md", "bootstrap/restore-kit/RESTORE-DEV-ENV.md"].map((x) => join(top, x)).filter(existsSync)) {
    problems.push(...scan(f, mirror, top));
  }
}

if (problems.length) {
  console.error(`check-standalone: ${problems.length} problem(s)\n${problems.join("\n")}`);
  process.exit(1);
}
console.log(`check-standalone: ok (${files.length} package documents, ${code.length} code files)`);
