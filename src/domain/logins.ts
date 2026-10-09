// Logins (issue #476, design.md "Logins"): a sign-in a machine or agent waits on — a CLI showing a device
// code to enter at a URL — handled by its login kind, never as a question. Re-exported from types.ts.
import type { JobId, LaneId, MachineId } from './types.ts';

/** How the user completes a login. `device_code` first; the registry (src/logins/kinds.ts) takes the next ones. */
export const LOGIN_KINDS = ['device_code'] as const;
export type LoginKind = typeof LOGIN_KINDS[number];

/**
 * `pending`: waiting for the user. `completed`: the machine went on (the tool proceeded, or ended). `expired`: its
 * code ran out first. `cancelled`: the user cancelled it. `failed`: what waited on it ended first, or could not take it.
 */
export const LOGIN_STATUSES = ['pending', 'completed', 'expired', 'cancelled', 'failed'] as const;
export type LoginStatus = typeof LOGIN_STATUSES[number];

/** What a job does when its login expires (issue #476): fail with the reason (the default), or hold for a new code. */
export const LOGIN_EXPIRY_ACTIONS = ['fail', 'hold'] as const;
export type LoginExpiryAction = typeof LOGIN_EXPIRY_ACTIONS[number];

/** The bounds of `warnSec`, in seconds. */
export const LOGIN_WARN_SEC = { min: 10, max: 3600 } as const;

/**
 * The logins' settings: the user's, read at each use, so a change applies without a restart (issue #356).
 * `warnSec`: how long before a code runs out the Logins view warns (issue #477): at least this, or a fifth of
 * the code's life when that is longer.
 */
export interface LoginSettings { onExpiry: LoginExpiryAction; warnSec: number }
export const DEFAULT_LOGIN_SETTINGS: LoginSettings = { onExpiry: 'fail', warnSec: 60 };

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
  /** Why it failed. */
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
  verificationUrl?: string;
  userCode?: string;
}

/**
 * What a run waiting on a login does next: wait, ask its tool for a new code, stop waiting (cancelled), or fail.
 * `ended`: the login ended with nothing to tell the run (a login signal, the sweep): it waits on it no more.
 */
export type LoginCheck = { act: 'wait' } | { act: 'new-code' } | { act: 'cancelled' } | { act: 'fail'; reason: string } | { act: 'ended' };
