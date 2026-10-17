// A tunnel provider (issues #968, #1609, design.md "Remote access"): what the hopper asks of Cloudflare or ngrok with the
// admin's one credential. Its mint is a list of steps — each one or two REST calls — that the remote access mint saga runs
// in order, keeping what each made (an id, the host name) before the next call; a step tried again after a stop finds
// what it made by the instance's fixed name, and makes nothing twice. `find` names what a mint cut short made, `release`
// revokes and removes it, and names what it could not remove. Plain fetch: no provider SDK (the calls are fewer than an
// SDK's setup).
import type { Provisioned, RemoteAccessProvider } from '../domain/remote-access.ts';

/** What a mint made so far, kept in its saga's data before the next call: the host name and the ids. Never a secret. */
export type Made = Partial<Record<'host' | 'accountId' | 'zoneId' | 'tunnelId' | 'dnsRecordId' | 'credentialId' | 'reservedDomainId', string>>;

export interface MintContext {
  credential: string;
  /** The host name the admin asked for; absent: the provider picks one. */
  domain?: string;
  /** The hopper's port: the tunnel's target. */
  port: number;
  /** The instance's fixed name for what the mint makes (`hopper-<instance id>`): a step tried again finds what it made by it. */
  name: string;
  /** What the steps before made. */
  made: Made;
  /** Keeps the tunnel's token, sealed, as soon as the provider answers it. */
  keepToken(token: string): void;
}

/** One step of a mint: what it made, merged into the mint's `Made`. */
export interface MintStep { name: string; do(c: MintContext): Promise<Made> }

export interface TunnelProvider {
  readonly provider: RemoteAccessProvider;
  /** The mint's steps, in order; the tunnel's token is kept by one of them. */
  readonly mint: readonly MintStep[];
  /** What a mint whose every step is done made. */
  provisioned(made: Made): Provisioned;
  /** What a mint cut short made: its ids, and what it made but did not keep yet, found by `name`. Undefined: nothing. */
  find(o: { credential: string | undefined; name: string; made: Made }): Promise<Provisioned | undefined>;
  /** Revokes and removes what `provisioned` names; each thing it could not remove, in words. Never throws. */
  release(o: { credential: string | undefined; provisioned: Provisioned }): Promise<string[]>;
}

/** The provider refused, or did not answer: the words say which, and what to do. Never a secret. */
export class ProviderError extends Error {}

/** The name the hopper gives what it mints at a provider: the same at every try, and per instance. */
export const mintName = (instanceId: string): string => `hopper-${instanceId}`;

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
