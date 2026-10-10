// The question card's test harness (ui/src/views/questions.tsx): the whole app rendered in happy-dom against a fake of the
// daemon's HTTP surface — the browser's only seam. Shared by the question card's test files; `unmount` after each test.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { expect, vi } from 'vitest';

export const question = {
  id: 'bf094266', jobId: '89849c4f', text: 'Which branch?', recentOutput: 'line', detectedBy: 'marker', status: 'open',
  tier: 'human', attempts: [], notifyCount: 1, createdAt: '2026-10-03T20:00:00.000Z', updatedAt: '2026-10-03T20:00:00.000Z',
};

export const handled = {
  ...question, id: 'c41a0d2e', text: 'Rebase or merge?', status: 'answered', answer: 'merge', answeredBy: 'human',
  createdAt: '2026-10-03T19:00:00.000Z', updatedAt: '2026-10-03T19:05:00.000Z',
};

export interface Call { path: string; method: string; headers: Record<string, string>; body?: unknown }

export type Role = 'viewer' | 'operator' | 'admin';
export interface Boot { attempts?: unknown[]; escalation?: unknown; more?: Record<string, unknown>[]; lapsesAt?: string; seenAt?: string; tier?: string; authed: boolean; hash?: string; role?: Role; mutationStatus?: number; mutationError?: string; mutationDelayMs?: number; needs?: Role; realms?: { name: string; label: string; type: string }[] }

export function fakeDaemon(o: Boot) {
  const calls: Call[] = [];
  const open = {
    ...question, attempts: o.attempts ?? [], ...(o.lapsesAt ? { lapsesAt: o.lapsesAt } : {}), ...(o.seenAt ? { seenAt: o.seenAt } : {}), ...(o.tier ? { tier: o.tier } : {}),
    ...(o.escalation ? { escalation: o.escalation } : {}),
  } as Record<string, unknown>;
  // What GET /api/questions?status=open answers; a test changes it as the daemon's questions change.
  const daemonState = { open: [open, ...(o.more ?? [])] };
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': { waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: [], ended: [], locked: [] },
    '/api/machines': { machines: [] },
    '/api/decisions': { decisions: [] },
    '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] },
    '/api/webhooks/deliveries': { deliveries: [] },
    '/api/sources': { sources: [] },
    '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] },
    '/api/accounts': { accounts: [] },
  };
  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const [path, query = ''] = String(input).split('?') as [string, string?];
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    calls.push({ path, method: init.method ?? 'GET', headers, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
    const signIn = { local: true, origin: location.origin, realms: o.realms ?? [] };
    if (path === '/ui/api/session') {
      return json(200, o.authed
        ? { authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: o.role ?? 'admin', realm: 'local', name: 'login code' }, signIn }
        : { authenticated: false, signIn });
    }
    if (path === '/api/questions') return json(200, { questions: new URLSearchParams(query).get('status') === 'all' ? [...daemonState.open, handled] : daemonState.open });
    if (path === `/ui/api/questions/${question.id}/seen`) { open.seenAt ??= '2026-10-03T20:01:00.000Z'; return json(200, open); }
    if (path.startsWith('/ui/api/')) {
      if (o.mutationDelayMs) await new Promise((r) => setTimeout(r, o.mutationDelayMs));
      const status = o.mutationStatus ?? 200;
      if (status === 200) return json(200, { ...question, status: 'closed' });
      if (o.mutationError) return json(status, { error: o.mutationError });
      return json(status, o.needs ? { error: `role ${o.role} may not do this; it needs ${o.needs}`, needs: o.needs } : { error: 'missing or invalid x-hopper-session' });
    }
    if (path in routes) return json(200, routes[path]);
    return json(404, { error: 'not found' });
  });
  return { fetch, calls, open, setOpen: (qs: Record<string, unknown>[]) => { daemonState.open = qs; } };
}

export const streams: FakeEventSource[] = [];
export class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, (m: { data: string }) => void>();
  constructor() { streams.push(this); }
  addEventListener(type: string, fn: (m: { data: string }) => void): void { this.listeners.set(type, fn); }
  close(): void {}
}
let seq = 0;
/** The daemon's stream sends a question event, as it does on a raise, an answer, a close, a dismiss or an expiry. */
export const emit = (type: string) => act(async () => {
  streams.at(-1)!.listeners.get(type)!({ data: JSON.stringify({ seq: ++seq, schemaVersion: 1, id: String(seq), type, at: new Date().toISOString(), jobId: question.jobId, data: { questionId: question.id } }) });
});

let root: Root | undefined;

/** Unmounts the app the last boot rendered, and drops the stubbed globals. */
export async function unmount(): Promise<void> {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
}

export async function boot(o: Boot) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = o.hash ?? '#questions';
  localStorage.clear();
  if (o.authed) localStorage.setItem('jh_session', 'a'.repeat(64));
  const daemon = fakeDaemon(o);
  vi.stubGlobal('fetch', daemon.fetch);
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
  if (!o.hash && o.authed) await vi.waitFor(() => expect(card()).not.toBeNull());
  return daemon;
}

export const card = () => [...document.querySelectorAll('[data-slot="card"]')].find((c) => c.textContent?.includes(question.text)) ?? null;
export const button = (label: string, within: ParentNode = card()!) => [...within.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
export const notice = () => card()!.querySelector('[data-slot="login-notice"]');
export const landing = () => document.querySelector('[data-slot="landing"]');
export const click = (b: HTMLElement | undefined) => act(async () => { b!.click(); });
