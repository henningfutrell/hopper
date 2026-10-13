// ngrok (issue #968, design.md "Remote access"), with the admin's API key. A mint creates a tunnel credential — the
// authtoken the ngrok agent runs with — and takes a domain: the one asked for (reserved now if the account does not have
// it), else the account's first reserved domain, else one it reserves. A release revokes that credential and removes a
// domain the hopper reserved; a domain the account had stays.
import { randomBytes } from 'node:crypto';
import type { Provisioned } from '../domain/remote-access.ts';
import { call, ProviderError, type Minted, type TunnelProvider } from './provider.ts';

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

  const self: TunnelProvider = {
    provider: 'ngrok',
    async mint({ credential, domain }): Promise<Minted> {
      const minted = await api<{ id: string; token: string }>(credential, '/credentials', 'POST', { description: 'hopper remote access' });
      if (typeof minted?.token !== 'string' || minted.token.length === 0) throw new ProviderError('ngrok answered no authtoken for the new credential');
      const made: Provisioned = { provider: 'ngrok', domain: '', credentialId: minted.id };
      try {
        const listed = (await api<{ reserved_domains?: { id: string; domain: string }[] }>(credential, '/reserved_domains')).reserved_domains ?? [];
        const have = domain === undefined ? listed[0] : listed.find((d) => d.domain === domain);
        if (have) return { provisioned: { ...made, domain: have.domain }, token: minted.token };
        const name = domain ?? `hopper-${randomBytes(4).toString('hex')}.ngrok.app`;
        let reserved: { id: string; domain: string };
        try {
          reserved = await api(credential, '/reserved_domains', 'POST', { domain: name, description: 'hopper remote access' });
        } catch (e) {
          throw new ProviderError(`ngrok did not reserve ${name}: ${(e as Error).message}. Claim a domain at https://dashboard.ngrok.com/domains, then turn remote access on again`);
        }
        return { provisioned: { ...made, domain: reserved.domain, reservedDomainId: reserved.id }, token: minted.token };
      } catch (e) {
        await self.release({ credential, provisioned: made });
        throw e;
      }
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
