// Device grant requests (issue #892, design.md "Grants by device approval"), on the model of the OAuth 2.0 device
// authorization grant (RFC 8628): an agent with no credential asks for a grant and gets a device code, which it keeps,
// and a short user code, which it shows. A person signed in to the UI enters the user code, sees what the agent asks for,
// and approves or denies it; the agent polls with its device code and takes the approval once. The grant is minted then,
// as the person who approved it (./api-tokens.ts). Kept in memory only: a restart drops every request, and the agent asks
// again. Only the device code's SHA-256 is kept.
import { createHash, randomInt } from 'node:crypto';
import type { Clock } from '../../domain/ports.ts';
import { DEVICE_CODE_PREFIX, DEVICE_GRANT, type DeviceGrantAsk, type DeviceGrantStarted, type DeviceGrantView } from '../../domain/types.ts';
import { randomSecret } from './secret.ts';

const MINUTE = 60_000;
/** The letters of a user code: no vowels, so no word is spelled; none that reads as a digit (RFC 8628 §6.1). */
const LETTERS = 'BCDFGHJKLMNPQRSTVWXZ';
const hashOf = (code: string): string => createHash('sha256').update(code, 'utf8').digest('hex');
/** The settings page a person enters the user code on, as a path of the hopper's URL the agent called. */
const VERIFICATION_PATH = '/#users-access/api-tokens';

/** A user code as typed, in its one form (`BCDF-GHJK`): case, spaces and dashes do not count. Undefined: it cannot be one. */
export function userCodeOf(typed: string): string | undefined {
  const letters = typed.toUpperCase().replace(/[\s-]/g, '');
  if (letters.length !== 8 || [...letters].some((c) => !LETTERS.includes(c))) return undefined;
  return `${letters.slice(0, 4)}-${letters.slice(4)}`;
}

/**
 * What the agent's poll finds: still waiting, denied, or approved with what the person approved it with; `wrong-key`: the
 * request is bound to a key (issue #892, "Sender binding") and the poll proves another, or none — the request stands.
 */
export type DevicePoll<A> = { state: 'waiting'; interval: number; expiresAt: string } | { state: 'denied' } | { state: 'approved'; ask: DeviceGrantAsk; approval: A } | { state: 'wrong-key' };

export interface DeviceGrants<A> {
  /** A new request; refused while too many wait. */
  start(ask: DeviceGrantAsk, from: string): { ok: true; value: DeviceGrantStarted } | { ok: false; error: string };
  /** The waiting request with this user code, as typed. */
  find(userCode: string): DeviceGrantView | undefined;
  /** The waiting request approved, with `approval`; false: there is none such. */
  approve(userCode: string, approval: A): boolean;
  /** The waiting request denied; false: there is none such. */
  deny(userCode: string): boolean;
  /**
   * The agent's poll: an approval or a denial is answered once, and the request ends. Undefined: unknown, or it ended.
   * `jkt`: the key of the poll's DPoP proof; a request bound to a key (its ask's `jkt`) answers only a poll that proves it.
   */
  take(deviceCode: string, jkt?: string): DevicePoll<A> | undefined;
}

interface Request<A> { userCode: string; ask: DeviceGrantAsk; from: string; createdAt: number; endsAt: number; answer?: { denied: true } | { approval: A } }

export function createDeviceGrants<A>(o: { clock: Clock }): DeviceGrants<A> {
  const now = (): number => o.clock.now().getTime();
  /** By the device code's hash. */
  const requests = new Map<string, Request<A>>();
  const sweep = (): void => {
    for (const [hash, r] of requests) if (now() >= r.endsAt) requests.delete(hash);
  };
  const waiting = (typed: string): [string, Request<A>] | undefined => {
    sweep();
    const code = userCodeOf(typed);
    if (code === undefined) return undefined;
    for (const entry of requests) if (entry[1].userCode === code && !entry[1].answer) return entry;
    return undefined;
  };
  const freshUserCode = (): string => {
    for (;;) {
      const letters = Array.from({ length: 8 }, () => LETTERS[randomInt(LETTERS.length)]).join('');
      const code = `${letters.slice(0, 4)}-${letters.slice(4)}`;
      if (![...requests.values()].some((r) => r.userCode === code)) return code;
    }
  };

  return {
    start(ask, from) {
      sweep();
      if (requests.size >= DEVICE_GRANT.most) return { ok: false, error: `too many device grant requests wait (${DEVICE_GRANT.most}): try again when one has ended` };
      const deviceCode = `${DEVICE_CODE_PREFIX}${randomSecret()}`;
      const userCode = freshUserCode();
      const createdAt = now();
      const endsAt = createdAt + DEVICE_GRANT.minutes * MINUTE;
      requests.set(hashOf(deviceCode), { userCode, ask, from, createdAt, endsAt });
      return {
        ok: true,
        value: { deviceCode, userCode, verificationPath: VERIFICATION_PATH, verificationPathComplete: `${VERIFICATION_PATH}/${userCode}`, expiresAt: new Date(endsAt).toISOString(), interval: DEVICE_GRANT.intervalS },
      };
    },
    find(typed) {
      const found = waiting(typed);
      if (!found) return undefined;
      const r = found[1];
      return { userCode: r.userCode, ask: r.ask, from: r.from, createdAt: new Date(r.createdAt).toISOString(), expiresAt: new Date(r.endsAt).toISOString() };
    },
    approve(typed, approval) {
      const found = waiting(typed);
      if (!found) return false;
      found[1].answer = { approval };
      return true;
    },
    deny(typed) {
      const found = waiting(typed);
      if (!found) return false;
      found[1].answer = { denied: true };
      return true;
    },
    take(deviceCode, jkt) {
      sweep();
      const hash = hashOf(deviceCode);
      const r = requests.get(hash);
      if (!r) return undefined;
      if (r.ask.jkt !== undefined && r.ask.jkt !== jkt) return { state: 'wrong-key' };
      if (!r.answer) return { state: 'waiting', interval: DEVICE_GRANT.intervalS, expiresAt: new Date(r.endsAt).toISOString() };
      requests.delete(hash);
      return 'denied' in r.answer ? { state: 'denied' } : { state: 'approved', ask: r.ask, approval: r.answer.approval };
    },
  };
}
