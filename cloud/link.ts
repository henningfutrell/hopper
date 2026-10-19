// hopper.io's side of the cloud link's registration messages (issue #463 decision 5, issue #465), transport-free: the
// connection (cloud/connections.ts, issue #2039) hands each message here. The code an account owner entered at hopper.io is a registration request
// (cloud/requests.ts); `registerMessage` gives it as `register` to the instance it names, while the instance's link names
// that owner's account, and the instance answers `{ type: 'registration', outcome }` (src/http/cloud-link-messages.ts):
// only `registered`, to an open request, makes a registration of the account whose owner entered the code (R3).
// hopper.io cannot reach an instance, so a deletion or its owner's removal leaves a tombstone (cloud/store.ts), and the instance's next hello is
// answered `unregister`, the one message the instance takes for it. A message from an instance is checked against a
// closed schema and a size cap, as the instance checks hopper.io's (docs/hopper-io-security.md R7). An instance is the
// registration of one account at a time (issue #465 item 3): registered under another, it moves there. Its hello keeps
// its last-seen time, and its unlink notice (src/http/cloud-link-messages.ts `unlinkedMessage`) removes it. Its state
// snapshot (src/domain/hopper-io-state.ts) is kept in memory as its last state (cloud/states.ts), under the account it
// is registered to, while its link names that account; a move or an unlink drops it. The cloud link key (R4): the key the
// instance proved in its hello is bound to its registration when it registers; a registered instance connects only with
// that key, or with a new one its hello proves by that key too (a rotation). A removal revokes the key: it connects no more.
import { z } from 'zod';
import type { RegistrationRequests } from './requests.ts';
import { instanceState, type InstanceStates } from './states.ts';
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
  /** The `register` message to send the instance, whose link names `account`, while a code its owner entered waits for it. */
  registerMessage(o: { installId: string; account: string; now: Date }): string | undefined;
  /** The instance's answer to `register`, on its connection, whose link names `account` and whose hello proved
   * `publicKey`; true: it is now a registration of the account whose owner entered the code, with that key. With no open
   * request, nothing. */
  registration(o: { installId: string; account: string; publicKey: string; answer: string; now: Date }): Promise<boolean>;
  /** The instance's proved hello: whether it connects, the message to send it first, and the account it is registered to. */
  hello(o: { installId: string; account: string; publicKey: string; previousKey?: string; now: Date }): Promise<HelloOutcome>;
  /** The instance's unlink notice, on its own connection (`installId`); true: its registration is removed. */
  unlinked(o: { installId: string; notice: string; now: Date }): Promise<boolean>;
  /** The instance's state snapshot, on its connection, whose link names `account`; true: kept as its last state. Only a
   * registration of that account keeps it. */
  snapshot(o: { installId: string; account: string; text: string; now: Date }): Promise<boolean>;
}

/**
 * What a hello comes to. `connects`: the connection goes on; else `refused`: `revoked`, its key was revoked at a removal,
 * or `unknown-key`, the instance is registered with another key and the hello does not prove it. `answer`: `unregister` for
 * the hello's account when a removal or a deletion took its registration. `registrant`: the account it is registered to.
 */
export type HelloOutcome = { answer?: string; registrant?: string } & ({ connects: true; rotated?: boolean } | { connects: false; refused: 'revoked' | 'unknown-key' });

export function createCloudLinkAnswers(o: {
  store: Pick<CloudStore, 'register' | 'linkOf' | 'rekey' | 'registrant' | 'seen' | 'unlinked' | 'record'>;
  requests: RegistrationRequests; states: InstanceStates;
}): CloudLinkAnswers {
  return {
    registerMessage({ installId, account, now }) {
      const r = INSTALL_ID.test(installId) ? o.requests.open(installId, account, now) : undefined;
      return r ? JSON.stringify({ type: 'register', code: r.code, account: r.login }) : undefined;
    },
    async registration({ installId, account, publicKey, answer, now }) {
      const request = INSTALL_ID.test(installId) ? o.requests.open(installId, account, now) : undefined;
      const m = REGISTRATION.safeParse(parsed(answer));
      if (!request || !m.success) return false;
      if (m.data.outcome !== 'registered') { o.requests.refuse(request, m.data.outcome); return false; }
      o.requests.take(request);
      const githubUserId = request.githubUserId;
      const before = await o.store.register(githubUserId, installId, now, publicKey);
      if (before === githubUserId) return true;
      o.states.drop(installId);
      if (before) await o.store.record(before, 'instance_moved', now);
      await o.store.record(githubUserId, 'instance_registered', now);
      return true;
    },
    async hello({ installId, account, publicKey, previousKey, now }) {
      if (!INSTALL_ID.test(installId)) return { connects: false, refused: 'unknown-key' };
      const l = await o.store.linkOf(installId, now);
      if (l.removed) {
        const answer = JSON.stringify({ type: 'unregister', account });
        return l.removed.revoked === publicKey ? { connects: false, refused: 'revoked', answer } : { connects: true, answer };
      }
      if (!l.githubUserId) return { connects: true };
      const registrant = l.githubUserId;
      let rotated = false;
      if (l.publicKey !== publicKey) {
        // A registration from before the connection has no key: the first proved one binds. Else the hello proves the
        // bound key as the one before a rotation, or it is refused.
        const from = l.publicKey ?? null;
        if (from !== null && previousKey !== from) {
          await o.store.record(registrant, 'connection_refused', now);
          return { connects: false, refused: 'unknown-key', registrant };
        }
        if (!await o.store.rekey(installId, from, publicKey)) return { connects: false, refused: 'unknown-key', registrant };
        rotated = from !== null;
        if (rotated) await o.store.record(registrant, 'key_rotated', now);
      }
      await o.store.seen(installId, now);
      return { connects: true, registrant, ...(rotated ? { rotated } : {}) };
    },
    async unlinked({ installId, notice, now }) {
      const m = UNLINKED.safeParse(parsed(notice));
      if (!m.success || !INSTALL_ID.test(installId) || m.data.installId !== installId) return false;
      const account = await o.store.unlinked(installId, m.data.account.toLowerCase());
      if (!account) return false;
      o.states.drop(installId);
      await o.store.record(account, 'instance_unlinked', now);
      return true;
    },
    async snapshot({ installId, account, text, now }) {
      const state = INSTALL_ID.test(installId) ? instanceState(text) : undefined;
      if (!state) return false;
      const githubUserId = await o.store.registrant(installId, account);
      return githubUserId !== undefined && o.states.keep({ githubUserId, installId, state, now }) === 'kept';
    },
  };
}
