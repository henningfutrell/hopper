// hopper.io's registration requests (issue #465 item 2, docs/design.md "Registration requests at hopper.io"): the code an
// account owner entered at hopper.io for one instance, kept in memory only, never in the store, for REQUEST_MS — the life
// of the code on the instance. hopper.io gives it as `register` (cloud/link.ts `registerMessage`) only to the instance it
// names, while that instance's link names the owner's account (R3), and only the instance's answer to it makes a
// registration. A refusal drops the code and keeps only its outcome, so the owner sees why. A restart loses the open
// requests: the owner enters the code again.

/** How long a registration request waits for its instance: the life of a registration code on the instance. */
export const REQUEST_MS = 10 * 60 * 1000;
/** The most open registration requests of one account (docs/hopper-io-security.md R7). */
export const REQUESTS_PER_ACCOUNT = 10;
/** The most open registration requests of all accounts, so memory stays bounded (R7). */
export const REQUESTS_MAX = 10_000;

/** Why an instance did not take a code: its own answer (src/domain/cloud-link.ts `RegistrationOutcome`). */
export type RequestRefusal = 'not-linked' | 'other-account' | 'no-code';

export interface RegistrationRequest { githubUserId: string; login: string; installId: string; code?: string; expiresAt: Date; refused?: RequestRefusal }
/** A request as its account's owner reads it: never the code. */
export interface RequestView { installId: string; expiresAt: Date; refused?: RequestRefusal }

export interface RegistrationRequests {
  /** Keeps the owner's code for the instance, in place of the account's open request for it. 'full': too many open. */
  enter(o: { githubUserId: string; login: string; installId: string; code: string; now: Date }): 'entered' | 'full';
  /** The account's own requests that have not expired, the oldest first. */
  of(githubUserId: string, now: Date): RequestView[];
  /** The open request for the instance whose account's login is `account`: not expired, not refused. */
  open(installId: string, account: string, now: Date): RegistrationRequest | undefined;
  /** Drops the request: the instance registered. */
  take(r: RegistrationRequest): void;
  /** Drops the request's code and keeps why the instance did not take it, until it expires. */
  refuse(r: RegistrationRequest, why: RequestRefusal): void;
}

export function createRegistrationRequests(): RegistrationRequests {
  const all = new Map<string, RegistrationRequest>();
  const key = (githubUserId: string, installId: string) => `${githubUserId}/${installId}`;
  const sweep = (now: Date) => { for (const [k, r] of all) if (r.expiresAt <= now) all.delete(k); };
  return {
    enter({ githubUserId, login, installId, code, now }) {
      sweep(now);
      const k = key(githubUserId, installId);
      if (!all.has(k) && ([...all.values()].filter((r) => r.githubUserId === githubUserId).length >= REQUESTS_PER_ACCOUNT || all.size >= REQUESTS_MAX)) return 'full';
      all.delete(k);
      all.set(k, { githubUserId, login: login.toLowerCase(), installId, code, expiresAt: new Date(now.getTime() + REQUEST_MS) });
      return 'entered';
    },
    of(githubUserId, now) {
      sweep(now);
      return [...all.values()].filter((r) => r.githubUserId === githubUserId)
        .map((r) => ({ installId: r.installId, expiresAt: r.expiresAt, ...(r.refused ? { refused: r.refused } : {}) }));
    },
    open(installId, account, now) {
      sweep(now);
      return [...all.values()].find((r) => r.installId === installId && r.login === account.toLowerCase() && r.code !== undefined);
    },
    take(r) { all.delete(key(r.githubUserId, r.installId)); },
    refuse(r, why) {
      delete r.code;
      r.refused = why;
    },
  };
}
