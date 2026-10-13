// Issue #697: at start, and whenever asked, a container hopper compares the stack it runs in with the compose file of its
// own version — the services that must run, the settings the hopper's container is given, and the version of the vault
// in its own container — and names each gap, what it turns off, and the one fix: the update script.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { checkStack, type StackProbe } from '../../src/update/drift.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const SHIPPED = readFileSync(join(ROOT, 'compose.yaml'), 'utf8');
const COMMIT = 'c'.repeat(40);

/** The settings the shipped compose.yaml gives the hopper's container, as the container sees them: none set from .env. */
function shippedEnv(): Record<string, string> {
  const env = (parse(SHIPPED) as { services: { hopper: { environment: Record<string, string> } } }).services.hopper.environment;
  return Object.fromEntries(Object.keys(env).map((k) => [k, '']));
}

/** A stack where the services named run, and hopper-vault (when it runs) reports `vaultCommit`. */
function probe(running: string[], vaultCommit?: string | null): StackProbe & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    resolves: async (name) => { asked.push(name); return running.includes(name); },
    vaultCommit: async () => vaultCommit ?? null,
  };
}

const check = (o: { env?: Record<string, string | undefined>; probe: StackProbe; kind?: 'image' | 'install' }) =>
  checkStack({ kind: o.kind ?? 'image', compose: SHIPPED, commit: COMMIT, env: o.env ?? shippedEnv(), probe: o.probe });

describe('the stack against the compose file of this version (issue #697)', () => {
  it('finds no gap in a stack on the shipped compose.yaml', async () => {
    const p = probe(['postgres', 'openfga', 'solr', 'tunnel']);
    expect(await check({ probe: p })).toEqual({ state: 'checked', gaps: [] });
    // The one-shot migration and the optional services whose profiles are off are not asked for.
    expect(p.asked.sort()).toEqual(['openfga', 'postgres', 'solr', 'tunnel']);
  });

  it('names an old compose.yaml: the missing services, what each turns off, and the settings the hopper lacks', async () => {
    const env = shippedEnv();
    for (const k of ['HOPPER_OPENFGA_URL', 'HOPPER_OPENFGA_KEY_FILE', 'HOPPER_VAULT_URL']) delete env[k];
    const r = await check({ env, probe: probe(['postgres']) });
    expect(r.state).toBe('checked');
    expect(r.gaps).toEqual([
      { kind: 'service', name: 'openfga', what: 'the service openfga is not running in this stack', off: expect.stringMatching(/TypeSafe API key/) },
      // Solr (issue #945): required from that version on; search is down without it.
      { kind: 'service', name: 'solr', what: 'the service solr is not running in this stack', off: expect.stringMatching(/^search: /) },
      // The tunnel service (issue #880): required from that version on; a stack from before lacks it.
      { kind: 'service', name: 'tunnel', what: 'the service tunnel is not running in this stack', off: expect.stringMatching(/Remote access/) },
      { kind: 'setting', name: 'HOPPER_OPENFGA_URL, HOPPER_OPENFGA_KEY_FILE, HOPPER_VAULT_URL', what: expect.stringMatching(/older compose\.yaml/) },
    ]);
  });

  it('asks for an optional service only when its profile is on, and names the vault in its own container when it is missing', async () => {
    const env = { ...shippedEnv(), COMPOSE_PROFILES: 'hopper-vault,kms' };
    const r = await check({ env, probe: probe(['postgres', 'openfga', 'solr', 'tunnel', 'kms']) });
    expect(r.gaps).toEqual([{ kind: 'service', name: 'hopper-vault', what: 'the service hopper-vault is not running in this stack', off: expect.stringMatching(/vault/) }]);
  });

  it('names a vault container that runs another version than the hopper', async () => {
    const env = { ...shippedEnv(), COMPOSE_PROFILES: 'hopper-vault' };
    const other = await check({ env, probe: probe(['postgres', 'openfga', 'solr', 'tunnel', 'hopper-vault'], 'd'.repeat(40)) });
    expect(other.gaps).toEqual([{ kind: 'version', name: 'hopper-vault', what: `hopper-vault runs ${'d'.repeat(7)}, the hopper ${COMMIT.slice(0, 7)}` }]);
    const older = await check({ env, probe: probe(['postgres', 'openfga', 'solr', 'tunnel', 'hopper-vault'], null) });
    expect(older.gaps).toEqual([{ kind: 'version', name: 'hopper-vault', what: expect.stringMatching(/does not say its version/) }]);
    const same = await check({ env, probe: probe(['postgres', 'openfga', 'solr', 'tunnel', 'hopper-vault'], COMMIT) });
    expect(same.gaps).toEqual([]);
  });

  it('checks only a container install that ships its compose file, and says why not', async () => {
    expect(await check({ kind: 'install', probe: probe([]) })).toEqual({ state: 'unchecked', reason: expect.stringMatching(/not a container/), gaps: [] });
    expect(await checkStack({ kind: 'image', compose: undefined, commit: COMMIT, env: {}, probe: probe([]) }))
      .toEqual({ state: 'unchecked', reason: expect.stringMatching(/ships no compose/), gaps: [] });
  });
});
