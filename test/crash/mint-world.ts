// The remote access mint (issue #1609) under the crash harness (issue #1954): a first hopper turns remote access on and
// is killed at a kill point of the mint saga; a second hopper on the same database goes on. The providers' fakes live
// in the test process, so they count each effect whatever process made it.
import { expect } from 'vitest';
import type { RemoteAccessProvider } from '../../src/domain/remote-access.ts';
import { mintSagas, type MintHost } from '../../src/http/remote-access-mint.ts';
import { cloudflareProvider } from '../../src/remote-access/cloudflare.ts';
import { ngrokProvider } from '../../src/remote-access/ngrok.ts';
import { killPointsOf } from '../../src/sagas/kill-points.ts';
import { openDb } from '../../src/store/db.ts';
import { tempDbPath } from '../support/app.ts';
import { databaseUrlFor } from '../support/database.ts';
import { waitFor } from '../support/wait.ts';
import { fakeCloudflare, fakeNgrok, type FakeCloudflare, type FakeNgrok } from '../remote-access/fake-providers.ts';
import { endLeases, killedAt, startHost, type CrashHost, type HostOptions } from './harness.ts';

export const CREDENTIAL = { cloudflare: 'c'.repeat(40), ngrok: 'n'.repeat(40) } as const satisfies Record<RemoteAccessProvider, string>;
/** The most one scenario takes: two hoppers start, one is killed. */
export const SCENARIO_MS = 120_000;

/** Every kill point of each provider's mint saga, in step order. */
export const MINT_KILL_POINTS: Record<RemoteAccessProvider, string[]> = Object.fromEntries(
  mintSagas({ providers: { cloudflare: cloudflareProvider(), ngrok: ngrokProvider() }, host: {} as MintHost })
    .map((d) => [d.kind.endsWith('cloudflare') ? 'cloudflare' : 'ngrok', killPointsOf(d)]),
) as Record<RemoteAccessProvider, string[]>;

export const doPoints = (p: RemoteAccessProvider): string[] => MINT_KILL_POINTS[p].filter((k) => k.endsWith('-do'));
export const compensatePoints = (p: RemoteAccessProvider): string[] => MINT_KILL_POINTS[p].filter((k) => k.endsWith('-compensate'));

export interface World {
  dbPath: string;
  url: string;
  cf: FakeCloudflare;
  ng: FakeNgrok;
  host(o?: { killPoint?: string; databaseUrl?: string }): Promise<CrashHost>;
  close(): Promise<void>;
}

/** The fakes and a fresh database. `fail`: the provider refuses its last mint call, so the saga compensates. */
export async function world(o: { fail?: boolean } = {}): Promise<World> {
  const cf = await fakeCloudflare({ token: CREDENTIAL.cloudflare, ...(o.fail ? { failDns: true } : {}) });
  const ng = await fakeNgrok({ key: CREDENTIAL.ngrok, ...(o.fail ? { canReserve: false } : {}) });
  const db = tempDbPath();
  const url = databaseUrlFor(db.dbPath);
  const base: Omit<HostOptions, 'killPoint'> = { dbPath: db.dbPath, databaseUrl: url, fakes: { cloudflare: cf.url, ngrok: ng.url } };
  return {
    dbPath: db.dbPath, url, cf, ng,
    host: (h = {}) => startHost({ ...base, ...(h.databaseUrl ? { databaseUrl: h.databaseUrl } : {}), ...(h.killPoint ? { killPoint: h.killPoint } : {}) }),
    close: async () => { await cf.close(); await ng.close(); db.cleanup(); },
  };
}

/** Turns remote access on at `provider` (the request may never be answered: its host is killed). */
export const turnOn = (h: CrashHost, provider: RemoteAccessProvider) =>
  h.ui('/ui/api/remote-access', { provider, credential: CREDENTIAL[provider], enabled: true });

/** The sagas not ended, by kind and state. */
export function openSagas(url: string): { kind: string; state: string }[] {
  const db = openDb(url);
  try { return db.all("SELECT kind, state FROM sagas WHERE state IN ('running', 'compensating')") as { kind: string; state: string }[]; } finally { db.close(); }
}

/** The steps of the one mint saga, as the database holds them. */
export function mintSteps(url: string): { name: string; state: string }[] {
  const db = openDb(url);
  try {
    const rows = db.all('SELECT body FROM sagas');
    expect(rows).toHaveLength(1);
    return (JSON.parse(rows[0]!.body as string) as { steps: { name: string; state: string }[] }).steps;
  } finally { db.close(); }
}

interface View { enabled: boolean; provisioned?: { provider: string } }

/** After a first host was killed: its leases end, a second host starts and the mint saga ends there; the second host. */
export async function goOn(w: World, until: (v: View) => boolean): Promise<CrashHost> {
  endLeases(w.url);
  const b = await w.host();
  await waitFor(async () => {
    const v = await b.get<View>('/api/remote-access');
    return until(v) && openSagas(w.url).length === 0 ? v : undefined;
  }, { timeoutMs: 60_000, what: 'the second hopper to end the mint saga' });
  return b;
}

/** Remote access is on at `provider`, and each effect of the mint was made once. */
export function mintedOnce(w: World, provider: RemoteAccessProvider): void {
  if (provider === 'cloudflare') {
    expect([w.cf.tunnels.size, w.cf.records.size]).toEqual([1, 1]);
    const [tunnelId] = [...w.cf.tunnels.keys()];
    expect([...w.cf.records.values()].map((r) => r.content)).toEqual([`${tunnelId}.cfargotunnel.com`]);
  } else expect([w.ng.credentials.size, w.ng.domains.size]).toEqual([1, 1]);
}

/** Nothing the mint made is left at the provider. */
export function nothingLeft(w: World): void {
  expect([w.cf.tunnels.size, w.cf.records.size, w.ng.credentials.size, w.ng.domains.size]).toEqual([0, 0, 0, 0]);
}

/** A first host killed at `point` while it mints at `provider`, a second that goes on: the second. */
export async function killedThenGoneOn(w: World, provider: RemoteAccessProvider, point: string, compensates: boolean): Promise<CrashHost> {
  const a = await w.host({ killPoint: point });
  await turnOn(a, provider);
  await killedAt(a, point);
  const b = await goOn(w, (v) => (compensates ? !v.enabled : v.enabled && v.provisioned?.provider === provider));
  if (compensates) nothingLeft(w); else mintedOnce(w, provider);
  return b;
}
