// The remote access mint as a saga (issue #1609, design.md "Remote access: the mint as a saga"): one kind per provider,
// its steps the provider's mint steps, then `record`. Each step keeps what it made (an id, the host name) in the saga's
// data before the next call, and its token, sealed, as soon as the provider answers it; a step tried again after a stop,
// on this host or another, finds what the try before made by the instance's fixed name. `record` keeps the tunnel in the
// remote access settings, only while they still ask for it. The compensation, on the first step: what the mint made,
// kept or found by name, is released, and remote access turned off when it still asked for this tunnel.
import { PROVIDERS, type Provisioned, type RemoteAccessProvider } from '../domain/remote-access.ts';
import type { Saga } from '../domain/sagas.ts';
import type { Made, TunnelProvider } from '../remote-access/provider.ts';
import type { SagaDefinition, SagaStepContext, SagaStepDefinition } from '../sagas/coordinator.ts';

export const MINT_SAGA = {
  cloudflare: 'remote-access-mint-cloudflare', ngrok: 'remote-access-mint-ngrok',
} as const satisfies Record<RemoteAccessProvider, string>;

export const isMintSaga = (s: Pick<Saga, 'kind'>): boolean => (Object.values(MINT_SAGA) as string[]).includes(s.kind);

/** What a mint saga begins with: never a secret. `domain`: the host name asked for; `name`: the instance's fixed name. */
export interface MintData { domain?: string; port: number; name: string; by: string }

/** The sagas a remote access mint runs on: the coordinator's begin, drive and abort, and the sagas not ended. */
export interface MintSagas {
  begin(kind: string, key: string, data: Record<string, unknown>): Pick<Saga, 'id'>;
  drive(id: string): Promise<Saga | undefined>;
  abort(id: string, reason: string): boolean;
  open(): Saga[];
}

/** What the saga asks of remote access. */
export interface MintHost {
  /** The provider's credential; undefined: none is kept. */
  credential(provider: RemoteAccessProvider): string | undefined;
  /** Keeps the tunnel's token, sealed; throws when it cannot. */
  keepToken(provider: RemoteAccessProvider, token: string, by: string): void;
  /** Every step is done: the tunnel is kept in the settings. Throws when they no longer ask for it. */
  minted(provider: RemoteAccessProvider, provisioned: Provisioned, data: MintData): void;
  /** The compensation: releases what was found, drops the token, and turns remote access off when it still asked for it. */
  unminted(provider: RemoteAccessProvider, found: Provisioned | undefined, reason: string, by: string): Promise<void>;
}

/**
 * Each mint not ended (one a stop left) driven to its end, else aborted and undone, before a change of remote access:
 * whether none is left. One still undoing what it made would remove what a new mint finds by the same name.
 */
export async function settleMints(mints: MintSagas): Promise<boolean> {
  for (const s of mints.open().filter(isMintSaga)) {
    const end = await mints.drive(s.id);
    if (end?.state === 'running' || end?.state === 'compensating') {
      mints.abort(s.id, 'a newer change of remote access');
      await mints.drive(s.id);
    }
  }
  return !mints.open().some(isMintSaga);
}

const MADE = ['host', 'accountId', 'zoneId', 'tunnelId', 'dnsRecordId', 'credentialId', 'reservedDomainId'] as const;
const madeOf = (data: Record<string, unknown>): Made =>
  Object.fromEntries(MADE.filter((k) => typeof data[k] === 'string' && data[k] !== '').map((k) => [k, data[k] as string]));
const dataOf = (c: SagaStepContext): MintData => c.data as unknown as MintData;

export function mintSagas(o: { providers: Record<RemoteAccessProvider, TunnelProvider>; host: MintHost }): SagaDefinition[] {
  return PROVIDERS.map((p) => {
    const provider = o.providers[p];
    const credential = (): string => {
      const key = o.host.credential(p);
      if (key === undefined) throw new Error('no credential is kept for the provider');
      return key;
    };
    const undo = async (c: SagaStepContext): Promise<void> => {
      const d = dataOf(c);
      const found = await provider.find({ credential: o.host.credential(p), name: d.name, made: madeOf(c.data) });
      await o.host.unminted(p, found, c.saga.error ?? 'aborted', d.by);
    };
    const steps: SagaStepDefinition[] = provider.mint.map((step, i) => ({
      name: step.name,
      do: async (c) => {
        const d = dataOf(c);
        return step.do({
          credential: credential(), ...(d.domain ? { domain: d.domain } : {}), port: d.port, name: d.name, made: madeOf(c.data),
          keepToken: (token) => o.host.keepToken(p, token, d.by),
        });
      },
      ...(i === 0 ? { compensate: undo } : {}),
    }));
    // The settings no longer asking for this tunnel will not change by trying again: it is undone at once.
    steps.push({ name: 'record', attempts: 1, do: async (c) => { o.host.minted(p, provider.provisioned(madeOf(c.data)), dataOf(c)); } });
    return { kind: MINT_SAGA[p], steps };
  });
}
