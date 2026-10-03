// Starts the real composition root (src/main.ts) on port 0 against a temp SQLite file,
// with the fake advisor and fake usage source, and a fast tick.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config.ts';
import { startApp, type App } from '../../src/main.ts';
import type { DomainEvent, Job } from '../../src/domain/types.ts';
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
  stop(): Promise<void>;
}

export function tempDbPath(): { dbPath: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'job-hopper-it-'));
  return { dbPath: join(dir, 'db.sqlite'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export async function startTestApp(o: { dbPath: string; env?: Record<string, string> }): Promise<TestApp> {
  const config = loadConfig({
    JOB_HOPPER_PORT: '0',
    JOB_HOPPER_DB: o.dbPath,
    JOB_HOPPER_TICK_MS: '50',
    JOB_HOPPER_JEV_ADVISOR: 'fake',
    JOB_HOPPER_WEBHOOK_BASE_MS: '20',
    JOB_HOPPER_LANE_IDLE_GRACE_MS: '200',
    ...o.env,
  });
  const app = await startApp(config);
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
    async stop() {
      if (stopped) return;
      stopped = true;
      await app.stop();
    },
  };
}
