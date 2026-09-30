# Configuration precedence and origin

This is the resolution contract for `src/config.js` and the location selection
in `src/platform.js`. It supplements [configuration](configuration.md) and
[command storage boundaries](command-storage-boundaries.md). Resolving a value
is read-only and is **not** permission to create, route into, or delete that path.

## Storage paths: select each key independently

For valid supplied values, the precedence for each of `root`, `cacheRoot`,
`buildRoot`, and `scratchRoot` is, highest first:

1. The corresponding `resolveConfig({ overrides })` value supplied by the command.
2. Its `CLEAN_DEVELOPMENT_*` environment variable.
3. The same key in the nearest selected project configuration.
4. The same key in user configuration.
5. The fallback in the following table.

| Key | Environment variable | Fallback |
| --- | --- | --- |
| `root` | `CLEAN_DEVELOPMENT_ROOT` | `platformPaths(env).defaultRoot` |
| `cacheRoot` | `CLEAN_DEVELOPMENT_CACHE_ROOT` | `<resolved root>/caches` |
| `buildRoot` | `CLEAN_DEVELOPMENT_BUILD_ROOT` | `<resolved root>/builds` |
| `scratchRoot` | `CLEAN_DEVELOPMENT_SCRATCH_ROOT` | `<resolved root>/scratch` |

Resolve `root` first. Derive a child path from it **only when that child key has
no explicit value at any layer**. For example, changing `root` on the command
line does not replace `cacheRoot` explicitly saved in user configuration. Split
storage destinations remain independent; moving the root does not migrate data.

Selected paths must be absolute. They are normalised and canonicalised through
existing ancestors; a missing suffix is appended without creating it. A selected
filesystem root or canonical home-directory root is refused, including aliases.
No shell variable or tilde expansion is performed by the resolver.

### Origin fields

`rootSource` and `pathSources.root` are identical. Preserve the current public
strings, including the deliberate difference for an environment-selected root:

| Winning layer | Root origin | Child-path origin |
| --- | --- | --- |
| Command overlay | `command line` | `command line` |
| Environment | `environment` | `environment: CLEAN_DEVELOPMENT_<KEY>` |
| Project | Selected `.clean-development.json` path | Same selected path |
| User | `locations.configPath` | `locations.configPath` |
| Default/derived | `platform default` | `derived from root (<rootSource>)` |

An origin is the selected configuration location, not proof of ownership or
consent. Reading a valid symlinked config keeps the selected link path as its
origin; it does not substitute the referent's filename. Canonicalising a storage
value does not change its origin. Selected relative-path errors use the same
origin as a successful selection would; they must not blame an unrelated
project file for a user, environment, or command value.

## Other fields

The object merge is `defaults < user < project < overrides`. Environment storage
variables affect the four paths, not arbitrary JSON keys. There is no generic
`CLEAN_DEVELOPMENT_ENABLED` or retention override in this resolver.

`enabled` is replaced by the highest supplied field. `retention` and `tools` are
merged per key, so `false` tool switches and `retention.buildDays: 0` are real
values, not absence. The defaults are `enabled: true`, 30 build-retention days,
and every supported tool enabled. Unspecified tool keys inherit independently.
`agents` is allowed in user configuration but rejected in project configuration;
arrays are replaced, not concatenated. No per-field origin map is currently
returned for these non-path fields.

`overrides` is a low-level, trusted configuration overlay, not a new set of CLI
flags or a second schema parser. Its callers must provide validated fields. In
particular, its path selection uses truthy values; malformed falsey API path
values are not equivalent to a valid CLI override. This change does not expand
or redesign that API validation boundary.

## File discovery and failures

User configuration is `<platform configDir>/config.json`. Project discovery
walks lexical ancestors of the absolute command cwd to the filesystem root and
selects the **first directory entry** named `.clean-development.json`. It does
not merge multiple ancestor files and does not stop at a Git/manifest boundary.
Stack/workspace detection has different rules; do not conflate the two searches.

A genuinely absent candidate permits continuing the search. A present symlink,
including one whose referent is missing or loops, still occupies that precedence
position. It must be read and validated or fail; it cannot expose an ancestor's
configuration or platform default instead. An inspection error other than
`ENOENT` propagates. A project file that disappears after discovery is an error,
not a new invitation to merge lower-precedence values. Retrying after a deliberate
removal performs a fresh search.

Both loaded files are parsed and schema-validated before path selection. Invalid
JSON, a non-object top level, missing/unsupported schema version, unknown keys,
wrong field types, blank file path strings, and invalid tools/retention are errors,
even when a higher-priority storage override exists. Unselected ancestor files
are not loaded. Valid symlink referents remain supported for read-only config
resolution; this does not relax the separate persistence/writer rules.

Validation has two stages: file schema and environment string validation happen
before selection; absolute-path and broad-root checks operate on the selected
path. Thus a non-selected, non-empty relative path string is not resolved or
rejected as a path, although malformed file shapes and blank environment values
still fail. A present environment path must be a non-empty string even when a
command would override it. An `undefined` environment value is absent.

This is not an atomic filesystem snapshot. The correction prevents the
reproduced missing-link/disappearing-entry fallbacks; it does not lock symlink
referents, bound all file reads, or eliminate every same-user filesystem race.

## CLI differences

`setup --root` and `update --root` normalise relative CLI paths against their
process cwd before passing an absolute root override to the resolver. They use
`includeProject: false`: project settings, even malformed or dangling ones, are
intentionally excluded from user setup. The current CLI does not expose
`--cache-root`, `--build-root`, or `--scratch-root`; use the corresponding file
keys or environment variables. `--agents` selection happens outside path
resolution. `init --root` writes project configuration rather than returning a
merged effective configuration.

`includeProject: false` does not ignore malformed user configuration. Ordinary
resolution includes the nearest project file. The existing explicit skip,
disabled-project, session and command-routing decisions are separate; this PR
does not change them.

## Platform location precedence

Home selection is `CLEAN_DEVELOPMENT_HOME > HOME > USERPROFILE > os.homedir()`.
Empty `HOME`/`USERPROFILE` strings are skipped; an empty explicit
`CLEAN_DEVELOPMENT_HOME` is rejected. The selected home must be absolute, nonblank
and not the filesystem root. It is canonicalised before deriving locations.

| Platform | Data directory | Config directory | Default storage root |
| --- | --- | --- | --- |
| Linux/other | `${XDG_DATA_HOME:-<home>/.local/share}/clean-development` | `${XDG_CONFIG_HOME:-<home>/.config}/clean-development` | `${XDG_CACHE_HOME:-<home>/.cache}/clean-development` |
| macOS | `<home>/Library/Application Support/clean-development` | Selected data directory | `<home>/Library/Caches/clean-development` |
| Windows | `${LOCALAPPDATA:-<home>/AppData/Local}/clean-development` | `${APPDATA:-<home>/AppData/Roaming}/clean-development` | `${LOCALAPPDATA:-<home>/AppData/Local}/clean-development/cache` |

`CLEAN_DEVELOPMENT_DATA_HOME` replaces the data directory itself, with no appended
product name. `CLEAN_DEVELOPMENT_CONFIG_HOME` independently replaces the config
directory itself. On macOS only, an absent custom config directory follows a
custom data directory. A custom data directory does not change the default
storage root. Runtime, state and bin are children of the selected data directory.

Recognised custom and platform base variables must be non-empty absolute narrow
paths. Relevant platform bases are validated even when custom locations mask
their values. Irrelevant platform variables are not read. On Linux/macOS, native
environment keys match exactly, and setting `PATH` preserves an independent
`path` key. On Windows, keys match case-insensitively; if a supplied JavaScript
object contains multiple case spellings, the first enumerable match wins. Avoid
conflicting Windows duplicates: Node subprocesses may select a different key
when constructing the native environment. The Windows setter removes existing
case variants before writing one canonical key. Tool-defined `npm_config_*`
aliases remain case-insensitive on every host; other adapter variables follow
native casing. See [platform support](platform-support.md).

## Managed roots inside a project

`resolveConfig` returns a selected project-local root with its true origin rather
than silently moving it elsewhere. Read-only session/command planning then reports
that root as blocked for routed use. Equality, descendants and canonical
symlink/junction aliases count; a similarly named sibling does not. The existing
home-directory exception belongs to routing-boundary policy, not path precedence.
No directories or project settings are created by resolution or these preview
checks. Tool environment overrides such as `npm_config_cache` have a separate
[provenance rule](configuration.md#inherited-environment-provenance).

## Deterministic verification

```sh
node --test test/config-precedence.test.js test/platform-precedence.test.js test/config.test.js
npm run check
npm test
```

The dedicated matrix covers all 16 presence/conflict combinations for each path,
all eight non-path overlay combinations, exact successful/error origins,
malformed inputs, valid/dangling/looping links, disappearance at discovery/load,
lookup errors, CLI dry runs, platform location selection and project boundaries.
Fixtures contain only disposable homes/configs/storage. Event ordering is injected
at filesystem calls rather than timed with sleeps. Platform-parameter tests are
location-selection tests, not native Windows execution evidence; file-symlink
privilege skips are explicit where required.
