// The tunnel providers (issues #968, #1609): with one credential, the hopper mints the tunnel at Cloudflare or ngrok, step
// by step, and removes what it minted again; a step tried again finds what it made by the instance's name, and `find` names
// what a mint cut short made. Against loopback fakes of their APIs.
import { afterEach, describe, expect, it } from 'vitest';
import { cloudflareProvider, ingressOf } from '../../src/remote-access/cloudflare.ts';
import { ngrokProvider } from '../../src/remote-access/ngrok.ts';
import type { Provisioned } from '../../src/domain/remote-access.ts';
import { ProviderError, type Made, type TunnelProvider } from '../../src/remote-access/provider.ts';
import { fakeCloudflare, fakeNgrok, type Fake } from './fake-providers.ts';

const CF = 'c'.repeat(40);
const NG = 'n'.repeat(40);
const fakes: Fake[] = [];
afterEach(async () => { for (const f of fakes.splice(0)) await f.close(); });
const NAME = 'hopper-0123456789abcdef';

/** The mint's steps in order, as its saga runs them; on a failure, what the steps before made, with the error. */
async function steps(p: TunnelProvider, o: { credential: string; domain?: string; port: number }, from: Made = {}): Promise<{ made: Made; token?: string; error?: unknown }> {
  let made = from, token: string | undefined;
  try {
    for (const step of p.mint) made = { ...made, ...await step.do({ ...o, name: NAME, made, keepToken: (t) => { token = t; } }) };
  } catch (error) { return { made, ...(token ? { token } : {}), error }; }
  return { made, ...(token ? { token } : {}) };
}
async function mint(p: TunnelProvider, o: { credential: string; domain?: string; port: number }): Promise<{ provisioned: Provisioned; token: string }> {
  const r = await steps(p, o);
  if (r.error) throw r.error;
  return { provisioned: p.provisioned(r.made), token: r.token! };
}

describe('Cloudflare Tunnel: the API token alone mints the tunnel, its token and its DNS record', () => {
  it('takes the first zone at hopper.<zone>, sets the edge, gets the token, adds the proxied CNAME; release removes all', async () => {
    const cf = await fakeCloudflare({ token: CF });
    fakes.push(cf);
    const p = cloudflareProvider({ base: cf.url });
    const m = await mint(p, { credential: CF, port: 4790 });
    expect(m.provisioned).toMatchObject({ provider: 'cloudflare', domain: 'hopper.example.com', accountId: 'acc1', zoneId: 'zone1', tunnelId: 'tun1' });
    expect(m.token).toBe('cf-tunnel-token-tun1');
    expect(cf.tunnels.get('tun1')).toMatchObject({ name: NAME, ingress: ingressOf('hopper.example.com', 4790) });
    expect([...cf.records.values()]).toEqual([expect.objectContaining({ name: 'hopper.example.com', content: 'tun1.cfargotunnel.com', proxied: true })]);
    expect(cf.calls.every((c) => c.auth === `Bearer ${CF}`)).toBe(true);

    expect(await p.release({ credential: CF, provisioned: m.provisioned })).toEqual([]);
    expect(cf.tunnels.size).toBe(0);
    expect(cf.records.size).toBe(0);
    // Released again: what is gone is no leftover.
    expect(await p.release({ credential: CF, provisioned: m.provisioned })).toEqual([]);
  });

  it('lets only the API through: the event stream and every other path are 404', () => {
    const rules = ingressOf('h.example.com', 4790) as { path?: string; service: string }[];
    const at = (path: string) => rules.find((r) => r.path === undefined || new RegExp(r.path).test(path))!.service;
    for (const ok of ['/api/state', '/ui/api/jobs', '/ui/auth/api-token', '/ui/auth/token/refresh']) expect(at(ok), ok).toBe('http://hopper:4790');
    for (const no of ['/', '/api/events/stream', '/ui/auth/api-token/x', '/tunnel/agent', '/help/x', '/install.sh']) expect(at(no), no).toBe('http_status:404');
  });

  it('puts a host name asked for in its zone, the longest zone that holds it', async () => {
    const cf = await fakeCloudflare({ token: CF, zones: ['example.com', 'lab.example.com'] });
    fakes.push(cf);
    const m = await mint(cloudflareProvider({ base: cf.url }), { credential: CF, domain: 'h.lab.example.com', port: 1 });
    expect(m.provisioned).toMatchObject({ domain: 'h.lab.example.com', zoneId: 'zone2' });
    await expect(mint(cloudflareProvider({ base: cf.url }), { credential: CF, domain: 'h.other.org', port: 1 })).rejects.toThrow(/in no zone the API token sees \(example\.com, lab\.example\.com\)/);
  });

  it('says why a later step fails; find names the tunnel it made, by the instance\'s name, and release removes it', async () => {
    const cf = await fakeCloudflare({ token: CF, failDns: true });
    fakes.push(cf);
    const p = cloudflareProvider({ base: cf.url });
    const r = await steps(p, { credential: CF, port: 1 });
    expect(String(r.error)).toMatch(/HTTP 400: An A, AAAA, or CNAME record with that host already exists\. \(81053\)/);
    // The tunnel's id was not kept (as when the hopper stopped after the call): it is found by its name.
    const found = await p.find({ credential: CF, name: NAME, made: { ...r.made, tunnelId: undefined } });
    expect(found).toEqual({ provider: 'cloudflare', domain: 'hopper.example.com', accountId: 'acc1', zoneId: 'zone1', tunnelId: 'tun1', dnsRecordId: '' });
    expect(await p.release({ credential: CF, provisioned: found! })).toEqual([]);
    expect(cf.tunnels.size).toBe(0);
    expect(await p.find({ credential: CF, name: NAME, made: { accountId: 'acc1', zoneId: 'zone1', host: 'hopper.example.com' } })).toBeUndefined();
  });

  it('a mint tried again makes no second tunnel or DNS record: each step finds what the try before made', async () => {
    const cf = await fakeCloudflare({ token: CF });
    fakes.push(cf);
    const p = cloudflareProvider({ base: cf.url });
    const first = await mint(p, { credential: CF, port: 1 });
    const again = await mint(p, { credential: CF, port: 1 });
    expect(again.provisioned).toEqual(first.provisioned);
    expect([cf.tunnels.size, cf.records.size]).toEqual([1, 1]);
  });

  it('says a refused token needs the two permissions, and names what it cannot remove', async () => {
    const cf = await fakeCloudflare({ token: CF });
    fakes.push(cf);
    const e = await mint(cloudflareProvider({ base: cf.url }), { credential: 'x'.repeat(40), port: 1 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ProviderError);
    expect((e as Error).message).toMatch(/refused the API token.*Cloudflare Tunnel → Edit and Zone → DNS → Edit/);
    expect(JSON.stringify((e as Error).message)).not.toContain('x'.repeat(40));
    const left = await cloudflareProvider({ base: cf.url }).release({ credential: undefined, provisioned: { provider: 'cloudflare', domain: 'h.example.com', accountId: 'a', zoneId: 'z', tunnelId: 't', dnsRecordId: 'r' } });
    expect(left).toEqual([expect.stringMatching(/DNS record h\.example\.com.*no API token/), expect.stringMatching(/tunnel t.*no API token/)]);
  });
});

describe('ngrok: the API key alone mints the authtoken and takes a domain', () => {
  it('mints a credential and takes the account\'s domain; release revokes the credential and keeps that domain', async () => {
    const ng = await fakeNgrok({ key: NG, domains: { rd_own: 'mine.ngrok-free.app' } });
    fakes.push(ng);
    const p = ngrokProvider({ base: ng.url });
    const m = await mint(p, { credential: NG, port: 1 });
    expect(m.provisioned).toEqual({ provider: 'ngrok', domain: 'mine.ngrok-free.app', credentialId: 'cr_1' });
    expect(m.token).toBe(ng.credentials.get('cr_1'));
    expect(await p.release({ credential: NG, provisioned: m.provisioned })).toEqual([]);
    expect(ng.credentials.size).toBe(0);
    expect([...ng.domains.values()]).toEqual(['mine.ngrok-free.app']);
  });

  it('reserves a domain asked for, or one of its own, and removes it on release', async () => {
    const ng = await fakeNgrok({ key: NG });
    fakes.push(ng);
    const p = ngrokProvider({ base: ng.url });
    const asked = await mint(p, { credential: NG, domain: 'h.example.ngrok.app', port: 1 });
    expect(asked.provisioned).toMatchObject({ domain: 'h.example.ngrok.app', reservedDomainId: expect.any(String) });
    expect(await p.release({ credential: NG, provisioned: asked.provisioned })).toEqual([]);
    expect(ng.domains.size).toBe(0);
    const picked = await mint(p, { credential: NG, port: 1 });
    expect(picked.provisioned).toMatchObject({ domain: `${NAME}.ngrok.app`, reservedDomainId: expect.any(String) });
    // Tried again: the credential a try before made is revoked (its authtoken is not kept), and its domain found.
    const again = await mint(p, { credential: NG, port: 1 });
    expect(again.provisioned).toMatchObject({ domain: `${NAME}.ngrok.app`, reservedDomainId: (picked.provisioned as { reservedDomainId: string }).reservedDomainId });
    expect([...ng.credentials.keys()]).toEqual([(again.provisioned as { credentialId: string }).credentialId]);
    expect(ng.domains.size).toBe(1);
  });

  it('says where to claim a domain when none can be had; find names the credential it minted, and release revokes it', async () => {
    const ng = await fakeNgrok({ key: NG, canReserve: false });
    fakes.push(ng);
    const p = ngrokProvider({ base: ng.url });
    const r = await steps(p, { credential: NG, port: 1 });
    expect(String(r.error)).toMatch(/may not reserve domains.*dashboard\.ngrok\.com\/domains/);
    const found = await p.find({ credential: NG, name: NAME, made: {} });
    expect(found).toEqual({ provider: 'ngrok', domain: '', credentialId: 'cr_1' });
    expect(await p.release({ credential: NG, provisioned: found! })).toEqual([]);
    expect(ng.credentials.size).toBe(0);
  });

  it('says a refused API key, and keeps an authtoken given by hand before (nothing to revoke)', async () => {
    const ng = await fakeNgrok({ key: NG });
    fakes.push(ng);
    await expect(mint(ngrokProvider({ base: ng.url }), { credential: 'y'.repeat(40), port: 1 })).rejects.toThrow(/ngrok refused the API key.*not valid/);
    expect(await ngrokProvider({ base: ng.url }).release({ credential: undefined, provisioned: { provider: 'ngrok', domain: 'h.ngrok.app' } })).toEqual([]);
    expect(ng.calls.filter((c) => c.line.startsWith('DELETE'))).toEqual([]);
  });
});
