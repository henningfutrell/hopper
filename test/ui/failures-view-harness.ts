// The Failures view's test harness (ui/src/views/failures.tsx): the whole app rendered in happy-dom against a fake of the
// daemon's HTTP surface — the browser's only seam — with a day of failures, problems and hand-offs. Shared by the Failures
// view's test files; `unmount` after each test.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { vi } from 'vitest';

export const T0 = Date.parse('2026-10-08T12:00:00.000Z');
export const at = (s: number) => new Date(T0 + s * 1000).toISOString();

export const failedJob = {
  id: 'j1', status: 'failed', priority: 50, attempts: 1, createdAt: at(-600), updatedAt: at(-60), finishedAt: at(-60), error: 'no space left on device',
  spec: { executor: 'herdr-claude', payload: {}, goal: 'Fix the build' }, approved: false,
  assessment: { recordId: 'f1', at: at(-59), class: 'shared', decision: 'hold', summary: 'Held: Disk full on desk', reasons: ['known cause: Disk full'], problemId: 'p1', problemTitle: 'Disk full on desk' },
};
export const settings = { maxAttempts: 3, backoffSec: 60, backoffFactor: 2, backoffMaxSec: 1800, groupThreshold: 3, groupWindowMin: 60, auto: { retry: true, hold: true, redirect: true }, retentionDays: 90 };
export const evidence = { error: 'no space left on device', executor: 'herdr-claude', machineId: 'desk', attempt: 1, sameSignature: 2 };
export const problem = (over: Record<string, unknown> = {}) => ({
  id: 'p1', signature: 'aaa', title: 'Disk full on desk', causeId: 'disk-full', decision: 'redirect', scope: { machineId: 'desk' }, status: 'open',
  openedAt: at(-120), updatedAt: at(-60), general: false, jobIds: ['j1', 'j2', 'j3'], held: ['j1'],
  actions: { resolve: { ok: true }, release: { ok: false, why: 'no job is held' } }, ...over,
});
export const record = (over: Record<string, unknown> = {}) => ({
  id: 'f1', jobId: 'j1', at: at(-59), signature: 'aaa', normalised: 'no space left on device', cls: 'shared', decision: 'hold', causeId: 'disk-full', causeName: 'Disk full',
  reasons: ['known cause: Disk full'], summary: 'Held: Disk full on desk', auto: true, evidence, problemId: 'p1', outcome: 'held',
  actions: { retry: { ok: false, why: 'it waits on its problem' } }, ...over,
});
export const handoff = (over: Record<string, unknown> = {}) => ({
  id: 'h1', jobId: 'j9', recordId: 'f2', status: 'open', reason: 'person', openedAt: at(-30), decision: 'person', class: 'job',
  summary: 'Needs a person. Ran 1 time on desk. Failed: tests fail.', reasons: ['no known cause matches', 'not seen on other jobs: it needs a person'], error: 'HOPPER_FAILED tests fail',
  actions: { continue: { ok: true }, fixed: { ok: true }, doneByHand: { ok: true }, wontDo: { ok: true } }, continueResumes: true, signature: 'bbbbbbbbbbbb',
  card: { whatHappened: 'The job stopped before it opened or updated a PR.', recommended: 'continue', why: 'Its session can go on. Tell it what to do in a note.' }, ...over,
});
export const view = (over: Record<string, unknown> = {}) => ({
  now: at(0), counts: { failed: 0, needsPerson: 0 }, settings, handoffs: [] as ReturnType<typeof handoff>[], keptWork: [] as Record<string, unknown>[], stuck: [] as Record<string, unknown>[], causes: [{ id: 'disk-full', name: 'Disk full', description: 'The disk is full.', cls: 'shared', decision: 'redirect', builtin: true }],
  problems: [problem()], ended: [] as ReturnType<typeof record>[], recent: [record(), record({ id: 'f2', jobId: 'j9', cls: 'job', decision: 'person', outcome: 'surfaced', problemId: undefined, summary: 'Needs a person. Ran 1 time on desk. Failed: tests fail.', actions: { retry: { ok: true } } })],
  profile: {
    days: [{ day: '2026-10-07', count: 1 }, { day: '2026-10-08', count: 3 }],
    signatures: [{ signature: 'aaa', name: 'Disk full', cls: 'shared', count: 3, jobs: 3, machines: 1, lastAt: at(-59), general: false, trend: [0, 3] }],
    byMachine: [{ key: 'desk', count: 3 }], byRepo: [{ key: 'o/a', count: 3 }], byExecutor: [{ key: 'herdr-claude', count: 3 }],
  },
  ...over,
});

export type Role = 'viewer' | 'operator' | 'admin';
export interface Daemon { failures: ReturnType<typeof view>; role?: Role }

export function fakeDaemon(d: Daemon) {
  const posts: string[] = [];
  const bodies: unknown[] = [];
  let reads = 0;
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': { waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: [], ended: [failedJob], locked: [failedJob] },
    '/api/machines': { machines: [] }, '/api/decisions': { decisions: [] }, '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] }, '/api/sources': { sources: [] },
    '/api/questions': { questions: [] }, '/api/accounts': { accounts: [] },
    '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] },
    '/api/logins': { now: at(0), settings: { onExpiry: 'fail', warnSec: 60 }, logins: [] },
  };
  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const [path] = String(input).split('?') as [string];
    if (path === '/ui/api/session') return json(200, { authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: d.role ?? 'operator', realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
    if (path === '/api/failures') { reads += 1; return json(200, d.failures); }
    if (path.startsWith('/ui/api/')) { posts.push(`${init.method ?? 'GET'} ${path}`); bodies.push(init.body ? JSON.parse(String(init.body)) : undefined); return json(200, {}); }
    return json(200, routes[path] ?? {});
  });
  return { fetch, posts, bodies, reads: () => reads };
}

export class FakeEventSource {
  static last: FakeEventSource | undefined;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, (m: { data: string }) => void>();
  constructor() { FakeEventSource.last = this; }
  addEventListener(type: string, fn: (m: { data: string }) => void): void { this.listeners.set(type, fn); }
  close(): void {}
  send(e: Record<string, unknown>): void { this.listeners.get(String(e.type))?.({ data: JSON.stringify(e) }); }
}

let root: Root | undefined;
export let daemon: ReturnType<typeof fakeDaemon>;

/** `kept`: a reload, with what the browser kept (issue #2353); else a browser that kept nothing. */
export async function boot(hash: string, d: Daemon, kept = false) {
  window.location.hash = hash;
  if (!kept) localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  daemon = fakeDaemon(d);
  vi.stubGlobal('fetch', daemon.fetch);
  vi.stubGlobal('EventSource', FakeEventSource);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx';
  const mod = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(mod.App)); });
  await settle();
}

export async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

export const buttonsIn = (el: Element | null) => [...(el?.querySelectorAll('button') ?? [])].map((b) => b.textContent ?? '');
export const problemCard = () => document.querySelector('[data-problem="p1"]');
export const handoffRow = (id = 'h1') => document.querySelector(`[data-handoff="${id}"]`);
export const navBadge = () => document.querySelector('a[href="#failures"] [data-slot="nav-badge"]')?.textContent;

/** Unmounts the app the last boot rendered. */
export async function unmount(): Promise<void> {
  await act(async () => root?.unmount());
  root = undefined;
}
