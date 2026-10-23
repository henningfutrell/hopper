// Reads off the event loop (issue #2392, design.md "Database": "Reads off the loop"): the reads of a user's store that
// the HTTP read routes make through the read pool, not the store's own connection, so a read that waits on the database
// holds no timer and no other request. Each answers what its synchronous twin on the store answers; a read sees every
// write that returned before it started.
import type { InfraPlan, KeptPlanView } from './infra-plans.ts';
import type { JobFilter } from './store.ts';
import type { DomainEvent, EventType, Job } from './types.ts';

export interface InfraPlanReads {
  /** As `infraPlans.list`. */
  infraPlans(limit: number): Promise<KeptPlanView[]>;
  /** One plan with its text, its approval and its rejection, in one read. */
  infraPlan(id: string): Promise<(KeptPlanView & Pick<InfraPlan, 'text'>) | undefined>;
}

export interface UserReads extends InfraPlanReads {
  /** As `jobs.list`, with the same jobs kept by row version. */
  jobs(filter?: JobFilter): Promise<Job[]>;
  /** As `events.between`. */
  eventsBetween(types: readonly EventType[], since: string): Promise<DomainEvent[]>;
  /** The memory peaks `job.resources_used` recorded for the jobs of `repo` (`owner/name`, any case) since `since`, newest first, at most `limit` (issue #2622 part 4). */
  memoryPeaks(repo: string, since: string, limit: number): Promise<number[]>;
}
