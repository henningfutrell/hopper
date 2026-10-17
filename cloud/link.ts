// hopper.io's side of the cloud link's registration messages (issue #463 decision 5, issue #465), transport-free: the
// connection (issue #464) is not built. The instance answers `register` with `{ type: 'registration', outcome }`
// (src/http/cloud-link-messages.ts); only `registered` makes a registration of the account whose owner entered the code.
// hopper.io cannot reach an instance, so a deletion leaves a tombstone (cloud/store.ts), and the instance's next hello is
// answered `unregister`, the one message the instance takes for it. A message from an instance is checked against a
// closed schema and a size cap, as the instance checks hopper.io's (docs/hopper-io-security.md R7).
import { z } from 'zod';
import type { CloudStore } from './store.ts';

/** The most bytes one message from an instance may hold, as the instance's own cap. */
export const LINK_MESSAGE_MAX_BYTES = 1024;
/** An instance id: the instance's own, 8 random bytes as hex (src/store/settings.ts). */
const INSTALL_ID = /^[0-9a-f]{16}$/;

const REGISTRATION = z.strictObject({
  type: z.literal('registration'), outcome: z.enum(['registered', 'not-linked', 'other-account', 'no-code']),
});

export interface CloudLinkAnswers {
  /** The instance's answer to the `register` its owner's code went in; true: it is now a registration of the account. */
  registration(o: { githubUserId: string; installId: string; answer: string; now: Date }): Promise<boolean>;
  /** What hopper.io sends back to an instance's hello: `unregister` for the hello's account when a deletion removed
   * its registration; else nothing. */
  hello(o: { installId: string; account: string; now: Date }): Promise<string | undefined>;
}

export function createCloudLinkAnswers(o: { store: Pick<CloudStore, 'register' | 'registrationOf'> }): CloudLinkAnswers {
  return {
    async registration({ githubUserId, installId, answer, now }) {
      if (!INSTALL_ID.test(installId) || Buffer.byteLength(answer) > LINK_MESSAGE_MAX_BYTES) return false;
      let message: unknown;
      try { message = JSON.parse(answer); } catch { return false; }
      const m = REGISTRATION.safeParse(message);
      if (!m.success || m.data.outcome !== 'registered') return false;
      await o.store.register(githubUserId, installId, now);
      return true;
    },
    async hello({ installId, account, now }) {
      if (!INSTALL_ID.test(installId)) return undefined;
      return await o.store.registrationOf(installId, now) === 'removed' ? JSON.stringify({ type: 'unregister', account }) : undefined;
    },
  };
}
