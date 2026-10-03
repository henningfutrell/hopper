// Starts the real composition root (src/main.ts) on port 0 against a temp SQLite file,
// with the fake advisor, fake usage source, fake answerers (src/main.ts documents their
// policy), the test executor only, and a fast tick. `seams` swaps in doubles at ports.ts seams.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config.ts';
import { startApp, type App, type AppSeams } from '../../src/main.ts';
import type { DomainEvent, Job, Question } from '../../src/domain/types.ts';
import { waitFor } from './wait.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read loose JSON
export interface ApiResponse<T = any> { status: number; body: T }

export interface TestApp {
  app: App;
  url: string;
  dbPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read loose JSON
  api<T = any>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>>;
  push(spec: Record<string, unknown>): Promise<Job>;
  job(id: string): Promise<Job>;
  waitForStatus(id: string, status: string, timeoutMs?: number): Promise<Job>;
  events(query?: string): Promise<DomainEvent[]>;
  /** Questions of one job, newest first (any status). */
  questionsOf(jobId: string): Promise<Question[]>;
  /** Waits until the job's newest question satisfies `ok`. */
  waitForQuestion(jobId: string, ok: (q: Question) => boolean, timeoutMs?: number): Promise<Question>;
  stop(): Promise<void>;
}

export function tempDbPath(): { dbPath: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'job-hopper-it-'));
  return { dbPath: join(dir, 'db.sqlite'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export async function startTestApp(o: { dbPath: string; env?: Record<string, string>; seams?: AppSeams }): Promise<TestApp> {
  const config = loadConfig({
    JOB_HOPPER_PORT: '0',
    JOB_HOPPER_DB: o.dbPath,
    JOB_HOPPER_TICK_MS: '50',
    JOB_HOPPER_JEV_ADVISOR: 'fake',
    JOB_HOPPER_WEBHOOK_BASE_MS: '20',
    JOB_HOPPER_LANE_IDLE_GRACE_MS: '200',
    JOB_HOPPER_EXECUTORS: 'test',
    JOB_HOPPER_ANSWERER: 'fake',
    JOB_HOPPER_RULES_FILE: '/nonexistent/job-hopper-rules.md',
    ...o.env,
  });
  const app = await startApp(config, o.seams);
  const api = async <T>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>> => {
    const res = await fetch(app.url + path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined } as ApiResponse<T>;
  };
  const job = async (id: string): Promise<Job> => (await api<Job>('GET', `/api/jobs/${id}`)).body;
  const questionsOf = async (jobId: string): Promise<Question[]> => (await api<{ questions: Question[] }>(
    'GET', '/api/questions?status=all&limit=1000')).body.questions.filter((q) => q.jobId === jobId);
  let stopped = false;
  return {
    app,
    url: app.url,
    dbPath: o.dbPath,
    api,
    async push(spec) {
      const res = await api<Job>('POST', '/api/jobs', spec);
      if (res.status !== 201) throw new Error(`push failed ${res.status}: ${JSON.stringify(res.body)}`);
      return res.body;
    },
    job,
    waitForStatus: (id, status, timeoutMs) => waitFor(async () => {
      const j = await job(id);
      return j.status === status ? j : undefined;
    }, { timeoutMs, what: `job ${id} to be ${status}` }),
    events: async (query = 'limit=1000') => (await api<{ events: DomainEvent[] }>('GET', `/api/events?${query}`)).body.events,
    questionsOf,
    waitForQuestion: (jobId, ok, timeoutMs) => waitFor(async () => {
      const q = (await questionsOf(jobId))[0];
      return q && ok(q) ? q : undefined;
    }, { timeoutMs, what: `a matching question on job ${jobId}` }),
    async stop() {
      if (stopped) return;
      stopped = true;
      await app.stop();
    },
  };
}
