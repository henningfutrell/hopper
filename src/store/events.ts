import type { EventLog } from '../domain/ports.ts';
import { EVENT_SCHEMA_VERSIONS, type DomainEvent, type EventType } from '../domain/types.ts';
import { LEDGER_EVENT_TYPES, type WorkItemLedger } from '../domain/work-items.ts';
import { parse, type StoreContext } from './context.ts';
import type { ReadDb } from './read-pool.ts';

type Listener = (event: DomainEvent) => void;

const toEvent = (r: Record<string, unknown>): DomainEvent => {
  const e: DomainEvent = { schemaVersion: r.schema_version as number, seq: r.seq as number, id: r.id as string, type: r.type as EventType, at: r.at as string, data: parse(r.data) };
  if (r.job_id !== null) e.jobId = r.job_id as string;
  if (r.lane_id !== null) e.laneId = r.lane_id as string;
  if (r.machine_id !== null) e.machineId = r.machine_id as string;
  if (r.decision_id !== null) e.decisionId = r.decision_id as string;
  if (r.question_id !== null) e.questionId = r.question_id as string;
  return e;
};

const BETWEEN = (types: readonly EventType[]): string => `SELECT * FROM events WHERE type IN (${types.map(() => '?').join(',')}) AND at >= ? ORDER BY seq`;

/** EventLog.between read off the event loop (issue #2392). */
export const eventsBetweenRead = (read: ReadDb) => async (types: readonly EventType[], since: string): Promise<DomainEvent[]> =>
  (types.length === 0 ? [] : (await read.all(BETWEEN(types), ...types, since)).map(toEvent));

// The peaks of one repository's jobs, newest first (issue #2622 part 4): a job's repository is in its body, read in any case.
const PEAKS = `SELECT (e.data::jsonb->>'memoryPeakBytes')::float8 AS peak FROM events e JOIN jobs j ON j.id = e.job_id
  WHERE e.type = 'job.resources_used' AND e.at >= ? AND e.data::jsonb->>'memoryPeakBytes' IS NOT NULL
  AND lower(j.body::jsonb->'source'->>'repo') = lower(?) ORDER BY e.seq DESC LIMIT ?`;

/** The memory peaks `job.resources_used` recorded for `repo`'s jobs since `since`, newest first, at most `limit`, off the event loop. */
export const memoryPeaksRead = (read: ReadDb) => async (repo: string, since: string, limit: number): Promise<number[]> =>
  (await read.all(PEAKS, since, repo, limit)).map((r) => Number(r.peak));

/** The log, plus `flush`/`discard` for the transaction wrapper to call at the outermost end. */
export interface EventLogInternals extends EventLog {
  flush(): void;
  discard(): void;
}

/** `ledger`: folds each event into its work item in the append's own transaction (issue #1067). */
export function createEventLog(c: StoreContext, inTx: () => boolean, ledger?: Pick<WorkItemLedger, 'applyEvent'>): EventLogInternals {
  const listeners = new Set<Listener>();
  let pending: DomainEvent[] = [];

  const notify = (events: DomainEvent[]): void => {
    for (const e of events) {
      for (const l of [...listeners]) {
        try { l(e); } catch (err) { console.error('event listener failed', err); }
      }
    }
  };

  const appendOne = (n: Parameters<EventLog['append']>[0]): DomainEvent => {
    const id = c.idGen();
    const at = n.at ?? c.clock.now().toISOString();
    const schemaVersion = EVENT_SCHEMA_VERSIONS[n.type];
    const r = c.db.get(
      'INSERT INTO events (id, type, at, job_id, lane_id, machine_id, decision_id, question_id, data, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq',
    id, n.type, at, n.jobId ?? null, n.laneId ?? null, n.machineId ?? null, n.decisionId ?? null, n.questionId ?? null, JSON.stringify(n.data), schemaVersion);
    const event: DomainEvent = { ...n, schemaVersion, seq: Number(r!.seq), id, at };
    if (inTx()) pending.push(event);
    else notify([event]);
    return event;
  };

  return {
    append(n) {
      if (!ledger || !LEDGER_EVENT_TYPES.has(n.type)) return appendOne(n);
      return c.tx(() => {
        const event = appendOne(n);
        ledger.applyEvent(event);
        return event;
      });
    },
    since(afterSeq, limit) {
      const sql = `SELECT * FROM events WHERE seq > ? ORDER BY seq ${limit !== undefined ? 'LIMIT ?' : ''}`;
      return (limit !== undefined ? c.db.all(sql, afterSeq, limit) : c.db.all(sql, afterSeq)).map(toEvent);
    },
    recent(limit = 100, types, jobId) {
      const where = [...(types?.length ? [`type IN (${types.map(() => '?').join(',')})`] : []), ...(jobId !== undefined ? ['job_id = ?'] : [])];
      const args = [...(types?.length ? types : []), ...(jobId !== undefined ? [jobId] : [])];
      return c.db.all(`SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY seq DESC LIMIT ?`, ...args, limit).map(toEvent);
    },
    between(types, since) {
      return types.length === 0 ? [] : c.db.all(BETWEEN(types), ...types, since).map(toEvent);
    },
    lastOfJobs(jobIds) {
      if (jobIds.length === 0) return [];
      return c.db.all(`SELECT DISTINCT ON (job_id) * FROM events WHERE job_id IN (${jobIds.map(() => '?').join(',')}) ORDER BY job_id, seq DESC`, ...jobIds).map(toEvent);
    },
    subscribe(l) {
      listeners.add(l);
      return () => { listeners.delete(l); };
    },
    flush() {
      const batch = pending;
      pending = [];
      notify(batch);
    },
    discard() {
      pending = [];
    },
  };
}
