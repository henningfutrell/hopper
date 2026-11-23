// Issue #2990: the Solr credentials can also be kept in the hopper's vault — one system secret of the instance's vault,
// `solr-credentials`, that the hopper's admin sets (Settings → Search, POST /ui/api/solr-credentials, `hopper
// solr-credentials`). Read when the runtime gives none. A set is checked once against Solr first; one that Solr refuses is
// not kept. The view never holds the username or the password, and no answer or error does.
import { describe, expect, it } from 'vitest';
import { runtimeSecrets } from '../../src/secrets/runtime.ts';
import { solrConnection } from '../../src/search/solr-connection.ts';
import { createSolrCredentials, SOLR_CREDENTIALS, solrCredentialsReader, type SolrCheck } from '../../src/search/solr-credentials.ts';
import { memoryAccountStore, systemOf } from '../support/system-secrets.ts';

const URL_ = 'http://solr:8983/solr/hopper';
const basic = (user: string, pass: string): string => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

function setup(o: { env?: Record<string, string>; url?: string | null; check?: SolrCheck; key?: string | null } = {}) {
  const { store, events } = memoryAccountStore();
  const system = systemOf(store, o.key === undefined ? undefined : o.key);
  const read = solrCredentialsReader(system);
  const connection = o.url === null ? undefined : solrConnection(o.url ?? URL_, runtimeSecrets(o.env ?? {}), read);
  const checked: string[] = [];
  const check: SolrCheck = o.check ?? (async (authorization) => { checked.push(authorization); return { ok: true }; });
  return { system, events, connection, checked, credentials: createSolrCredentials({ secrets: system, connection, check }) };
}

describe('the Solr credentials in the vault (issue #2990)', () => {
  it('keeps a set checked against Solr, and the connection sends it at the next call', async () => {
    const s = setup();
    expect(s.credentials.view()).toMatchObject({ configured: true, url: URL_, source: 'none', kept: { set: false } });
    const r = await s.credentials.change({ action: 'set', username: 'hopper', password: 'v4ult-pass' }, 'Ada');
    expect(r.ok).toBe(true);
    expect(s.checked).toEqual([basic('hopper', 'v4ult-pass')]);
    expect(s.connection!.authorization()).toBe(basic('hopper', 'v4ult-pass'));
    const view = s.credentials.view();
    expect(view).toMatchObject({ configured: true, source: 'vault', kept: { set: true, setBy: 'Ada' } });
    expect(JSON.stringify(view)).not.toMatch(/v4ult|username|password/);
    expect(s.system.meta(SOLR_CREDENTIALS)).toMatchObject({ setBy: 'Ada' });
    expect(s.system.meta(SOLR_CREDENTIALS)?.last4).toBeUndefined();
    expect(JSON.stringify(s.events)).not.toContain('v4ult-pass');
  });

  it('does not keep credentials that Solr refuses, and names no credential in the error', async () => {
    const s = setup({ check: async () => ({ ok: false, why: 'Solr refused the credentials (401)' }) });
    const r = await s.credentials.change({ action: 'set', username: 'hopper', password: 'wr0ng-pass' }, 'Ada');
    expect(r).toMatchObject({ ok: false, code: 'invalid' });
    expect(r.ok ? '' : r.error).toMatch(/not saved: .*401/);
    expect(r.ok ? '' : r.error).not.toContain('wr0ng-pass');
    expect(s.credentials.view().kept).toEqual({ set: false });
    expect(s.connection!.authorization()).toBeUndefined();
  });

  it('masks a password that the check\'s answer holds', async () => {
    const s = setup({ check: async () => ({ ok: false, why: 'Solr answered 500: bad wr0ng-pass' }) });
    const r = await s.credentials.change({ action: 'set', username: 'hopper', password: 'wr0ng-pass' }, 'Ada');
    expect(r.ok ? '' : r.error).not.toContain('wr0ng-pass');
  });

  it('refuses a set while the runtime or the URL gives the credentials: they win', async () => {
    const env = setup({ env: { HOPPER_SOLR_USERNAME: 'u', HOPPER_SOLR_PASSWORD: 'p' } });
    expect(env.credentials.view().source).toBe('runtime');
    expect(await env.credentials.change({ action: 'set', username: 'a', password: 'b' }, 'Ada')).toMatchObject({ ok: false, code: 'conflict' });
    const url = setup({ url: 'http://u:p@solr:8983/solr/hopper' });
    expect(url.credentials.view()).toMatchObject({ source: 'url', url: URL_ });
    expect(await url.credentials.change({ action: 'set', username: 'a', password: 'b' }, 'Ada')).toMatchObject({ ok: false, code: 'conflict' });
    expect(env.checked).toEqual([]);
  });

  it('refuses a set while search is not configured, a bad username and an empty password', async () => {
    const off = setup({ url: null });
    expect(off.credentials.view()).toMatchObject({ configured: false, source: 'none' });
    expect(await off.credentials.change({ action: 'set', username: 'a', password: 'b' }, 'Ada')).toMatchObject({ ok: false, code: 'conflict' });
    const s = setup();
    expect(await s.credentials.change({ action: 'set', username: 'a:b', password: 'c' }, 'Ada')).toMatchObject({ ok: false, code: 'invalid' });
    expect(await s.credentials.change({ action: 'set', username: ' ', password: 'c' }, 'Ada')).toMatchObject({ ok: false, code: 'invalid' });
    expect(await s.credentials.change({ action: 'set', username: 'a', password: '' }, 'Ada')).toMatchObject({ ok: false, code: 'invalid' });
    expect(s.checked).toEqual([]);
  });

  it('refuses a set without the master key', async () => {
    const s = setup({ key: null });
    expect(s.credentials.view().problem).toMatch(/master key/);
    expect(await s.credentials.change({ action: 'set', username: 'a', password: 'b' }, 'Ada')).toMatchObject({ ok: false, code: 'unavailable' });
  });

  it('removes them: no credentials are sent after that', async () => {
    const s = setup();
    expect(await s.credentials.change({ action: 'remove' }, 'Ada')).toMatchObject({ ok: false, code: 'not_found' });
    await s.credentials.change({ action: 'set', username: 'hopper', password: 'pw' }, 'Ada');
    expect(await s.credentials.change({ action: 'remove' }, 'Ada')).toMatchObject({ ok: true });
    expect(s.credentials.view()).toMatchObject({ source: 'none', kept: { set: false } });
    expect(s.connection!.authorization()).toBeUndefined();
  });
});
