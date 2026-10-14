// Held grants (issue #647, design.md "Keeping the connection"): a GitHub sign-in made while the user's connection is
// healthy never replaces it quietly. Its grant — checked at GitHub first — is held in memory, one per provider, until
// the person takes it (it replaces the connection) or drops it; nobody acting within HELD_MS drops it. A grant dropped
// is deleted at GitHub (best effort), so it does not count toward GitHub's ten per user and app. Held only in this
// process: a restart drops it without deleting it, and it expires at GitHub on its own.
import type { ConnectedAccountProvider } from '../domain/types.ts';
import { PROVIDER_NAME } from './at-rest.ts';
import type { Grant } from './device-flow.ts';
import type { AccountIdentity } from './identity.ts';

/** How long a held grant waits for the person before it is dropped. */
export const HELD_MS = 15 * 60_000;

type Who = Pick<AccountIdentity, 'subject' | 'account'>;

/** A sign-in's grant, held while the connection is healthy. */
export interface Held { who: Who; grant: Grant; at: string }

export interface HeldGrants {
  get(provider: ConnectedAccountProvider): Held | undefined;
  /** Hold the grant, replacing one held before (dropped); false when GitHub refuses its token: nothing is held. */
  hold(provider: ConnectedAccountProvider, who: Who, grant: Grant): Promise<boolean>;
  /** Forget the held grant: `taken` keeps its token alive (it became the connection), else it is deleted at GitHub. */
  release(provider: ConnectedAccountProvider, taken: boolean): Promise<Held | undefined>;
  stop(): void;
}

export function createHeldGrants(o: {
  whoIs(provider: ConnectedAccountProvider, token: string): Promise<unknown>;
  deleteToken?(provider: ConnectedAccountProvider, accessToken: string): Promise<void>;
  clock: { now(): Date };
  logger: { info(line: string): void; warn(line: string): void };
}): HeldGrants {
  const held = new Map<ConnectedAccountProvider, Held & { timer: ReturnType<typeof setTimeout> }>();

  async function release(provider: ConnectedAccountProvider, taken: boolean): Promise<Held | undefined> {
    const h = held.get(provider);
    if (!h) return undefined;
    held.delete(provider);
    clearTimeout(h.timer);
    if (!taken && o.deleteToken) {
      try {
        await o.deleteToken(provider, h.grant.accessToken);
      } catch (err) {
        o.logger.warn(`hopper: could not delete the held ${PROVIDER_NAME[provider]} token of ${h.who.account}: ${(err as Error).message}; it counts toward GitHub's ten per user and app until it expires`);
      }
    }
    return h;
  }

  return {
    get: (provider) => held.get(provider),
    release,
    async hold(provider, who, grant) {
      try {
        await o.whoIs(provider, grant.accessToken);
      } catch (err) {
        o.logger.warn(`hopper: ${PROVIDER_NAME[provider]} refused the token of a sign-in as ${who.account}: ${(err as Error).message}; the connection stays as it was`);
        return false;
      }
      await release(provider, false);
      const timer = setTimeout(() => {
        o.logger.info(`hopper: the held ${PROVIDER_NAME[provider]} sign-in of ${who.account} was dropped: nobody took it in ${HELD_MS / 60_000} min`);
        void release(provider, false);
      }, HELD_MS);
      timer.unref?.();
      held.set(provider, { who, grant, at: o.clock.now().toISOString(), timer });
      o.logger.warn(`hopper: a ${PROVIDER_NAME[provider]} sign-in as ${who.account} is held: the connection works, so it is not replaced; Sources → Use this sign-in replaces it`);
      return true;
    },
    stop() {
      for (const h of held.values()) clearTimeout(h.timer);
    },
  };
}
