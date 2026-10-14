// Drift in intake (issue #1077, design.md "Component watchers"): items that wait with no action. Intake against the job
// records — every item the last sync took has a job, since a sync makes the job of each item it takes (`ingest`) — and
// each source's sync against its own timer: a next sync that is overdue, or a sync that runs for too long, leaves every
// new item waiting. A sync that ended in the grace is no drift yet. Pure: no I/O, no clock.
import type { Drift, DriftItem } from './drift.ts';
import type { IntakeOutcome } from './intake.ts';
import type { Job, SourceStatus } from './types.ts';

export const INTAKE_JOBS = 'intake-jobs';

/** A sync that runs this long is stuck: no source's sync takes two hours. */
export const SYNC_STUCK_MS = 2 * 3_600_000;

const settled = (at: string | undefined, before: number): boolean => at !== undefined && Date.parse(at) <= before;
const intakeOf = (st: SourceStatus): IntakeOutcome[] => (Array.isArray(st.detail.intake) ? st.detail.intake as IntakeOutcome[] : []);

/**
 * The drift between the sources' last intake and `jobs` (each item taken, by its key, with its job; absent: none), one per
 * kind: `taken_no_job` (the last sync took the item, and it has no job), `sync_overdue` (a source's next sync is more than
 * `graceMs` late, and none runs), `sync_stuck` (a source's sync runs, and none ended in `SYNC_STUCK_MS`).
 */
export function intakeJobsDrift(sources: readonly SourceStatus[], jobs: ReadonlyMap<string, Job>, now: string, graceMs: number): Drift[] {
  const before = Date.parse(now) - graceMs;
  const byKind = new Map<string, DriftItem[]>();
  const add = (kind: string, item: DriftItem) => byKind.set(kind, [...byKind.get(kind) ?? [], item]);
  for (const st of sources) {
    if (settled(st.lastSyncAt, before)) {
      for (const x of intakeOf(st)) if (x.reason === undefined && !jobs.has(x.key)) add('taken_no_job', { key: x.key, says: 'taken', truth: 'no job', since: st.lastSyncAt! });
    }
    if (!st.syncing && settled(st.nextSyncAt, before)) add('sync_overdue', { key: st.name, says: `next sync at ${st.nextSyncAt!}`, truth: 'no sync ran', since: st.nextSyncAt! });
    if (st.syncing && settled(st.lastSyncAt, Date.parse(now) - SYNC_STUCK_MS)) add('sync_stuck', { key: st.name, says: 'a sync runs', truth: `no sync ended since ${st.lastSyncAt!}`, since: st.lastSyncAt! });
  }
  return [...byKind].map(([kind, items]) => ({ watcher: INTAKE_JOBS, kind, items }));
}
