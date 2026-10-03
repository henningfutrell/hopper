import type { EventLog } from '../domain/ports.ts';
import type { DomainEvent, EventType } from '../domain/types.ts';
import { parse, type StoreContext } from './context.ts';

type Listener = (event: DomainEvent) => void;

const toEvent = (r: Record<string, unknown>): DomainEvent => {
  const e: DomainEvent = { seq: r.seq as number, id: r.id as string, type: r.type as EventType, at: r.at as string, data: parse(r.data) };
  if (r.job_id !== null) e.jobId = r.job_id as string;
  if (r.lane_id !== null) e.laneId = r.lane_id as string;
  if (r.machine_id !== null) e.machineId = r.machine_id as string;
  if (r.decision_id !== null) e.decisionId = r.decision_id as string;
  if (r.question_id !== null) e.questionId = r.question_id as string;
  return e;
};

/** The log, plus `flush`/`discard` for the transaction wrapper to call at the outermost end. */
export interface EventLogInternals extends EventLog {
  flush(): void;
  discard(): void;
}

export function createEventLog(c: StoreContext, inTx: () => boolean): EventLogInternals {
  const listeners = new Set<Listener>();
  let pending: DomainEvent[] = [];

  const notify = (events: DomainEvent[]): void => {
    for (const e of events) {
      for (const l of [...listeners]) {
        try { l(e); } catch (err) { console.error('event listener failed', err); }
      }
    }
  };

  return {
    append(n) {
      const id = c.idGen();
      const at = n.at ?? c.clock.now().toISOString();
      const r = c.db.prepare(
        'INSERT INTO events (id, type, at, job_id, lane_id, machine_id, decision_id, question_id, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(id, n.type, at, n.jobId ?? null, n.laneId ?? null, n.machineId ?? null, n.decisionId ?? null, n.questionId ?? null, JSON.stringify(n.data));
      const event: DomainEvent = { ...n, seq: Number(r.lastInsertRowid), id, at };
      if (inTx()) pending.push(event);
      else notify([event]);
      return event;
    },
    since(afterSeq, limit) {
      const sql = `SELECT * FROM events WHERE seq > ? ORDER BY seq ${limit !== undefined ? 'LIMIT ?' : ''}`;
      return (limit !== undefined ? c.db.prepare(sql).all(afterSeq, limit) : c.db.prepare(sql).all(afterSeq)).map(toEvent);
    },
    recent(limit = 100, types) {
      const where = types?.length ? `WHERE type IN (${types.map(() => '?').join(',')})` : '';
      return c.db.prepare(`SELECT * FROM events ${where} ORDER BY seq DESC LIMIT ?`).all(...(types ?? []), limit).map(toEvent);
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
