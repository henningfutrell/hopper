// The cloud link's messages (issue #465, design.md "The cloud link's messages"): what hopper.io may send this instance
// about its registration, and what the instance answers. Two closed message types come in — `register`, the code its
// account owner entered, and `unregister`, the owner removed the instance — and each goes to the cloud link as a fact
// about the registration only. Anything else is refused, recorded as `cloud_link.message_refused`, and changes nothing
// (docs/hopper-io-security.md R1, R6, R7). Transport-free: the cloud link's agent (issue #464) hands each message to
// `receive` and sends the answer back, and sends `unlinkedMessage` before an unlink closes the connection.
import { z } from 'zod';
import type { CloudLinkSettings } from '../domain/cloud-link.ts';
import type { InstanceEvents } from '../domain/ports.ts';
import type { CloudLink } from './cloud-link.ts';

/** The most bytes one message from hopper.io may hold; a larger one is refused, never cut (R7). */
export const CLOUD_MESSAGE_MAX_BYTES = 1024;

const INCOMING = {
  register: z.strictObject({ type: z.literal('register'), code: z.string(), account: z.string() }),
  unregister: z.strictObject({ type: z.literal('unregister'), account: z.string() }),
};

/** Why a message from hopper.io was refused. */
export type CloudMessageRefusal = 'too-large' | 'not-json' | 'unknown-type' | 'bad-shape';

export interface CloudLinkMessages {
  /** Takes one message from hopper.io and answers the message to send back. */
  receive(text: string): string;
}

export function createCloudLinkMessages(o: { cloudLink: CloudLink; events: Pick<InstanceEvents, 'append'> }): CloudLinkMessages {
  const refuse = (reason: CloudMessageRefusal): string => {
    o.events.append({ type: 'cloud_link.message_refused', data: { reason } });
    return JSON.stringify({ type: 'refused', reason });
  };
  return {
    receive(text) {
      if (Buffer.byteLength(text) > CLOUD_MESSAGE_MAX_BYTES) return refuse('too-large');
      let message: unknown;
      try { message = JSON.parse(text); } catch { return refuse('not-json'); }
      const type = typeof message === 'object' && message !== null && !Array.isArray(message) ? (message as { type?: unknown }).type : undefined;
      if (type === 'register') {
        const m = INCOMING.register.safeParse(message);
        return m.success ? JSON.stringify({ type: 'registration', outcome: o.cloudLink.register(m.data.code, m.data.account) }) : refuse('bad-shape');
      }
      if (type === 'unregister') {
        const m = INCOMING.unregister.safeParse(message);
        return m.success ? JSON.stringify({ type: 'unregistration', outcome: o.cloudLink.unregister(m.data.account) }) : refuse('bad-shape');
      }
      return refuse('unknown-type');
    },
  };
}

/** What the instance tells hopper.io before an unlink closes the connection: the link that ended. */
export const unlinkedMessage = (link: Pick<CloudLinkSettings, 'installId' | 'account'>): string =>
  JSON.stringify({ type: 'unlinked', installId: link.installId, account: link.account });
