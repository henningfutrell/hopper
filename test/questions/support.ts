// In-memory UserStore stand-in: only what the question service touches (questions, jobs.get,
// events.append, tx). Records the tx depth at every event so tests can assert that
// onAnswered/onExpired run inside the transaction. tx rolls back on throw.
import { vi } from 'vitest';
import type { AnswerRequest, ConfigRecords, EscalationLevel, LevelReply, QuestionService, UserStore } from '../../src/domain/ports.ts';
import { EVENT_SCHEMA_VERSIONS, type AutoAnswerSettings, type DomainEvent, type JevFirst, type Job, type NewEvent, type Question, type QuestionAttempt, type RaisedBy } from '../../src/domain/types.ts';
import { createQuestionService } from '../../src/questions/index.ts';

export interface MemoryStore {
  store: UserStore;
  events: Array<DomainEvent & { txDepth: number }>;
  depth(): number;
  addJob(prompt: string, goal?: string): Job;
  /** Change a job as the engine would (its status, priority, a correction it holds). */
  setJob(id: string, patch: Partial<Job>): void;
}

export function createMemoryStore(): MemoryStore {
  let questions = new Map<string, Question>();
  const jobs = new Map<string, Job>();
  let events: Array<DomainEvent & { txDepth: number }> = [];
  let depth = 0;
  let autoAnswer: AutoAnswerSettings | undefined;
  let qn = 0;
  const now = () => new Date().toISOString();
  const store = {
    jobs: { get: (id: string) => jobs.get(id) },
    events: {
      append(e: NewEvent) {
        const ev = { ...e, schemaVersion: EVENT_SCHEMA_VERSIONS[e.type], seq: events.length + 1, id: `e${events.length + 1}`, at: e.at ?? now(), txDepth: depth };
        events.push(structuredClone(ev));
        return ev;
      },
    },
    questions: {
      create(input: { jobId: string; text: string; recentOutput: string; detectedBy: string; tier: string; raisedBy?: RaisedBy }): Question {
        const q: Question = {
          id: `q${++qn}`, ...input, status: 'open', attempts: [], notifyCount: 0,
          createdAt: now(), updatedAt: now(),
        };
        questions.set(q.id, q);
        return structuredClone(q);
      },
      get: (id: string) => (questions.has(id) ? structuredClone(questions.get(id)) : undefined),
      list: (f?: { status?: string[]; jobId?: string }) =>
        [...questions.values()].filter((q) => (!f?.status || f.status.includes(q.status)) && (!f?.jobId || q.jobId === f.jobId)).map((q) => structuredClone(q)),
      update(id: string, patch: Partial<Question>) {
        const q = { ...questions.get(id)!, ...patch, updatedAt: now() };
        questions.set(id, q);
        return structuredClone(q);
      },
      addAttempt(id: string, a: QuestionAttempt) {
        const q = questions.get(id)!;
        q.attempts.push(structuredClone(a));
        return structuredClone(q);
      },
    },
    // The priority lane settings never saved: the default high-priority threshold (issue #535). Auto-answer (issue #632):
    // as a test sets it, never saved by default.
    settings: { getPriorityLanes: () => undefined, getTldr: () => undefined, getAutoAnswer: () => autoAnswer, setAutoAnswer: (s: AutoAnswerSettings) => { autoAnswer = s; } },
    tx<T>(fn: () => T): T {
      if (depth > 0) return fn();
      const snap = { q: structuredClone(questions), e: structuredClone(events) };
      depth++;
      try {
        return fn();
      } catch (err) {
        questions = snap.q;
        events = snap.e;
        throw err;
      } finally {
        depth--;
      }
    },
  } as unknown as UserStore;
  return {
    store,
    get events() { return events; },
    depth: () => depth,
    addJob(prompt, goal) {
      const id = `job${jobs.size + 1}`;
      const job = { id, spec: { executor: 'herdr-claude', payload: { prompt }, goal }, status: 'waiting_answer' } as unknown as Job;
      jobs.set(id, job);
      return job;
    },
    setJob(id, patch) { jobs.set(id, { ...jobs.get(id)!, ...patch }); },
  } as MemoryStore;
}

/** A level that answers: what is typed into the job when no risk rule matches. */
export const ANSWERED: LevelReply = { answer: 'use postgres', escalate: false, reason: 'rules say so', confidence: 'high' };
/** A level that escalates, with its recommendation for the next level up. */
export const UP: LevelReply = { answer: 'maybe postgres', escalate: true, reason: 'beyond what I can settle' };

/** A scripted level: may throw, hang, or return anything, garbage included (the service must cope). */
export type LevelScript = (req: AnswerRequest, signal: AbortSignal) => unknown;

/** Level double at the EscalationLevel seam. No safety net: a throw reaches the service. */
export function scriptedLevel(name: string, script: LevelScript, model = `${name}-m`): EscalationLevel {
  return { name, model, answer: async (req, signal) => (await script(req, signal)) as LevelReply };
}

export interface Rig {
  mem: MemoryStore;
  svc: QuestionService;
  /** The job the rig's questions are raised on. */
  job: Job;
  answered: Array<{ q: Question; depth: number }>;
  expired: Array<{ q: Question; depth: number }>;
  dismissed: Array<{ q: Question; depth: number }>;
  corrected: Array<{ q: Question; depth: number }>;
  /** Calls the levels received, in order. */
  asked: Array<{ level: string; req: AnswerRequest }>;
  /** Create a question the way the engine does: at the service's first stage, raised on `raisedBy` when given. */
  question(text?: string, raisedBy?: RaisedBy): Question;
  eventsOf(type: string): DomainEvent[];
  /** Swap the live levels (a plugins config reload). */
  setLevels(levels: EscalationLevel[]): void;
}

/** The config records at the ports seam: a map; `rules` holds the rules when given. */
function rulesConfig(rules: string | undefined): ConfigRecords {
  const values = new Map<string, unknown>(rules === undefined ? [] : [['rules', rules]]);
  const version = (n: string) => (values.has(n) ? `v:${JSON.stringify(values.get(n))}` : 'missing');
  return {
    read: (n) => values.get(n),
    version,
    write(n, value, v) { if (v !== version(n)) return false; values.set(n, value); return true; },
  };
}

export interface RigOptions {
  /** The levels, lowest first, by instance name. Default: `opus` answers. `{}`: no levels. */
  levels?: Record<string, LevelScript>;
  /** The rules; default a one-line rule, `null`: no rules. */
  rules?: string | null;
  renotifyMs?: number;
  humanTimeoutMs?: number;
  stageTimeoutMs?: number;
  /** Jev first (issue #550): absent, the levels only. */
  first?: JevFirst;
}

export function rig(o: RigOptions = {}): Rig {
  const mem = createMemoryStore();
  const config = rulesConfig(o.rules === null ? undefined : (o.rules ?? 'Prefer postgres.'));
  const answered: Rig['answered'] = [];
  const expired: Rig['expired'] = [];
  const dismissed: Rig['dismissed'] = [];
  const corrected: Rig['corrected'] = [];
  const asked: Rig['asked'] = [];
  const recorded = (name: string, script: LevelScript) => scriptedLevel(name, (req, signal) => {
    asked.push({ level: name, req });
    return script(req, signal);
  });
  let levels: EscalationLevel[] = Object.entries(o.levels ?? { opus: () => ANSWERED }).map(([name, script]) => recorded(name, script));
  const svc = createQuestionService({
    store: mem.store,
    clock: { now: () => new Date() },
    levels: () => levels,
    stageTimeoutMs: o.stageTimeoutMs ?? 60_000,
    config,
    renotifyMs: o.renotifyMs ?? 1000,
    humanTimeoutMs: o.humanTimeoutMs ?? 10_000,
    answerUrl: (id) => `http://localhost/q/${id}`,
    onAnswered: (q) => answered.push({ q, depth: mem.depth() }),
    onExpired: (q) => expired.push({ q, depth: mem.depth() }),
    onDismissed: (q) => dismissed.push({ q, depth: mem.depth() }),
    onCorrected: (q) => corrected.push({ q, depth: mem.depth() }),
    ...(o.first ? { minorDecisions: { first: o.first, gated: () => false } } : {}),
  });
  const job = mem.addJob('build the thing', 'ship it');
  return {
    mem, svc, answered, expired, dismissed, corrected, asked, job,
    question: (text = 'Which database?', raisedBy?: RaisedBy) =>
      mem.store.questions.create({ jobId: job.id, text, recentOutput: 'line1\nline2', detectedBy: 'marker', tier: svc.firstStage(), ...(raisedBy ? { raisedBy } : {}) }),
    eventsOf: (type) => mem.events.filter((e) => e.type === type),
    setLevels: (l) => { levels = l; },
  };
}

export async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

export function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
