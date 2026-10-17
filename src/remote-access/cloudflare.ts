// Cloudflare Tunnel (issues #968, #1609, design.md "Remote access"), with the admin's API token (Account → Cloudflare
// Tunnel → Edit, Zone → DNS → Edit). A mint finds the zone the host name is in (or takes the first zone the token sees, at
// `hopper.<zone>`), creates the instance's named tunnel the dashboard manages (`config_src: cloudflare`) — or finds the
// one a try before made —, sets its ingress — the tunnel's edge: only the API paths reach the hopper, every other path is
// 404 —, gets its token, and adds the proxied CNAME to `<tunnel>.cfargotunnel.com`, or finds it. A release removes the
// DNS record, the tunnel's connections and the tunnel.
import { call, ProviderError, type Made, type TunnelProvider } from './provider.ts';

export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';

interface Envelope<T> { success?: boolean; errors?: { code?: number; message?: string }[]; result?: T }
interface Zone { id: string; name: string; account?: { id?: string } }

/** The tunnel's ingress (cloudflared's rules, first match wins): the event stream 404, the API to the hopper, the rest 404. */
export function ingressOf(domain: string, port: number): unknown[] {
  return [
    { hostname: domain, path: '^/api/events/stream', service: 'http_status:404' },
    { hostname: domain, path: '^/(api/|ui/api/|ui/auth/api-token$|ui/auth/token/refresh$|ui/auth/device-grant$|ui/auth/device-grant/poll$)', service: `http://hopper:${port}` },
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

  const target = (tunnelId: string): string => `${tunnelId}.cfargotunnel.com`;
  /** The tunnel named `name`, not deleted: one a try before made. */
  const tunnelNamed = async (credential: string, accountId: string, name: string): Promise<string | undefined> =>
    (await api<{ id: string; name: string }[]>(credential, `/accounts/${accountId}/cfd_tunnel?name=${encodeURIComponent(name)}&is_deleted=false`))
      ?.find((t) => t.name === name)?.id;
  /** The CNAME at `host` to the tunnel: one a try before made. */
  const recordTo = async (credential: string, zoneId: string, host: string, tunnelId: string): Promise<string | undefined> =>
    (await api<{ id: string; content?: string }[]>(credential, `/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(host)}`))
      ?.find((r) => r.content === target(tunnelId))?.id;
  const need = (made: Made, ...keys: (keyof Made)[]): Required<Made> => {
    for (const k of keys) if (!made[k]) throw new Error(`the mint kept no ${k}`);
    return made as Required<Made>;
  };

  const self: TunnelProvider = {
    provider: 'cloudflare',
    mint: [
      {
        name: 'zone',
        async do({ credential, domain }) {
          const zones = await api<Zone[]>(credential, '/zones?per_page=50&status=active');
          if (!Array.isArray(zones) || zones.length === 0) throw new ProviderError('the API token sees no active zone at Cloudflare: give it Zone → DNS → Edit on the zone the hopper\'s host name is in');
          const zone = domain === undefined
            ? zones[0]!
            : zones.filter((z) => domain === z.name || domain.endsWith(`.${z.name}`)).sort((a, b) => b.name.length - a.name.length)[0];
          if (!zone) throw new ProviderError(`${domain} is in no zone the API token sees (${zones.map((z) => z.name).join(', ')})`);
          const accountId = zone.account?.id;
          if (!accountId) throw new ProviderError(`Cloudflare named no account for the zone ${zone.name}`);
          return { host: domain ?? `hopper.${zone.name}`, accountId, zoneId: zone.id };
        },
      },
      {
        name: 'tunnel',
        async do({ credential, name, made }) {
          const { accountId } = need(made, 'accountId');
          const tunnelId = await tunnelNamed(credential, accountId, name)
            ?? (await api<{ id: string }>(credential, `/accounts/${accountId}/cfd_tunnel`, 'POST', { name, config_src: 'cloudflare' })).id;
          return { tunnelId };
        },
      },
      {
        name: 'ingress',
        async do({ credential, port, made }) {
          const { accountId, tunnelId, host } = need(made, 'accountId', 'tunnelId', 'host');
          await api(credential, `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, 'PUT', { config: { ingress: ingressOf(host, port) } });
          return {};
        },
      },
      {
        name: 'token',
        async do({ credential, made, keepToken }) {
          const { accountId, tunnelId } = need(made, 'accountId', 'tunnelId');
          const token = await api<string>(credential, `/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`);
          if (typeof token !== 'string' || token.length === 0) throw new ProviderError('Cloudflare answered no token for the tunnel');
          keepToken(token);
          return {};
        },
      },
      {
        name: 'dns',
        async do({ credential, made }) {
          const { zoneId, host, tunnelId } = need(made, 'zoneId', 'host', 'tunnelId');
          const dnsRecordId = await recordTo(credential, zoneId, host, tunnelId)
            ?? (await api<{ id: string }>(credential, `/zones/${zoneId}/dns_records`, 'POST', {
              type: 'CNAME', name: host, content: target(tunnelId), proxied: true, comment: 'hopper remote access',
            })).id;
          return { dnsRecordId };
        },
      },
    ],
    provisioned(made) {
      const m = need(made, 'host', 'accountId', 'zoneId', 'tunnelId', 'dnsRecordId');
      return { provider: 'cloudflare', domain: m.host, accountId: m.accountId, zoneId: m.zoneId, tunnelId: m.tunnelId, dnsRecordId: m.dnsRecordId };
    },
    async find({ credential, name, made }) {
      if (!made.accountId || !made.zoneId || !made.host) return undefined;
      const tunnelId = made.tunnelId ?? (credential === undefined ? undefined : await tunnelNamed(credential, made.accountId, name));
      if (!tunnelId) return undefined;
      const dnsRecordId = made.dnsRecordId ?? (credential === undefined ? undefined : await recordTo(credential, made.zoneId, made.host, tunnelId));
      return { provider: 'cloudflare', domain: made.host, accountId: made.accountId, zoneId: made.zoneId, tunnelId, dnsRecordId: dnsRecordId ?? '' };
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
