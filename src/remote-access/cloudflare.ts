// Cloudflare Tunnel (issue #968, design.md "Remote access"), with the admin's API token (Account → Cloudflare Tunnel →
// Edit, Zone → DNS → Edit). A mint finds the zone the host name is in (or takes the first zone the token sees, at
// `hopper.<zone>`), creates a named tunnel the dashboard manages (`config_src: cloudflare`), sets its ingress — the
// tunnel's edge: only the API paths reach the hopper, every other path is 404 —, gets its token, and adds the proxied
// CNAME to `<tunnel>.cfargotunnel.com`. A release removes the DNS record, the tunnel's connections and the tunnel.
import { randomBytes } from 'node:crypto';
import type { Provisioned } from '../domain/remote-access.ts';
import { call, ProviderError, type Minted, type TunnelProvider } from './provider.ts';

export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';

interface Envelope<T> { success?: boolean; errors?: { code?: number; message?: string }[]; result?: T }
interface Zone { id: string; name: string; account?: { id?: string } }

/** The tunnel's ingress (cloudflared's rules, first match wins): the event stream 404, the API to the hopper, the rest 404. */
export function ingressOf(domain: string, port: number): unknown[] {
  return [
    { hostname: domain, path: '^/api/events/stream', service: 'http_status:404' },
    { hostname: domain, path: '^/(api/|ui/api/|ui/auth/api-token$|ui/auth/token/refresh$)', service: `http://hopper:${port}` },
    { service: 'http_status:404' },
  ];
}

export function cloudflareProvider(o: { base?: string } = {}): TunnelProvider {
  const base = o.base ?? CLOUDFLARE_API;
  const who = 'Cloudflare\'s API';

  async function api<T>(token: string, path: string, method = 'GET', body?: unknown): Promise<T> {
    const r = await call(base, path, { method, headers: { authorization: `Bearer ${token}` }, body, who });
    const env = (r.body ?? {}) as Envelope<T>;
    if (r.status >= 200 && r.status < 300 && env.success !== false) return env.result as T;
    const errors = (env.errors ?? []).map((e) => `${e.message ?? 'error'}${e.code ? ` (${e.code})` : ''}`).join('; ');
    if (r.status === 401 || r.status === 403) throw new ProviderError(`Cloudflare refused the API token for ${method} ${path.split('?')[0]}: ${errors || `HTTP ${r.status}`}. It needs Account → Cloudflare Tunnel → Edit and Zone → DNS → Edit`);
    throw new ProviderError(`Cloudflare answered ${method} ${path.split('?')[0]} with HTTP ${r.status}: ${errors || 'no reason given'}`);
  }

  const self: TunnelProvider = {
    provider: 'cloudflare',
    async mint({ credential, domain, port }): Promise<Minted> {
      const zones = await api<Zone[]>(credential, '/zones?per_page=50&status=active');
      if (!Array.isArray(zones) || zones.length === 0) throw new ProviderError('the API token sees no active zone at Cloudflare: give it Zone → DNS → Edit on the zone the hopper\'s host name is in');
      const zone = domain === undefined
        ? zones[0]!
        : zones.filter((z) => domain === z.name || domain.endsWith(`.${z.name}`)).sort((a, b) => b.name.length - a.name.length)[0];
      if (!zone) throw new ProviderError(`${domain} is in no zone the API token sees (${zones.map((z) => z.name).join(', ')})`);
      const accountId = zone.account?.id;
      if (!accountId) throw new ProviderError(`Cloudflare named no account for the zone ${zone.name}`);
      const host = domain ?? `hopper.${zone.name}`;
      const tunnel = await api<{ id: string }>(credential, `/accounts/${accountId}/cfd_tunnel`, 'POST', { name: `hopper-${randomBytes(4).toString('hex')}`, config_src: 'cloudflare' });
      const made: Provisioned = { provider: 'cloudflare', domain: host, accountId, zoneId: zone.id, tunnelId: tunnel.id, dnsRecordId: '' };
      try {
        await api(credential, `/accounts/${accountId}/cfd_tunnel/${tunnel.id}/configurations`, 'PUT', { config: { ingress: ingressOf(host, port) } });
        const token = await api<string>(credential, `/accounts/${accountId}/cfd_tunnel/${tunnel.id}/token`);
        if (typeof token !== 'string' || token.length === 0) throw new ProviderError('Cloudflare answered no token for the tunnel');
        const record = await api<{ id: string }>(credential, `/zones/${zone.id}/dns_records`, 'POST', {
          type: 'CNAME', name: host, content: `${tunnel.id}.cfargotunnel.com`, proxied: true, comment: 'hopper remote access',
        });
        return { provisioned: { ...made, dnsRecordId: record.id }, token };
      } catch (e) {
        await self.release({ credential, provisioned: made });
        throw e;
      }
    },
    async release({ credential, provisioned: p }) {
      if (p.provider !== 'cloudflare') return [];
      const left: string[] = [];
      const record = `the DNS record ${p.domain} (zone ${p.zoneId})`;
      const tunnel = `the tunnel ${p.tunnelId} (account ${p.accountId})`;
      if (credential === undefined) return [...(p.dnsRecordId ? [record] : []), tunnel].map((t) => `${t}: no API token is kept to remove it`);
      const gone = async (what: string, path: string): Promise<void> => {
        try {
          await api(credential, path, 'DELETE');
        } catch (e) {
          if (!/HTTP 404/.test((e as Error).message)) left.push(`${what}: ${(e as Error).message}`);
        }
      };
      if (p.dnsRecordId) await gone(record, `/zones/${p.zoneId}/dns_records/${p.dnsRecordId}`);
      await gone(`the connections of ${tunnel}`, `/accounts/${p.accountId}/cfd_tunnel/${p.tunnelId}/connections`);
      await gone(tunnel, `/accounts/${p.accountId}/cfd_tunnel/${p.tunnelId}`);
      return left;
    },
  };
  return self;
}
