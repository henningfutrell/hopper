// hopper.io's side of the cloud link's registration messages (issue #463 decision 5, issue #465), transport-free: the
// connection (issue #464) is not built. The instance answers `register` with `{ type: 'registration', outcome }`
// (src/http/cloud-link-messages.ts); only `registered` makes a registration of the account whose owner entered the code.
// hopper.io cannot reach an instance, so a deletion or its owner's removal leaves a tombstone (cloud/store.ts), and the instance's next hello is
// answered `unregister`, the one message the instance takes for it. A message from an instance is checked against a
// closed schema and a size cap, as the instance checks hopper.io's (docs/hopper-io-security.md R7). An instance is the
// registration of one account at a time (issue #465 item 3): registered under another, it moves there. Its hello keeps
// its last-seen time, and its unlink notice (src/http/cloud-link-messages.ts `unlinkedMessage`) removes it.
import { z } from 'zod';
import type { CloudStore } from './store.ts';

/** The most bytes one message from an instance may hold, as the instance's own cap. */
export const LINK_MESSAGE_MAX_BYTES = 1024;
/** An instance id: the instance's own, 8 random bytes as hex (src/store/settings.ts). */
export const INSTALL_ID = /^[0-9a-f]{16}$/;

const REGISTRATION = z.strictObject({
  type: z.literal('registration'), outcome: z.enum(['registered', 'not-linked', 'other-account', 'no-code']),
});
const UNLINKED = z.strictObject({ type: z.literal('unlinked'), installId: z.string(), account: z.string() });

/** The message, when it is JSON of at most LINK_MESSAGE_MAX_BYTES. */
function parsed(text: string): unknown {
  if (Buffer.byteLength(text) > LINK_MESSAGE_MAX_BYTES) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}

export interface CloudLinkAnswers {
  /** The instance's answer to the `register` its owner's code went in; true: it is now a registration of the account. */
  registration(o: { githubUserId: string; installId: string; answer: string; now: Date }): Promise<boolean>;
  /** What hopper.io sends back to an instance's hello: `unregister` for the hello's account when a deletion removed
   * its registration; else nothing. */
  hello(o: { installId: string; account: string; now: Date }): Promise<string | undefined>;
  /** The instance's unlink notice, on its own connection (`installId`); true: its registration is removed. */
  unlinked(o: { installId: string; notice: string; now: Date }): Promise<boolean>;
}

export function createCloudLinkAnswers(o: {
  store: Pick<CloudStore, 'register' | 'registrationOf' | 'seen' | 'unlinked' | 'record'>;
}): CloudLinkAnswers {
  return {
    async registration({ githubUserId, installId, answer, now }) {
      if (!INSTALL_ID.test(installId)) return false;
      const m = REGISTRATION.safeParse(parsed(answer));
      if (!m.success || m.data.outcome !== 'registered') return false;
      const before = await o.store.register(githubUserId, installId, now);
      if (before === githubUserId) return true;
      if (before) await o.store.record(before, 'instance_moved', now);
      await o.store.record(githubUserId, 'instance_registered', now);
      return true;
    },
    async hello({ installId, account, now }) {
      if (!INSTALL_ID.test(installId)) return undefined;
      const state = await o.store.registrationOf(installId, now);
      if (state === 'registered') await o.store.seen(installId, now);
      return state === 'removed' ? JSON.stringify({ type: 'unregister', account }) : undefined;
    },
    async unlinked({ installId, notice, now }) {
      const m = UNLINKED.safeParse(parsed(notice));
      if (!m.success || !INSTALL_ID.test(installId) || m.data.installId !== installId) return false;
      const account = await o.store.unlinked(installId, m.data.account.toLowerCase());
      if (account) await o.store.record(account, 'instance_unlinked', now);
      return account !== undefined;
    },
  };
}
