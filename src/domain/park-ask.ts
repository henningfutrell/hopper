// Who parked a job, and why (issue #2167, design.md "Parked jobs"): the person and the way they acted, and the reason they
// gave, if any. A parked job keeps it in `parked`; a running job's park keeps it in `parkAsk` until its executor stepped
// aside and the park is recorded. A park by the hopper (auto-park, a move) has none: its `why` says so. A running job may
// park or pick up its user's proposal or research report through the `park` skill (`/job/park`): `by` names that job, and
// `via` is `job`.
import { ACTION_VIAS } from './failures.ts';

/** The ways a park or a pick up is asked for: a person's (`ui`, `cli`, `api`), or a running job's (`job`). */
export const PARK_VIAS = [...ACTION_VIAS, 'job'] as const;
export type ParkVia = typeof PARK_VIAS[number];

export interface ParkAsk { by?: string; via?: ParkVia; reason?: string }

/** Who a running job that parks or picks up an item is kept as. */
export const parkingJobName = (jobId: string): string => `job ${jobId}`;

/** The longest reason a person may give. */
export const PARK_REASON_MAX = 500;

/** The ask with only the fields that are set, so a stored row and an event carry no empty field. */
export const parkAskOf = (a: ParkAsk | undefined): ParkAsk =>
  ({ ...(a?.by ? { by: a.by } : {}), ...(a?.via ? { via: a.via } : {}), ...(a?.reason ? { reason: a.reason } : {}) });
