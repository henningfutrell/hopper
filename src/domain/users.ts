// Users (issue #158, design.md "Users: one hopper, separate users"): one person the hopper works for,
// with everything of theirs kept apart from every other user's.

/** A user, as the instance schema's `users` row holds it. */
export interface User {
  /** `admin`, or a slug of the name: names the user schema, the work dir and the secret prefix. */
  id: string;
  /** Unique among the users. */
  name: string;
  createdAt: string;
  /** The user work dir, relative to HOPPER_WORK_DIR: '' for `admin`, `users/<id>` for a user added later. */
  workDir: string;
  /** What the user's secret names start with: '' for `admin`, `HOPPER_USER_<ID>_` for a user added later. */
  secretPrefix: string;
}

/**
 * The default admin account (issue #220), as Nexus, Argo CD and Grafana have one: the first user of every
 * hopper, who holds the work of an install from before several users and everything the built-in user
 * `owner` held before it (instance migration 21). No sign-in, the login code and the operator CLI without
 * `--user`, and the password fallback's account act for it.
 */
export const ADMIN_ID = 'admin';

/** GET /api/users: who the users are, nothing of their own data. */
export interface UserView {
  id: string;
  name: string;
  createdAt: string;
}

/** POST /ui/api/users `add`: the new user and a one-time login link for it per UI origin (none when local sign-in is off). */
export interface UserAdded {
  user: UserView;
  links: string[];
}

/** The jobs the instance totals count: every one not ended. */
export const IN_FLIGHT_STATUSES = ['queued', 'held', 'claimed', 'running', 'waiting_answer'] as const;

/** How a job ends, as the instance totals count jobs ended in the last day. */
export const ENDED_STATUSES = ['finished', 'failed', 'cancelled', 'rejected'] as const;

/** Usage readings of one unit and usage window, summed over every user's usage sources (issue #241). */
export interface UsageTotal {
  unit: string;
  /** The usage window, as the sources name it; absent: a source's one budget. */
  window?: string;
  used: number;
  limit: number;
  /** How many readings the sums hold. */
  readings: number;
}

/**
 * GET /api/instance (issues #221, #241): what an admin reads of the users' work — totals across every
 * user, never one user's share, never a job, question, lane, account or user named.
 */
export interface InstanceTotals {
  users: number;
  /** Jobs not ended, by status. */
  jobs: Record<(typeof IN_FLIGHT_STATUSES)[number], number>;
  questions: { open: number };
  /** Open lanes, and those holding a job. */
  lanes: { busy: number; total: number };
  /** Jobs that ended in the last 24 hours, by how they ended (issue #241). */
  endedLastDay: Record<(typeof ENDED_STATUSES)[number], number>;
  /** Every user's usage readings summed per unit and usage window: no account, source or machine (issue #241). */
  usage: UsageTotal[];
}
