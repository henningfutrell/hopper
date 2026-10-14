// Logins (issue #476, design.md "Logins"): a sign-in a machine or agent waits on — a CLI showing a device
// code to enter at a URL — handled by its login kind, never as a question. Re-exported from types.ts.
import type { JobId, LaneId, MachineId } from './types.ts';

/**
 * How the user completes a login. `device_code`: open the URL, enter the code. `paste_code` (issue #1128, a tool sign-in): open the
 * URL, sign in, and paste the code the page then shows back to the hopper. The registry (src/logins/kinds.ts) takes the next ones.
 */
export const LOGIN_KINDS = ['device_code', 'paste_code'] as const;
export type LoginKind = typeof LOGIN_KINDS[number];

/**
 * `pending`: waiting for the user (again, with `reason`, once its requester said a completed login does not work, issue
 * #1110). `completed`: the machine went on (the tool proceeded, or ended), or its requester said it went through.
 * `expired`: its code ran out first. `cancelled`: the user cancelled it. `failed`: what waited on it ended first, could
 * not take it, or its requester said it did not go through. `dismissed`: a person put it away (issue #1110).
 */
export const LOGIN_STATUSES = ['pending', 'completed', 'expired', 'cancelled', 'failed', 'dismissed'] as const;
export type LoginStatus = typeof LOGIN_STATUSES[number];

/**
 * What a job does when its login expires (issue #476): renew — ask the job for a new code by itself, at each expiry,
 * until the login is completed or cancelled (the default since issue #1016: a code that expired unseen stalled the
 * job) —; hold for a new code the user asks for (the default from issue #698 to #1016); or fail with the reason. A
 * run that cannot ask its tool again (a print-mode run) holds under renew.
 */
export const LOGIN_EXPIRY_ACTIONS = ['fail', 'hold', 'renew'] as const;
export type LoginExpiryAction = typeof LOGIN_EXPIRY_ACTIONS[number];

/** The bounds of `warnSec`, in seconds. */
export const LOGIN_WARN_SEC = { min: 10, max: 3600 } as const;

/**
 * The logins' settings: the user's, read at each use, so a change applies without a restart (issue #356).
 * `warnSec`: how long before a code runs out the Logins view warns (issue #477): at least this, or a fifth of
 * the code's life when that is longer.
 */
export interface LoginSettings { onExpiry: LoginExpiryAction; warnSec: number }
export const DEFAULT_LOGIN_SETTINGS: LoginSettings = { onExpiry: 'renew', warnSec: 60 };

/** A login as its run reports it. The URL and the code are credentials in flight: the hopper keeps them in memory only. */
export interface LoginReport {
  kind: LoginKind;
  /** The CLI or provider that waits: `gh`, `codex`, `claude`. */
  tool: string;
  verificationUrl: string;
  /** The code to enter, where the kind has one. */
  userCode?: string;
  expiresAt: string;
  /** How often the tool polls, when it says. */
  intervalSec?: number;
  /** The account or host the tool signs in to, when it shows one (issue #698): may name a person, so kept as the code is. */
  account?: string;
  /** The scopes the tool asks for, when it shows them (issue #698). */
  scopes?: string[];
}

/** What waits on a login: a job (on a lane, on a machine), or a question's escalation run. */
export interface LoginBlocks {
  jobId?: JobId;
  laneId?: LaneId;
  machineId?: MachineId;
  /** An escalation level's run for this question. */
  questionId?: string;
  /** What runs: the executor or the escalation level, for the user to know which. */
  run: string;
  /** Whether that run can ask its tool for a new code: a herdr job can, a print-mode run cannot. */
  renewable: boolean;
}

/** A login as the hopper keeps it: never its URL or code. */
export interface Login extends LoginBlocks {
  id: string;
  kind: LoginKind;
  tool: string;
  status: LoginStatus;
  expiresAt: string;
  intervalSec?: number;
  /** Why it failed, or, on a pending login, why its requester reopened it (issue #1110). */
  reason?: string;
  /** When the user last asked for a new code, while it is answered. */
  newCodeAskedAt?: string;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
}

/**
 * A login as a route answers it. `verificationUrl` and `userCode` only to a UI session of the user, while it is
 * pending or expired, and while this process holds them: `codeKept: false` when it does not (a restart drops them).
 */
export interface LoginView extends Login {
  /** The live priority of the job that waits on it, and whether it is high priority (issue #535); absent with no job. */
  priority?: number;
  high?: boolean;
  codeKept: boolean;
  /** The host of the URL to open (issue #698): what asks, to anyone who reads the login, while this process holds it. */
  host?: string;
  verificationUrl?: string;
  userCode?: string;
  /** The account and the scopes the tool showed (issue #698): with the URL and code only. */
  account?: string;
  scopes?: string[];
}

/**
 * What the requester of a login says of it (issue #1110): only it knows whether the login worked. `completed` ends the
 * login, or completes one that failed; `failed` fails an open login, or reopens a completed or dismissed one, with
 * `reason`.
 */
export const LOGIN_OUTCOMES = ['completed', 'failed'] as const;
export type LoginOutcome = { outcome: 'completed' } | { outcome: 'failed'; reason: string };

/**
 * What a run waiting on a login does next: wait, ask its tool for a new code, stop waiting (cancelled), or fail.
 * `ended`: the login ended with nothing to tell the run (a login signal, the sweep): it waits on it no more.
 * `new-code` with `expired`: the hopper asks, as its code expired (`onExpiry: renew`, issue #1016), not the user.
 */
export type LoginCheck = { act: 'wait' } | { act: 'new-code'; expired?: true } | { act: 'cancelled' } | { act: 'fail'; reason: string } | { act: 'ended' };

/**
 * Where a run reports a login it waits on (issue #476, design.md "Logins"), and reads what the user did with
 * it. The run waits as its tool does, and says when the tool went on, or when the run ended first.
 */
export interface RunLogins {
  /**
   * The login's id; one open login per run and prompt — the same tool, code or URL (issue #567) —, so the same code
   * reported again is the same login and a new code updates it. `renewable`: the run can ask its tool for a new
   * code. `restore`: the same login read again after a restart: only its URL and code are taken back. Throws on a
   * report its kind refuses.
   */
  report(report: LoginReport, o: { renewable: boolean; restore?: boolean }): string;
  /** What to do next: wait, ask the tool for a new code, stop waiting (cancelled), or fail. */
  check(id: string): LoginCheck;
  /** The login went through: a login signal (a token obtained, the CLI logged in), or a print-mode run that succeeded. */
  completed(id: string): void;
  /** The run said its code expired before it was completed (issue #567): expired now, as at `expiresAt`. */
  expired(id: string): void;
  /** The run ended first, or could not take the login. */
  failed(id: string, reason: string): void;
}
