// A tunnel provider (issue #968, design.md "Remote access"): what the hopper asks of Cloudflare or ngrok with the admin's
// one credential. `mint` makes everything the tunnel runs with — its token, its host name, at Cloudflare its DNS record —
// and undoes what it made when a later step fails; `release` revokes and removes what the hopper minted, and names what it
// could not remove. Each is a handful of REST calls over fetch: no provider SDK (the calls are fewer than an SDK's setup).
import type { Provisioned, RemoteAccessProvider } from '../domain/remote-access.ts';

/** What a mint made: what to remove again, and the token the tunnel service runs the tunnel with. */
export interface Minted { provisioned: Provisioned; token: string }

export interface TunnelProvider {
  readonly provider: RemoteAccessProvider;
  /** Mints the tunnel at `domain`, or at a host name the provider picks; `port` is the hopper's, the tunnel's target. */
  mint(o: { credential: string; domain?: string; port: number }): Promise<Minted>;
  /** Revokes and removes what `provisioned` names; each thing it could not remove, in words. Never throws. */
  release(o: { credential: string | undefined; provisioned: Provisioned }): Promise<string[]>;
}

/** The provider refused, or did not answer: the words say which, and what to do. Never a secret. */
export class ProviderError extends Error {}

const TIMEOUT_MS = 15_000;

/** One JSON call; the parsed body and the status, or ProviderError when nothing answered. */
export async function call(base: string, path: string, o: { method?: string; headers: Record<string, string>; body?: unknown; who: string }): Promise<{ status: number; body: unknown }> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: o.method ?? 'GET',
      headers: { ...o.headers, ...(o.body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new ProviderError(`${o.who} does not answer (${e instanceof Error ? e.message : String(e)})`);
  }
  const text = await res.text();
  let body: unknown;
  try { body = text === '' ? undefined : JSON.parse(text); } catch { body = undefined; }
  return { status: res.status, body };
}
