// The GitHub App's private key in the vault's system scope (issue #1243): set through a write-only field, checked to be a
// private key before it is kept, opened at each read, removed; a key the runtime still gives is imported once. Never
// answered, logged or appended in clear.
import { describe, expect, it } from 'vitest';
import type { NewEvent } from '../../src/domain/types.ts';
import { createGitHubAppKey, GITHUB_APP_KEY_VARIABLE } from '../../src/sources/github/app/key.ts';
import { createSealer } from '../../src/secrets/sealer.ts';
import { createSystemSecrets } from '../../src/vault/system.ts';
import { KEYS } from '../support/github-app.ts';
import { memoryAccountStore, TEST_KEY } from '../support/system-secrets.ts';

const WHO = { userId: 'admin', admin: true, by: 'admin' };
const ONE_LINE = KEYS.privateKey.trim().replaceAll('\n', '\\n');

function setup(o: { runtime?: Record<string, string>; allowed?: boolean } = {}) {
  const { store, events } = memoryAccountStore();
  let backfills: Record<string, string> = {};
  const logged: string[] = [];
  const logger = { info: (l: string) => logged.push(l), warn: (l: string) => logged.push(l) };
  const system = createSystemSecrets({
    store, keys: { sealer: createSealer(TEST_KEY) }, userId: 'admin', clock: { now: () => new Date() }, idGen: () => `id-${Math.random()}`, logger,
    access: { decideSystemSecret: async () => ({ allowed: o.allowed ?? true, reason: o.allowed === false ? 'not yours' : 'yours' }) } as never,
  });
  const key = createGitHubAppKey({
    system, runtime: (name) => o.runtime?.[name], variable: `HOPPER_${GITHUB_APP_KEY_VARIABLE}`, clock: { now: () => new Date() }, logger,
    backfills: { getBackfills: () => backfills, setBackfills: (b) => { backfills = b; } },
  });
  return { key, events: events as NewEvent[], logged };
}

describe('the GitHub App private key in the vault (issue #1243)', () => {
  it('none kept: no value, and the view says not set', () => {
    const { key } = setup();
    expect(key.value()).toBeUndefined();
    expect(key.view()).toEqual({ set: false });
  });

  it('a key set is kept, opened at each read, and answered only as its view', async () => {
    const { key, events, logged } = setup();
    const r = await key.set(KEYS.privateKey, WHO);
    expect(r).toMatchObject({ ok: true, view: { set: true, setBy: 'admin' } });
    expect(key.value()).toBe(KEYS.privateKey.trim() + '\n');
    expect(JSON.stringify(r)).not.toContain(KEYS.privateKey.trim().slice(40, 80));
    expect(JSON.stringify(key.view())).not.toContain('PRIVATE KEY');
    expect(JSON.stringify(events)).not.toContain(KEYS.privateKey.trim().slice(40, 80));
    expect(logged.join('\n')).not.toContain(KEYS.privateKey.trim().slice(40, 80));
  });

  it('a key on one line with \\n escapes is kept as the PEM it spells', async () => {
    const { key } = setup();
    expect((await key.set(ONE_LINE, WHO)).ok).toBe(true);
    expect(key.value()).toBe(KEYS.privateKey.trim() + '\n');
  });

  it('a value that is not a private key is not kept, and the error does not carry it', async () => {
    const { key } = setup();
    const r = await key.set('not-a-key-0123456789', WHO);
    expect(r).toMatchObject({ ok: false, code: 'invalid' });
    expect(JSON.stringify(r)).not.toContain('not-a-key-0123456789');
    expect(key.value()).toBeUndefined();
    expect(await key.set('   ', WHO)).toMatchObject({ ok: false, code: 'invalid', error: 'the key is empty' });
  });

  it('Access decides a change', async () => {
    const { key } = setup({ allowed: false });
    expect(await key.set(KEYS.privateKey, WHO)).toMatchObject({ ok: false, code: 'forbidden' });
    expect(key.value()).toBeUndefined();
  });

  it('remove drops the key', async () => {
    const { key } = setup();
    await key.set(KEYS.privateKey, WHO);
    expect(await key.remove(WHO)).toMatchObject({ ok: true, view: { set: false } });
    expect(key.value()).toBeUndefined();
    expect(await key.remove(WHO)).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('a key the runtime gives is imported once, then never read again; the view names the variable while it is set', async () => {
    const runtime: Record<string, string> = { [GITHUB_APP_KEY_VARIABLE]: ONE_LINE };
    const { key, logged } = setup({ runtime });
    key.importFromEnvironment();
    expect(key.value()).toBe(KEYS.privateKey.trim() + '\n');
    expect(key.view()).toMatchObject({ set: true, setBy: 'environment', environment: { variable: `HOPPER_${GITHUB_APP_KEY_VARIABLE}` } });
    expect(logged.some((l) => l.includes('imported'))).toBe(true);
    await key.remove(WHO);
    key.importFromEnvironment();
    expect(key.value()).toBeUndefined();
  });
});
