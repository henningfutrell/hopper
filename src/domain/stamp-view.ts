// The stamp view (issue #655, part 10; design.md "Trust stamps"): what the API (`GET /api/jobs/:id/stamp`) and the CLI
// (`hopper job stamp <id>`) say of one job's trust stamp. The stamp as kept, never its MAC; whether it verifies; the
// intake strictness on the job and whether the stamp holds its start; whether gate 2 approves its requests with no
// person; whether its proxy token opens the hopper's doors; whether Jev's trust check is due; and the job's origin acts
// (part 14). Read only. Pure: the key is passed in.
import type { OriginActor } from './intake-origin.ts';
import type { Brake } from './intake-strictness.ts';
import {
  autoApprovable, checkDue, opensDoors, stampHold, verifiedLevel, type TrustLevel, type TrustStamp,
} from './trust-stamp.ts';
import type { Job, JobId } from './types.ts';

/**
 * Whether the stamp verifies: `yes`; `no` (the job or its stamp changed outside the hopper); `missing` (no stamp);
 * `unknown` (the hopper has no stamp key, so it holds nothing on a stamp).
 */
export type StampVerifies = 'yes' | 'no' | 'missing' | 'unknown';

export interface StampView {
  jobId: JobId;
  /** The stamp as kept, with no MAC. Null: none. */
  stamp: Omit<TrustStamp, 'v' | 'mac'> | null;
  verifies: StampVerifies;
  /** The level as verified. Null: it does not verify, or the hopper cannot verify. */
  level: TrustLevel | null;
  /** The intake strictness on the job (brake 1): the level it needs to start, and where that was set. */
  brake: { strictness: Brake['strictness']; needs: TrustLevel; at: Brake['at'] };
  /** Why the stamp holds the job's start. Null: the stamp lets it start. */
  startHold: string | null;
  /** Gate 2: `auto`, its requests may be approved with no person; `person`, each waits for a person. */
  gate2: 'auto' | 'person';
  /** Whether its proxy token opens the hopper's doors. */
  doorsOpen: boolean;
  /** Whether Jev's trust check is due for it. */
  checkDue: boolean;
  /** Its origin acts (part 14): who wrote, labelled and assigned its item, as read at intake. Null: none kept. */
  originActs: OriginActor[] | null;
}

/** The stamp's fields a person reads, named one by one so no MAC and no later field leaks. */
const kept = (s: TrustStamp): NonNullable<StampView['stamp']> => ({
  level: s.level, reasons: s.reasons, by: s.by, at: s.at, ...(s.was ? { was: s.was } : {}), ...(s.check ? { check: s.check } : {}),
});

/** The view of `job`'s stamp under `brake`; `key` undefined: the hopper has no stamp key. */
export function stampView(key: Buffer | undefined, job: Pick<Job, 'id' | 'spec' | 'stamp' | 'source'>, brake: Brake): StampView {
  const level = key ? verifiedLevel(key, job) : undefined;
  const verifies: StampVerifies = !job.stamp ? 'missing' : !key ? 'unknown' : level !== undefined ? 'yes' : 'no';
  return {
    jobId: job.id,
    stamp: job.stamp ? kept(job.stamp) : null,
    verifies,
    level: level ?? null,
    brake: { strictness: brake.strictness, needs: brake.min, at: brake.at },
    startHold: (key ? stampHold(key, job, brake) : undefined) ?? null,
    gate2: !key || autoApprovable(key, job, brake) ? 'auto' : 'person',
    doorsOpen: !key || opensDoors(key, job),
    checkDue: key ? checkDue(key, job) : false,
    originActs: job.source?.originActs ?? null,
  };
}
