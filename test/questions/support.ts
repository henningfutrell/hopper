// In-memory Store stand-in: only what the question service touches (questions, jobs.get,
// events.append, tx). Records the tx depth at every event so tests can assert that
// onAnswered/onExpired run inside the transaction. tx rolls back on throw.
import { vi } from 'vitest';
import type { AnswerRequest, ConfigDocuments, EscalationLevel, LevelReply, QuestionService, Store } from '../../src/domain/ports.ts';
import { EVENT_SCHEMA_VERSIONS, type DomainEvent, type Job, type NewEvent, type Question, type QuestionAttempt } from '../../src/domain/types.ts';
import { createQuestionService } from '../../src/questions/index.ts';

export interface MemoryStore {
  store: Store;
  events: Array<DomainEvent & { txDepth: number }>;
  depth(): number;
  addJob(prompt: string, goal?: string): Job;
}

export function createMemoryStore(): MemoryStore {
  let questions = new Map<string, Question>();
  const jobs = new Map<string, Job>();
  let events: Array<DomainEvent & { txDepth: number }> = [];
  let depth = 0;
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
      create(input: { jobId: string; text: string; recentOutput: string; detectedBy: string; tier: string }): Question {
        const q: Question = {
          id: `q${++qn}`, ...input, status: 'open', attempts: [], notifyCount: 0,
          createdAt: now(), updatedAt: now(),
        };
        questions.set(q.id, q);
        return structuredClone(q);
      },
      get: (id: string) => (questions.has(id) ? structuredClone(questions.get(id)) : undefined),
      list: (f?: { status?: string[] }) =>
        [...questions.values()].filter((q) => !f?.status || f.status.includes(q.status)).map((q) => structuredClone(q)),
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
  } as unknown as Store;
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
  } as MemoryStore;
}

/** A level that answers: what is typed into the job when no risk rule matches. */
export const ANSWERED: LevelReply = { answer: 'use postgres', escalate: false, reason: 'rules say so' };
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
  answered: Array<{ q: Question; depth: number }>;
  expired: Array<{ q: Question; depth: number }>;
  dismissed: Array<{ q: Question; depth: number }>;
  /** Calls the levels received, in order. */
  asked: Array<{ level: string; req: AnswerRequest }>;
  /** Create a question the way the engine does: at the service's first stage. */
  question(text?: string): Question;
  eventsOf(type: string): DomainEvent[];
  /** Swap the live levels (plugins.yaml reload). */
  setLevels(levels: EscalationLevel[]): void;
}

/** The config documents at the ports seam: a map; `rules.md` holds `rules` when given. */
function rulesDocuments(rules: string | undefined): ConfigDocuments {
  const texts = new Map<string, string>(rules === undefined ? [] : [['rules.md', rules]]);
  const version = (n: string) => (texts.has(n) ? `v:${texts.get(n)}` : 'missing');
  return {
    read: (n) => texts.get(n),
    version,
    write(n, text, v) { if (v !== version(n)) return false; texts.set(n, text); return true; },
  };
}

export interface RigOptions {
  /** The levels, lowest first, by instance name. Default: `opus` answers. `{}`: no levels. */
  levels?: Record<string, LevelScript>;
  /** rules.md; default a one-line rule, `null`: no rules.md. */
  rules?: string | null;
  renotifyMs?: number;
  humanTimeoutMs?: number;
  stageTimeoutMs?: number;
}

export function rig(o: RigOptions = {}): Rig {
  const mem = createMemoryStore();
  const documents = rulesDocuments(o.rules === null ? undefined : (o.rules ?? 'Prefer postgres.'));
  const answered: Rig['answered'] = [];
  const expired: Rig['expired'] = [];
  const dismissed: Rig['dismissed'] = [];
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
    documents,
    renotifyMs: o.renotifyMs ?? 1000,
    humanTimeoutMs: o.humanTimeoutMs ?? 10_000,
    answerUrl: (id) => `http://localhost/q/${id}`,
    onAnswered: (q) => answered.push({ q, depth: mem.depth() }),
    onExpired: (q) => expired.push({ q, depth: mem.depth() }),
    onDismissed: (q) => dismissed.push({ q, depth: mem.depth() }),
  });
  const job = mem.addJob('build the thing', 'ship it');
  return {
    mem, svc, answered, expired, dismissed, asked,
    question: (text = 'Which database?') =>
      mem.store.questions.create({ jobId: job.id, text, recentOutput: 'line1\nline2', detectedBy: 'marker', tier: svc.firstStage() }),
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
