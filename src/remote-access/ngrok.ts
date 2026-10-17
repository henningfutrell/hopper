// ngrok (issues #968, #1609, design.md "Remote access"), with the admin's API key. A mint creates a tunnel credential —
// the authtoken the ngrok agent runs with — and takes a domain: the one asked for (reserved now if the account does not
// have it), else the instance's own (`<name>.ngrok.app`) or the account's first reserved domain, else it reserves the
// instance's own. What it makes carries the instance's name as its metadata, so a try after a stop finds it. A release
// revokes that credential and removes a domain the hopper reserved; a domain the account had stays.
import { call, ProviderError, type TunnelProvider } from './provider.ts';

export const NGROK_API = 'https://api.ngrok.com';

interface NgrokError { msg?: string; error_code?: string }

export function ngrokProvider(o: { base?: string } = {}): TunnelProvider {
  const base = o.base ?? NGROK_API;
  const who = 'ngrok\'s API';

  async function api<T>(key: string, path: string, method = 'GET', body?: unknown): Promise<T> {
    const r = await call(base, path, { method, headers: { authorization: `Bearer ${key}`, 'ngrok-version': '2' }, body, who });
    if (r.status >= 200 && r.status < 300) return r.body as T;
    const e = (r.body ?? {}) as NgrokError;
    const why = `${e.msg ?? 'no reason given'}${e.error_code ? ` (${e.error_code})` : ''}`;
    if (r.status === 401 || r.status === 403) throw new ProviderError(`ngrok refused the API key for ${method} ${path}: ${why}`);
    throw new ProviderError(`ngrok answered ${method} ${path} with HTTP ${r.status}: ${why}`);
  }

  /** The reserved domains of the account; `ours`: reserved by this instance's mints (their metadata is its name). */
  const reservedDomains = async (key: string): Promise<{ id: string; domain: string; metadata?: string }[]> =>
    (await api<{ reserved_domains?: { id: string; domain: string; metadata?: string }[] }>(key, '/reserved_domains')).reserved_domains ?? [];
  /** The tunnel credentials this instance's mints made (their metadata is its name). */
  const credentialsNamed = async (key: string, name: string): Promise<string[]> =>
    ((await api<{ credentials?: { id: string; metadata?: string }[] }>(key, '/credentials')).credentials ?? []).filter((c) => c.metadata === name).map((c) => c.id);

  const self: TunnelProvider = {
    provider: 'ngrok',
    mint: [
      {
        // Its authtoken is answered only when it is made: one a try before made is revoked, and a new one made.
        name: 'credential',
        async do({ credential, name, keepToken }) {
          for (const id of await credentialsNamed(credential, name)) await api(credential, `/credentials/${id}`, 'DELETE');
          const minted = await api<{ id: string; token: string }>(credential, '/credentials', 'POST', { description: 'hopper remote access', metadata: name });
          if (typeof minted?.token !== 'string' || minted.token.length === 0) throw new ProviderError('ngrok answered no authtoken for the new credential');
          keepToken(minted.token);
          return { credentialId: minted.id };
        },
      },
      {
        name: 'domain',
        async do({ credential, domain, name }) {
          const listed = await reservedDomains(credential);
          const want = domain ?? `${name}.ngrok.app`;
          const found = listed.find((d) => d.domain === want);
          if (found) return { host: found.domain, ...(found.metadata === name ? { reservedDomainId: found.id } : {}) };
          if (domain === undefined && listed[0]) return { host: listed[0].domain, ...(listed[0].metadata === name ? { reservedDomainId: listed[0].id } : {}) };
          let reserved: { id: string; domain: string };
          try {
            reserved = await api(credential, '/reserved_domains', 'POST', { domain: want, description: 'hopper remote access', metadata: name });
          } catch (e) {
            throw new ProviderError(`ngrok did not reserve ${want}: ${(e as Error).message}. Claim a domain at https://dashboard.ngrok.com/domains, then turn remote access on again`);
          }
          return { host: reserved.domain, reservedDomainId: reserved.id };
        },
      },
    ],
    provisioned(made) {
      if (!made.host || !made.credentialId) throw new Error('the mint kept no host or credential');
      return { provider: 'ngrok', domain: made.host, credentialId: made.credentialId, ...(made.reservedDomainId ? { reservedDomainId: made.reservedDomainId } : {}) };
    },
    async find({ credential, name, made }) {
      const credentialId = made.credentialId ?? (credential === undefined ? undefined : (await credentialsNamed(credential, name))[0]);
      const domain = made.reservedDomainId || credential === undefined ? undefined : (await reservedDomains(credential)).find((d) => d.metadata === name && (made.host === undefined || d.domain === made.host));
      const reservedDomainId = made.reservedDomainId ?? domain?.id;
      if (!credentialId && !reservedDomainId) return undefined;
      return { provider: 'ngrok', domain: made.host ?? domain?.domain ?? '', ...(credentialId ? { credentialId } : {}), ...(reservedDomainId ? { reservedDomainId } : {}) };
    },
    async release({ credential, provisioned: p }) {
      if (p.provider !== 'ngrok') return [];
      const things = [
        ...(p.credentialId ? [{ what: `the tunnel credential ${p.credentialId}`, path: `/credentials/${p.credentialId}` }] : []),
        ...(p.reservedDomainId ? [{ what: `the reserved domain ${p.domain}`, path: `/reserved_domains/${p.reservedDomainId}` }] : []),
      ];
      if (credential === undefined) return things.map((t) => `${t.what}: no API key is kept to remove it`);
      const left: string[] = [];
      for (const t of things) {
        try {
          await api(credential, t.path, 'DELETE');
        } catch (e) {
          if (!/HTTP 404/.test((e as Error).message)) left.push(`${t.what}: ${(e as Error).message}`);
        }
      }
      return left;
    },
  };
  return self;
}
