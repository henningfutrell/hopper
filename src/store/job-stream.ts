// The job stream's tables (issue #613): each job's stream events, in order, and the watches its requests are waited on
// by. Kept in the user's schema, so a restart loses neither: a job that reconnects with Last-Event-ID gets what it
// missed. Listeners hear an event once its transaction commits, as the event log's do.
import type { JobStreamRepository, StreamEvent, StreamPhase, Watch } from '../domain/job-stream.ts';
import { ENDING_PHASES } from '../domain/job-stream.ts';
import { parse, type StoreContext } from './context.ts';

type Listener = (jobId: string, e: StreamEvent) => void;

const toEvent = (r: Record<string, unknown>): StreamEvent => ({
  seq: Number(r.seq), type: r.type as string, ...(r.request !== null ? { request: r.request as string } : {}),
  phase: r.phase as StreamPhase, at: r.at as string, payload: parse(r.payload),
});

const toWatch = (r: Record<string, unknown>): Watch => ({
  id: r.id as string, jobId: r.job_id as string, deadline: r.deadline as string, openedAt: r.opened_at as string,
  body: parse(r.body), ...(r.ended !== null ? { ended: r.ended as StreamPhase } : {}),
});

export interface JobStreamInternals extends JobStreamRepository {
  flush(): void;
  discard(): void;
}

/** `append` runs in a transaction (its own, or the caller's): the store's commit flushes it to the listeners. */
export function createJobStreamRepository(c: StoreContext): JobStreamInternals {
  const listeners = new Set<Listener>();
  let pending: [string, StreamEvent][] = [];
  const notify = (batch: [string, StreamEvent][]): void => {
    for (const [jobId, e] of batch) {
      for (const l of [...listeners]) {
        try { l(jobId, e); } catch (err) { console.error('job stream listener failed', err); }
      }
    }
  };

  const repo: JobStreamInternals = {
    append(n) {
      return c.tx(() => {
        const at = c.clock.now().toISOString();
        const r = c.db.get('INSERT INTO job_stream (job_id, request, type, phase, at, payload) VALUES (?, ?, ?, ?, ?, ?) RETURNING seq',
          n.jobId, n.request ?? null, n.type, n.phase, at, JSON.stringify(n.payload ?? null));
        if (n.request !== undefined && ENDING_PHASES.includes(n.phase)) repo.end(n.request, n.phase);
        const e: StreamEvent = { seq: Number(r!.seq), type: n.type, ...(n.request !== undefined ? { request: n.request } : {}), phase: n.phase, at, payload: n.payload ?? null };
        pending.push([n.jobId, e]);
        return e;
      });
    },
    since(jobId, afterSeq, limit, request) {
      return (request === undefined
        ? c.db.all('SELECT * FROM job_stream WHERE job_id = ? AND seq > ? ORDER BY seq LIMIT ?', jobId, afterSeq, limit)
        : c.db.all('SELECT * FROM job_stream WHERE job_id = ? AND request = ? AND seq > ? ORDER BY seq LIMIT ?', jobId, request, afterSeq, limit)).map(toEvent);
    },
    get(jobId, seq) {
      const r = c.db.get('SELECT * FROM job_stream WHERE job_id = ? AND seq = ?', jobId, seq);
      return r ? toEvent(r) : undefined;
    },
    open(w) {
      c.db.run('INSERT INTO watches (id, job_id, deadline, opened_at, body) VALUES (?, ?, ?, ?, ?)', w.id, w.jobId, w.deadline, w.openedAt, JSON.stringify(w.body));
    },
    watch(id) {
      const r = c.db.get('SELECT * FROM watches WHERE id = ?', id);
      return r ? toWatch(r) : undefined;
    },
    openWatches(jobId) {
      return (jobId === undefined
        ? c.db.all('SELECT * FROM watches WHERE ended IS NULL ORDER BY deadline')
        : c.db.all('SELECT * FROM watches WHERE ended IS NULL AND job_id = ? ORDER BY deadline', jobId)).map(toWatch);
    },
    end: (id, how) => c.db.run('UPDATE watches SET ended = ? WHERE id = ? AND ended IS NULL', how, id).changes > 0,
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
  return repo;
}
