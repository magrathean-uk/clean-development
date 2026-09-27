// Stable, dependency-free structured generation. Never generate arbitrary code or
// real paths: the runner expands only these fixture-local placeholders.
export const SEEDS = [0x434c454e, 0x5eed2026, 0xc0ffee];
export const SECRET = 'FUZZ_CANARY';
export const BOUNDARIES = ['argv', 'environment', 'project', 'manifest', 'state', 'marker', 'receipt', 'integration'];
export function random(seed) {
  let x = seed >>> 0;
  return () => { x += 0x6d2b79f5; let y = Math.imul(x ^ x >>> 15, 1 | x); y ^= y + Math.imul(y ^ y >>> 7, 61 | y); return ((y ^ y >>> 14) >>> 0) / 4294967296; };
}
const json = (value) => JSON.stringify(value);
const malformed = ['{', '[', 'null', '[]', 'true', '"text"', '{"schemaVersion":1,}', '{"a":\u0000}', `${SECRET}!`, '{"x":1e999}', '{"__proto__":{"enabled":true}}'];
const odd = ['', ' ', '\n', '../relative', '/', 'constructor', '__proto__', 'café 東京', '--', '0', '-1', '9007199254740993', '1e309'];
const choose = (rng, values) => values[Math.floor(rng() * values.length)];

export function generate(seed = SEEDS[0], count = 128) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff || !Number.isInteger(count) || count < 8 || count > 2048) throw new Error('Invalid seed/count');
  const rng = random(seed);
  return Array.from({ length: count }, (_, index) => {
    const boundary = BOUNDARIES[index % BOUNDARIES.length];
    const round = Math.floor(index / BOUNDARIES.length);
    const base = { id: `${seed.toString(16)}-${index}`, boundary, kind: round % 2 ? 'malformed' : 'near-miss' };
    if (boundary === 'argv') {
      const variants = [
        ['status', '--json', '--max-scan-ms', '0'], ['session', '--dry-run', '--json'],
        ['setup', '--dry-run', '--agents', '__proto__'], ['status', '--json=true'],
        ['prune', '--older-than', '99999999999999', '--json'], ['status', '--json', '--json'],
        ['explain', '--json', '--', 'npm', 'pack', '--cache', '$ROOT/cache café'],
        ['run', '--session', 'skip', '--help', '--', 'canary'],
        ['env', '--tool', 'constructor', '--format', 'json'], ['status', '--', '--apply'],
        ['setup', '--dry-run', '--agents', 'claude,constructor'], ['status', '--max-scan-entries=-1'],
      ];
      return { ...base, argv: variants[round % variants.length].concat(round >= variants.length ? [`--fuzz-${choose(rng, odd)}`] : []) };
    }
    if (boundary === 'environment') {
      const keys = ['CLEAN_DEVELOPMENT_ROOT', 'CLEAN_DEVELOPMENT_BUILD_ROOT', 'CLEAN_DEVELOPMENT_SESSION_MODE', 'CLEAN_DEVELOPMENT_SESSION_ENV'];
      const name = keys[round % keys.length];
      const payload = name.endsWith('_ENV') ? choose(rng, [...malformed, json({ npm_config_cache: '$ROOT/old-cache' }), json({ PATH: '$ROOT/bin', __proto__: {} })])
        : name.endsWith('_MODE') ? choose(rng, ['skip', 'session-only', 'persist', ...odd]) : choose(rng, ['$ROOT/managed', '$ROOT/project', ...odd]);
      // NUL cannot be transported in an OS environment; fuzz its escaped JSON
      // spelling here, and retain raw NUL mutations in file inputs.
      return { ...base, name, payload: payload.replaceAll('\0', '\\u0000'), argv: ['session', '--dry-run', '--json'] };
    }
    if (boundary === 'project') {
      const variants = [json({ schemaVersion: 1, enabled: false }), `${SECRET}!`, json({ schemaVersion: 1, root: '$ROOT/project' }),
        json({ schemaVersion: 1, tools: { npm: 'false' } }), json({ schemaVersion: 1, retention: { buildDays: 1e100 } }),
        json({ schemaVersion: 1, enabled: true, root: '$ROOT/managed' }), json({ schemaVersion: 2 }), json({ schemaVersion: 1, tools: { constructor: true } })];
      return { ...base, slot: 'project', payload: round < variants.length ? variants[round] : choose(rng, malformed), topology: round === 11 ? 'oversize' : round === 8 ? 'fifo' : round === 9 ? 'directory' : round === 10 ? 'secret-link' : 'file', argv: ['session', '--dry-run', '--json'] };
    }
    if (boundary === 'manifest') {
      const slot = round % 3 === 0 ? 'package' : round % 3 === 1 ? 'cargo' : 'python';
      const payload = slot === 'package' ? choose(rng, [json({ packageManager: 'npm@10.9.2', scripts: { preinstall: 'canary' } }), json({ packageManager: [null] }), ...malformed])
        : slot === 'cargo' ? choose(rng, ['[workspace]\nmembers=[]\n', '[workspace]\nmembers="wrong"\n', '[package]\nname="canary"\nversion="0.1.0"\n', '[['.repeat(1024)])
          : '[project]\nname="canary"\n[build-system]\nrequires=[]\nbuild-backend="canary"\n';
      return { ...base, slot, payload, topology: round === 6 || round === 7 ? 'fifo' : round === 10 ? 'directory' : 'file', argv: ['session', '--dry-run', '--json'] };
    }
    if (boundary === 'state' || boundary === 'marker') {
      // Each structured mutation removes evidence required for deletion. The
      // independent paired marker/receipt remains unchanged, never forged too.
      const field = boundary === 'state' ? choose(rng, ['schemaVersion', 'ownershipId', 'workspace', 'path', 'lastUsedAt', 'pinned'])
        : choose(rng, ['owner', 'ownershipId', 'workspaceId', 'workspace']);
      const value = field === 'pinned' ? true : field === 'schemaVersion' ? 2 : `${choose(rng, odd)}-mismatch`;
      return { ...base, slot: boundary, mutation: round % 2 === 0 ? { field, value } : null,
        payload: round % 2 === 0 ? null : choose(rng, malformed), topology: round === 8 ? 'fifo' : 'file', argv: ['prune', '--apply', '--older-than', '1', '--json'] };
    }
    if (boundary === 'receipt') {
      const slot = round % 2 ? 'integrations' : 'runtime';
      const mutation = slot === 'runtime' ? choose(rng, [{ field: 'schemaVersion', value: 99 }, { field: 'ownedFiles', value: [{}] }, { field: 'versionRoot', value: '$ROOT/protected' }, { field: 'runtimeFiles', value: [null] }, { field: 'node', value: false }])
        : choose(rng, [{ field: 'schemaVersion', value: 2 }, { field: 'integrations', value: [{ agent: 'claude', mode: 'native-hook', file: '$ROOT/protected/secret' }] }, { field: 'integrations', value: [null] }]);
      return { ...base, slot, installed: true, mutation: round >= 2 && round % 3 !== 0 ? mutation : null,
        payload: round === 0 || round === 1 ? `${SECRET}!` : choose(rng, malformed), topology: round === 9 ? 'fifo' : 'file', argv: ['uninstall', '--dry-run', '--json'] };
    }
    const agent = ['claude', 'codex', 'grok'][round % 3];
    const payload = agent === 'claude' ? (round === 0 ? `${SECRET}!` : choose(rng, [...malformed, json({ env: { API_KEY: SECRET }, hooks: { SessionStart: 'wrong' } }), json({ env: { API_KEY: SECRET }, hooks: { SessionStart: [{ hooks: [] }] } })]))
      : choose(rng, [`# ${SECRET}\n[unrelated]\nvalue="preserve"\n`, '[[toolset.bash]]\ncmd_prefix="canary"\n', '[shell_environment_policy]\ninherit = "all"\n', 'value="""\n[toolset.bash]\n"""\n', '[broken\n']);
    return { ...base, slot: agent, agent, payload, topology: round === 11 ? 'oversize' : [6, 7, 8].includes(round) ? 'fifo' : 'file', argv: ['setup', '--agents', agent, '--json'], policy: 'setup' };
  });
}

export const REGRESSIONS = [
  { id: 'claude-nonfinite', boundary: 'integration', slot: 'claude', payload: '{"x":1e999}', policy: 'setup', argv: ['setup', '--agents', 'claude'] },
  { id: 'json-content-disclosure', boundary: 'project', slot: 'project', payload: `${SECRET}!`, argv: ['status', '--json'] },
  { id: 'config-fifo', boundary: 'project', slot: 'project', topology: 'fifo', argv: ['status', '--json'] },
  { id: 'package-fifo', boundary: 'manifest', slot: 'package', topology: 'fifo', argv: ['session', '--dry-run', '--json'] },
  { id: 'cargo-fifo', boundary: 'manifest', slot: 'cargo', topology: 'fifo', argv: ['explain', '--json', '--', 'cargo', 'check'] },
  { id: 'codex-fifo', boundary: 'integration', slot: 'codex', topology: 'fifo', policy: 'setup', argv: ['setup', '--agents', 'codex', '--json'] },
  { id: 'grok-fifo', boundary: 'integration', slot: 'grok', topology: 'fifo', policy: 'setup', argv: ['setup', '--agents', 'grok', '--json'] },
  { id: 'claude-content-disclosure', boundary: 'integration', slot: 'claude', payload: `${SECRET}!`, policy: 'setup', argv: ['setup', '--agents', 'claude', '--json'] },
];
