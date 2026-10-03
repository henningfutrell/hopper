// In-memory Store stand-in: only what the question service touches (questions, jobs.get,
// events.append, tx). Records the tx depth at every event so tests can assert that
// onAnswered/onExpired run inside the transaction. tx rolls back on throw.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { AnswerDraft, AnswerRequest, Answerer, Assessment, Assessor, QuestionService, Store } from '../../src/domain/ports.ts';
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

export const SAFE: AnswerDraft = { answer: 'use postgres', confident: true, reason: 'rules say so' };
export const PROCEED: Assessment = { escalate: false, reason: 'routine, the rules settle it' };

type Result<T> = T | { error: string };
/** A scripted answerer stage: may throw, hang, or return anything (the service must cope). */
export type AnswerScript = (req: AnswerRequest, signal: AbortSignal) => Result<AnswerDraft> | Promise<Result<AnswerDraft>>;
export type AssessScript = (req: AnswerRequest, draft: AnswerDraft, signal: AbortSignal) => unknown;

/** Answerer double at the Answerer seam. No safety net: a throw reaches the service. */
export function scriptedAnswerer(name: string, script: AnswerScript, model = `${name}-m`): Answerer {
  return { name, model, answer: async (req, signal) => script(req, signal) };
}

/** Assessor double at the Assessor seam. Returns whatever the script returns, garbage included. */
export function scriptedAssessor(name: string, script: AssessScript, model = `${name}-m`): Assessor {
  return { name, model, assess: async (req, draft, signal) => (await script(req, draft, signal)) as Assessment };
}

export interface Rig {
  mem: MemoryStore;
  svc: QuestionService;
  answered: Array<{ q: Question; depth: number }>;
  expired: Array<{ q: Question; depth: number }>;
  /** Calls the assessor received, in order. */
  assessed: Array<{ req: AnswerRequest; draft: AnswerDraft }>;
  /** Create a question the way the engine does: at the service's first stage. */
  question(text?: string): Question;
  eventsOf(type: string): DomainEvent[];
  /** Swap the live answerer / assessor (plugins.yaml reload). `null` → no answerer. */
  setAnswerer(a: Answerer | null): void;
  setAssessor(a: Assessor): void;
}

export interface RigOptions {
  /** Script of the answerer instance `opus`; `null` → no answerer configured. */
  answer?: AnswerScript | null;
  /** Script of the assessor instance `fable`. */
  assess?: AssessScript;
  rules?: string | null;
  renotifyMs?: number;
  humanTimeoutMs?: number;
  stageTimeoutMs?: number;
}

export function rig(o: RigOptions = {}): Rig {
  const mem = createMemoryStore();
  let rulesFile = join(tmpdir(), 'jh-no-such-rules-file.md');
  if (o.rules !== null && o.rules !== undefined) {
    rulesFile = join(mkdtempSync(join(tmpdir(), 'jh-rules-')), 'rules.md');
    writeFileSync(rulesFile, o.rules);
  }
  const answered: Rig['answered'] = [];
  const expired: Rig['expired'] = [];
  const assessed: Rig['assessed'] = [];
  let answerer: Answerer | undefined = o.answer === null ? undefined : scriptedAnswerer('opus', o.answer ?? (() => SAFE));
  const script = o.assess ?? (() => PROCEED);
  let assessor: Assessor = scriptedAssessor('fable', (req, draft, signal) => {
    assessed.push({ req, draft });
    return script(req, draft, signal);
  });
  const svc = createQuestionService({
    store: mem.store,
    clock: { now: () => new Date() },
    answerer: () => answerer,
    assessor: () => assessor,
    stageTimeoutMs: o.stageTimeoutMs ?? 60_000,
    rulesFile,
    renotifyMs: o.renotifyMs ?? 1000,
    humanTimeoutMs: o.humanTimeoutMs ?? 10_000,
    answerUrl: (id) => `http://localhost/q/${id}`,
    onAnswered: (q) => answered.push({ q, depth: mem.depth() }),
    onExpired: (q) => expired.push({ q, depth: mem.depth() }),
  });
  const job = mem.addJob('build the thing', 'ship it');
  return {
    mem, svc, answered, expired, assessed,
    question: (text = 'Which database?') =>
      mem.store.questions.create({ jobId: job.id, text, recentOutput: 'line1\nline2', detectedBy: 'marker', tier: svc.firstStage() }),
    eventsOf: (type) => mem.events.filter((e) => e.type === type),
    setAnswerer: (a) => { answerer = a ?? undefined; },
    setAssessor: (a) => { assessor = a; },
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
