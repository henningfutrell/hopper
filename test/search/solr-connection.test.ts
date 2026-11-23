// Issue #2990: the Solr search reads and writes, with its credentials. HOPPER_SOLR_URL names a standalone core or a
// SolrCloud collection; the credentials come from HOPPER_SOLR_USERNAME and HOPPER_SOLR_PASSWORD (each also as _FILE, read
// at each call) or from the URL's userinfo, never both. The URL the hopper logs and names in errors has no userinfo, and
// the start line says whether basic auth is on.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { runtimeSecrets } from '../../src/secrets/runtime.ts';
import { solrConnection, solrStartLine } from '../../src/search/solr-connection.ts';

const basic = (user: string, pass: string): string => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
const connect = (url: string, env: Record<string, string> = {}) => solrConnection(url, runtimeSecrets(env));

describe('the Solr connection (issue #2990)', () => {
  it('sends no credentials when none are given', () => {
    const c = connect('http://solr:8983/solr/hopper');
    expect(c).toMatchObject({ url: 'http://solr:8983/solr/hopper', auth: false });
    expect(c.authorization()).toBeUndefined();
    expect(solrStartLine(c)).toBe('hopper: search: Solr at http://solr:8983/solr/hopper, basic auth off');
  });

  it('takes the credentials from the URL\'s userinfo, decoded, and keeps them out of the URL it names', () => {
    const c = connect('https://hopper:p%40ss%3Aw0rd@solr.example.test/solr/hopper/');
    expect(c).toMatchObject({ url: 'https://solr.example.test/solr/hopper', auth: true });
    expect(c.authorization()).toBe(basic('hopper', 'p@ss:w0rd'));
    expect(solrStartLine(c)).toBe('hopper: search: Solr at https://solr.example.test/solr/hopper, basic auth on');
    expect(solrStartLine(c)).not.toContain('p@ss');
  });

  it('takes the credentials from HOPPER_SOLR_USERNAME and HOPPER_SOLR_PASSWORD, and reads a password file again at each call', () => {
    const dir = mkdtempSync(join(tmpdir(), 'solr-pass-'));
    const file = join(dir, 'password');
    writeFileSync(file, 'first\n');
    const c = connect('http://solr:8983/solr/hopper', { HOPPER_SOLR_USERNAME: 'hopper', HOPPER_SOLR_PASSWORD_FILE: file });
    expect(c.auth).toBe(true);
    expect(c.authorization()).toBe(basic('hopper', 'first'));
    writeFileSync(file, 'rotated\n');
    expect(c.authorization()).toBe(basic('hopper', 'rotated'));
  });

  it('refuses credentials in the URL and in the variables both, a username with no password, and the reverse', () => {
    expect(() => connect('http://u:p@solr:8983/solr/hopper', { HOPPER_SOLR_USERNAME: 'u', HOPPER_SOLR_PASSWORD: 'p' }))
      .toThrow(/HOPPER_SOLR_URL has credentials and HOPPER_SOLR_USERNAME or HOPPER_SOLR_PASSWORD is set: set one/);
    expect(() => connect('http://solr:8983/solr/hopper', { HOPPER_SOLR_USERNAME: 'u' })).toThrow(/HOPPER_SOLR_USERNAME is set with no HOPPER_SOLR_PASSWORD/);
    expect(() => connect('http://solr:8983/solr/hopper', { HOPPER_SOLR_PASSWORD: 'p' })).toThrow(/HOPPER_SOLR_PASSWORD is set with no HOPPER_SOLR_USERNAME/);
    expect(() => connect('http://u@solr:8983/solr/hopper')).toThrow(/HOPPER_SOLR_URL has a username and no password/);
  });

  it('never names the password in an error', () => {
    let message = '';
    try { connect('http://hopper:s3cret-value@solr:8983/solr/hopper', { HOPPER_SOLR_PASSWORD: 'other' }); } catch (e) { message = (e as Error).message; }
    expect(message).not.toBe('');
    expect(message).not.toContain('s3cret-value');
    expect(message).not.toContain('other');
  });
});
