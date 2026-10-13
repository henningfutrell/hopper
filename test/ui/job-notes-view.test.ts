// @vitest-environment happy-dom
// Issue #997: Add note on the job view (#job/<id>), rendered inside the whole app against a fake of the daemon's HTTP
// surface. A job that has not ended takes a note: Add note posts it. Its notes show with their state — queued, delivered
// (at the start, at a turn, with the resume), carried to the job that runs its item again. A viewer reads them and gets
// no form; an ended job shows its notes and no form.
//
// Feature: Notes to a running job
//   Scenario: an operator adds a note to a running job
//   Scenario: the job's notes show with their state
//   Scenario: a viewer, or an ended job, gets no form
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Job, JobNote } from '../../src/domain/types.ts';

const T = '2026-10-13T12:00:00.000Z';
const NOTES: JobNote[] = [
  { id: 'n1', text: 'The port is 8443.', by: 'ada', via: 'ui', at: T, state: 'delivered', delivery: 'turn', deliveredAt: T },
  { id: 'n2', text: 'Use eu-west-1.', by: 'a bot', via: 'api', at: T, state: 'queued' },
  { id: 'n3', text: 'Try the old address.', by: 'ada', via: 'ui', at: T, state: 'carried', carriedTo: 'r2-new' },
];
const running = {
  id: 'r1', spec: { executor: 'herdr-claude', payload: {}, goal: 'Reach the service' }, priority: 50, status: 'running', approved: true, attempts: 1,
  createdAt: T, updatedAt: T, startedAt: T, laneId: 'desk/lane-1', notes: NOTES,
} as unknown as Job;
const ended = { ...running, id: 'e1', status: 'finished', finishedAt: T, laneId: undefined } as unknown as Job;

let calls: { method: string; path: string; body?: unknown }[] = [];

function fakeDaemon(role: 'operator' | 'viewer') {
  const routes: Record<string, () => unknown> = {
    '/api/health': () => ({ ok: true, version: '0', router: 'pass-through', fallback: false, executors: ['herdr-claude'], uptimeS: 1 }),
    '/api/queue': () => ({ waiting: [], running: [running], operatorLed: [], parked: [], waitingAnswer: [], waitingOn: [], ended: [ended], locked: [] }),
    '/api/machines': () => ({ machines: [] }), '/api/decisions': () => ({ decisions: [] }), '/api/events': () => ({ events: [] }),
    '/api/webhooks': () => ({ subscriptions: [] }), '/api/webhooks/deliveries': () => ({ deliveries: [] }),
    '/api/questions': () => ({ questions: [] }), '/api/sources': () => ({ sources: [] }),
    '/api/usage': () => ({ readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }), '/api/accounts': () => ({ accounts: [] }),
    '/ui/api/jobs/r1/notes': () => ({ id: 'n4', text: 'The key is in the vault.', by: 'ada', via: 'ui', at: T, state: 'queued' }),
  };
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  return vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = String(input).split('?')[0]!;
    calls.push({ method: init.method ?? 'GET', path, ...(init.body ? { body: JSON.parse(String(init.body)) as unknown } : {}) });
    if (path === '/ui/api/session') return json({ authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role, realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
    return path in routes ? json(routes[path]!()) : new Response('{"error":"not found"}', { status: 404 });
  });
}

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(): void {}
  close(): void {}
}

let root: Root | undefined;

async function boot(id: string, role: 'operator' | 'viewer' = 'operator') {
  calls = [];
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = `#job/${id}`;
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  vi.stubGlobal('fetch', fakeDaemon(role));
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
  await vi.waitFor(() => expect(document.querySelector('[data-slot="job-notes"]')).not.toBeNull());
}

const button = (text: RegExp) => [...document.querySelectorAll('button')].find((b) => text.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
const noteRows = () => [...document.querySelectorAll<HTMLElement>('[data-slot="job-note"]')];

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('notes on the job view (issue #997)', () => {
  it('shows each note with who sent it, how, and its state', async () => {
    await boot('r1');
    const rows = noteRows();
    expect(rows.map((r) => r.getAttribute('data-state'))).toEqual(['delivered', 'queued', 'carried']);
    expect(rows[0]!.textContent).toContain('The port is 8443.');
    expect(rows[0]!.textContent).toContain('delivered at a turn boundary');
    expect(rows[1]!.textContent).toContain('queued: it goes in at the next turn boundary');
    expect(rows[1]!.textContent).toContain('over the API');
    expect(rows[2]!.textContent).toContain('carried to job r2-new');
  });

  it('Add note posts the note to the job; it is off while the text is empty', async () => {
    await boot('r1');
    const add = button(/Add note/)!;
    expect(add.disabled).toBe(true);
    const text = document.querySelector<HTMLTextAreaElement>('[data-slot="job-notes"] textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(text, 'The key is in the vault.');
      text.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(button(/Add note/)!.disabled).toBe(false);
    await act(async () => { button(/Add note/)!.click(); });
    await vi.waitFor(() => expect(calls.filter((c) => c.method === 'POST' && c.path === '/ui/api/jobs/r1/notes')).toEqual([
      { method: 'POST', path: '/ui/api/jobs/r1/notes', body: { text: 'The key is in the vault.' } },
    ]));
  });

  it('a viewer reads the notes and gets no form', async () => {
    await boot('r1', 'viewer');
    expect(noteRows()).toHaveLength(3);
    expect(document.querySelector('[data-slot="job-notes"] textarea')).toBeNull();
    expect(button(/Add note/)).toBeUndefined();
  });

  it('an ended job shows its notes and no form', async () => {
    await boot('e1');
    expect(noteRows()).toHaveLength(3);
    expect(document.querySelector('[data-slot="job-notes"] textarea')).toBeNull();
  });
});
