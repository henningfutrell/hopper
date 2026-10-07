// In-memory stand-ins for the sync loop's seams: a JobSource whose behaviour a test scripts, and
// a SourceHost over a minimal store (events, jobs, questions). Only what the sync loop reads.

import type {
  Clock, JobSource, SourceHost, SourceItem, SourceReport, SourceSignal, UserStore,
} from '../../src/domain/ports.ts';
import type { DomainEvent, EventType, Job, Question } from '../../src/domain/types.ts';
import { TERMINAL_STATUSES, isRerunnable } from '../../src/domain/types.ts';

export function item(key: string, over: Partial<SourceItem> = {}): SourceItem {
  return {
    key, url: key, title: `title ${key}`, body: 'body', prompt: 'prompt', env: {}, author: 'me',
    priority: 50, priorityReason: 'default', cwd: '/tmp', labels: [], executor: 'test', ...over,
  };
}

export interface World {
  store: UserStore;
  host: SourceHost;
  clock: Clock & { advance(ms: number): void };
  jobs: Map<string, Job>;
  questions: Map<string, Question>;
  calls: { cancel: Array<[string, string]>; reprioritize: Array<[string, number, string]>; ingest: SourceItem[] };
  emit(type: EventType, jobId: string, data?: Record<string, unknown>, questionId?: string): void;
  patchJob(id: string, patch: Partial<Job>): Job;
  addQuestion(jobId: string, over?: Partial<Question>): Question;
}

export function createWorld(): World {
  let now = Date.parse('2026-10-02T10:00:00Z');
  const clock = { now: () => new Date(now), advance: (ms: number) => { now += ms; } };
  const jobs = new Map<string, Job>();
  const questions = new Map<string, Question>();
  const listeners = new Set<(e: DomainEvent) => void>();
  const calls: World['calls'] = { cancel: [], reprioritize: [], ingest: [] };
  let seq = 0;
  const iso = () => clock.now().toISOString();

  function emit(type: EventType, jobId: string, data: Record<string, unknown> = {}, questionId?: string) {
    const e: DomainEvent = { seq: ++seq, schemaVersion: 1, id: `e${seq}`, type, at: iso(), jobId, data, ...(questionId ? { questionId } : {}) };
    for (const l of [...listeners]) l(e);
  }

  const store = {
    events: {
      append: (n: { type: EventType; jobId?: string; questionId?: string; data: Record<string, unknown> }) => {
        emit(n.type, n.jobId ?? '', n.data, n.questionId);
        return {} as DomainEvent;
      },
      subscribe: (l: (e: DomainEvent) => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
    },
    jobs: {
      get: (id: string) => jobs.get(id),
      list: () => [...jobs.values()],
      getBySourceKey: (key: string) => [...jobs.values()].filter((j) => j.source?.key === key).at(-1),
    },
    questions: {
      get: (id: string) => questions.get(id),
      list: (f?: { jobId?: string; status?: string[] }) => [...questions.values()]
        .filter((q) => (!f?.jobId || q.jobId === f.jobId) && (!f?.status || f.status.includes(q.status))),
    },
    tx: <T>(fn: () => T) => fn(),
  } as unknown as UserStore;

  function patchJob(id: string, patch: Partial<Job>): Job {
    const next = { ...jobs.get(id)!, ...patch };
    jobs.set(id, next);
    return next;
  }

  const host: SourceHost = {
    store,
    ingest(it, source) {
      calls.ingest.push(it);
      const known = store.jobs.getBySourceKey(it.key);
      if (known && !isRerunnable(known)) return null;
      const id = `job-${jobs.size + 1}`;
      const job = {
        id, spec: { executor: it.executor, payload: {} }, priority: it.priority, approved: false, attempts: 0,
        status: it.invalid ? 'failed' : 'queued', ...(it.invalid ? { error: it.invalid } : {}),
        createdAt: iso(), updatedAt: iso(),
        source: { source: source.name, kind: source.kind, key: it.key },
      } as Job;
      jobs.set(id, job);
      return job;
    },
    cancel(id, reason) {
      calls.cancel.push([id, reason]);
      patchJob(id, { status: 'cancelled' });
      emit('job.cancelled', id, { reason });
    },
    reprioritize(id, to, reason) { calls.reprioritize.push([id, to, reason]); return true; },
    finishOperatorLed(id) {
      if (jobs.get(id)?.status !== 'operator_led') return false;
      patchJob(id, { status: 'finished' });
      emit('job.finished', id, { result: 'operator-led work complete' });
      return true;
    },
    finishClosedAsComplete(id) {
      if (jobs.get(id)?.status !== 'failed') return false;
      patchJob(id, { status: 'finished', error: undefined });
      emit('job.finished', id, { result: 'issue closed as complete' });
      return true;
    },
    setSourceState(id, state) {
      const cur = jobs.get(id)!.sourceState ?? {};
      patchJob(id, { sourceState: { ...cur, ...state } });
    },
    rerun(id) {
      emit('job.rerun', id, { by: 'user' });
      return jobs.get(id)!;
    },
  };

  function addQuestion(jobId: string, over: Partial<Question> = {}): Question {
    const id = `q${questions.size + 1}`;
    const q: Question = {
      id, jobId, text: 'which?', recentOutput: '', detectedBy: 'marker', status: 'open', tier: 'human', attempts: [],
      notifyCount: 0, createdAt: iso(), updatedAt: iso(), ...over,
    };
    questions.set(id, q);
    return q;
  }

  return { store, host, clock, jobs, questions, calls, emit, patchJob, addQuestion };
}

export interface FakeSource extends JobSource {
  items: SourceItem[];
  signals: SourceSignal[];
  reports: SourceReport[];
  discovers: number;
  discoverError?: Error;
  /** Errors thrown by the next report calls, in order. */
  reportErrors: Error[];
  /** When set, report waits for it before returning. */
  gate?: Promise<void>;
  inFlight: number;
  maxInFlight: number;
}

export function createFakeSource(name = 'fake'): FakeSource {
  const s: FakeSource = {
    name, kind: 'fake', items: [], signals: [], reports: [], discovers: 0, reportErrors: [], inFlight: 0, maxInFlight: 0,
    describe: () => ({ label: 'x' }),
    async discover() {
      s.discovers++;
      if (s.discoverError) throw s.discoverError;
      return [...s.items];
    },
    async check() { const out = s.signals; s.signals = []; return out; },
    async report(r) {
      s.inFlight++;
      s.maxInFlight = Math.max(s.maxInFlight, s.inFlight);
      try {
        if (s.gate) await s.gate;
        const err = s.reportErrors.shift();
        if (err) throw err;
        s.reports.push(r);
        return { [`n${s.reports.length}`]: r.kind };
      } finally { s.inFlight--; }
    },
  };
  return s;
}

export const isTerminal = (j: Job) => TERMINAL_STATUSES.includes(j.status);

/** Let setImmediate-scheduled work and the promise chains it starts run to rest. */
export async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}
