// Who parked a job, and why (issue #2167, design.md "Parked jobs"): the person and the way they acted, and the reason they
// gave, if any. A parked job keeps it in `parked`; a running job's park keeps it in `parkAsk` until its executor stepped
// aside and the park is recorded. A park by the hopper (auto-park, a move) has none: its `why` says so.
import type { ActionVia } from './failures.ts';

export interface ParkAsk { by?: string; via?: ActionVia; reason?: string }

/** The longest reason a person may give. */
export const PARK_REASON_MAX = 500;

/** The ask with only the fields that are set, so a stored row and an event carry no empty field. */
export const parkAskOf = (a: ParkAsk | undefined): ParkAsk =>
  ({ ...(a?.by ? { by: a.by } : {}), ...(a?.via ? { via: a.via } : {}), ...(a?.reason ? { reason: a.reason } : {}) });
