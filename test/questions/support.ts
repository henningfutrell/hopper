// In-memory Store stand-in: only what the question service touches (questions, jobs.get,
// events.append, tx). Records the tx depth at every event so tests can assert that
// onAnswered/onExpired run inside the transaction. tx rolls back on throw.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { Answerer, QuestionService, Store } from '../../src/domain/ports.ts';
import type { AnswerVerdict } from '../../src/domain/ports.ts';
import type { DomainEvent, Job, NewEvent, Question, QuestionAttempt } from '../../src/domain/types.ts';
import { createFakeAnswerer, createQuestionService } from '../../src/questions/index.ts';

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
        const ev = { ...e, seq: events.length + 1, id: `e${events.length + 1}`, at: e.at ?? now(), txDepth: depth };
        events.push(structuredClone(ev));
        return ev;
      },
    },
    questions: {
      create(input: { jobId: string; text: string; recentOutput: string; detectedBy: string }): Question {
        const q: Question = {
          id: `q${++qn}`, ...input, status: 'open', tier: 'opus', attempts: [], notifyCount: 0,
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

export const SAFE: AnswerVerdict = { answer: 'use postgres', confident: true, risky: false, reason: 'rules say so' };

export interface Rig {
  mem: MemoryStore;
  svc: QuestionService;
  answered: Array<{ q: Question; depth: number }>;
  expired: Array<{ q: Question; depth: number }>;
  question(text?: string): Question;
  eventsOf(type: string): DomainEvent[];
}

export interface RigOptions {
  opus?: Parameters<typeof createFakeAnswerer>[0]['script'];
  fable?: Parameters<typeof createFakeAnswerer>[0]['script'];
  rules?: string | null;
  renotifyMs?: number;
  humanTimeoutMs?: number;
  answerers?: Answerer[];
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
  const answerers = o.answerers ?? [
    createFakeAnswerer({ tier: 'opus', model: 'opus-m', script: o.opus ?? (() => SAFE) }),
    createFakeAnswerer({ tier: 'fable', model: 'fable-m', script: o.fable ?? (() => SAFE) }),
  ];
  const svc = createQuestionService({
    store: mem.store,
    clock: { now: () => new Date() },
    answerers,
    rulesFile,
    renotifyMs: o.renotifyMs ?? 1000,
    humanTimeoutMs: o.humanTimeoutMs ?? 10_000,
    answerUrl: (id) => `http://localhost/q/${id}`,
    onAnswered: (q) => answered.push({ q, depth: mem.depth() }),
    onExpired: (q) => expired.push({ q, depth: mem.depth() }),
  });
  const job = mem.addJob('build the thing', 'ship it');
  return {
    mem, svc, answered, expired,
    question: (text = 'Which database?') =>
      mem.store.questions.create({ jobId: job.id, text, recentOutput: 'line1\nline2', detectedBy: 'marker' }),
    eventsOf: (type) => mem.events.filter((e) => e.type === type),
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
