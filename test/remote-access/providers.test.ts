// The tunnel providers (issue #968): with one credential, the hopper mints the tunnel at Cloudflare or ngrok, and removes
// what it minted again. Against loopback fakes of their APIs.
import { afterEach, describe, expect, it } from 'vitest';
import { cloudflareProvider, ingressOf } from '../../src/remote-access/cloudflare.ts';
import { ngrokProvider } from '../../src/remote-access/ngrok.ts';
import { ProviderError } from '../../src/remote-access/provider.ts';
import { fakeCloudflare, fakeNgrok, type Fake } from './fake-providers.ts';

const CF = 'c'.repeat(40);
const NG = 'n'.repeat(40);
const fakes: Fake[] = [];
afterEach(async () => { for (const f of fakes.splice(0)) await f.close(); });

describe('Cloudflare Tunnel: the API token alone mints the tunnel, its token and its DNS record', () => {
  it('takes the first zone at hopper.<zone>, sets the edge, gets the token, adds the proxied CNAME; release removes all', async () => {
    const cf = await fakeCloudflare({ token: CF });
    fakes.push(cf);
    const p = cloudflareProvider({ base: cf.url });
    const m = await p.mint({ credential: CF, port: 4790 });
    expect(m.provisioned).toMatchObject({ provider: 'cloudflare', domain: 'hopper.example.com', accountId: 'acc1', zoneId: 'zone1', tunnelId: 'tun1' });
    expect(m.token).toBe('cf-tunnel-token-tun1');
    expect(cf.tunnels.get('tun1')).toMatchObject({ name: expect.stringMatching(/^hopper-[0-9a-f]{8}$/), ingress: ingressOf('hopper.example.com', 4790) });
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
    const m = await cloudflareProvider({ base: cf.url }).mint({ credential: CF, domain: 'h.lab.example.com', port: 1 });
    expect(m.provisioned).toMatchObject({ domain: 'h.lab.example.com', zoneId: 'zone2' });
    await expect(cloudflareProvider({ base: cf.url }).mint({ credential: CF, domain: 'h.other.org', port: 1 })).rejects.toThrow(/in no zone the API token sees \(example\.com, lab\.example\.com\)/);
  });

  it('removes the tunnel it made when a later step fails, and says why', async () => {
    const cf = await fakeCloudflare({ token: CF, failDns: true });
    fakes.push(cf);
    await expect(cloudflareProvider({ base: cf.url }).mint({ credential: CF, port: 1 })).rejects.toThrow(/HTTP 400: An A, AAAA, or CNAME record with that host already exists\. \(81053\)/);
    expect(cf.tunnels.size).toBe(0);
  });

  it('says a refused token needs the two permissions, and names what it cannot remove', async () => {
    const cf = await fakeCloudflare({ token: CF });
    fakes.push(cf);
    const e = await cloudflareProvider({ base: cf.url }).mint({ credential: 'x'.repeat(40), port: 1 }).catch((x: unknown) => x);
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
    const m = await p.mint({ credential: NG, port: 1 });
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
    const asked = await p.mint({ credential: NG, domain: 'h.example.ngrok.app', port: 1 });
    expect(asked.provisioned).toMatchObject({ domain: 'h.example.ngrok.app', reservedDomainId: expect.any(String) });
    expect(await p.release({ credential: NG, provisioned: asked.provisioned })).toEqual([]);
    expect(ng.domains.size).toBe(0);
    const picked = await p.mint({ credential: NG, port: 1 });
    expect(picked.provisioned.domain).toMatch(/^hopper-[0-9a-f]{8}\.ngrok\.app$/);
  });

  it('revokes the credential it minted when no domain can be had, and says where to claim one', async () => {
    const ng = await fakeNgrok({ key: NG, canReserve: false });
    fakes.push(ng);
    await expect(ngrokProvider({ base: ng.url }).mint({ credential: NG, port: 1 })).rejects.toThrow(/may not reserve domains.*dashboard\.ngrok\.com\/domains/);
    expect(ng.credentials.size).toBe(0);
  });

  it('says a refused API key, and keeps an authtoken given by hand before (nothing to revoke)', async () => {
    const ng = await fakeNgrok({ key: NG });
    fakes.push(ng);
    await expect(ngrokProvider({ base: ng.url }).mint({ credential: 'y'.repeat(40), port: 1 })).rejects.toThrow(/ngrok refused the API key.*not valid/);
    expect(await ngrokProvider({ base: ng.url }).release({ credential: undefined, provisioned: { provider: 'ngrok', domain: 'h.ngrok.app' } })).toEqual([]);
    expect(ng.calls.filter((c) => c.line.startsWith('DELETE'))).toEqual([]);
  });
});
