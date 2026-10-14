// @vitest-environment happy-dom
// The raising machine in the UI (issue #485): the question card, the question history (row and opened
// detail) and the event lines name the machine that raised a question — its name, with id and lane on
// hover — from the question's own snapshot; with none, they say "machine unknown", never a blank. The
// device-code component shows a machine when one is given and nothing extra when not.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const DESK = { machineId: 'desk', name: 'Desk tower', laneId: 'desk/lane-2' };
const base = {
  jobId: 'j1', recentOutput: 'line', detectedBy: 'marker', tier: 'human', attempts: [], notifyCount: 1,
  createdAt: '2026-10-08T10:00:00.000Z', updatedAt: '2026-10-08T10:00:00.000Z',
};
const fromDesk = { ...base, id: 'q1', text: 'Which branch?', status: 'open', raisedBy: DESK };
const unknown = { ...base, id: 'q2', text: 'Rebase or merge?', status: 'open' };
const handled = { ...base, id: 'q3', text: 'Ship it?', status: 'answered', answer: 'yes', answeredBy: 'human', raisedBy: DESK };
const askedEvent = { seq: 1, schemaVersion: 1, id: 'e1', type: 'question.asked', at: '2026-10-08T10:00:00.000Z', jobId: 'j1', laneId: 'desk/lane-2', machineId: 'desk', questionId: 'q1', data: { questionId: 'q1', text: 'Which branch?', detectedBy: 'marker', raisedBy: DESK } };
const oldEvent = { ...askedEvent, seq: 2, id: 'e2', questionId: 'q2', laneId: undefined, machineId: undefined, data: { questionId: 'q2', text: 'Rebase or merge?', detectedBy: 'marker' } };

function fakeFetch() {
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': { waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: [], ended: [], locked: [] },
    '/api/machines': { machines: [] },
    '/api/decisions': { decisions: [] },
    '/api/events': { events: [oldEvent, askedEvent] },
    '/api/webhooks': { subscriptions: [] },
    '/api/webhooks/deliveries': { deliveries: [] },
    '/api/sources': { sources: [] },
    '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] },
    '/api/accounts': { accounts: [] },
  };
  return vi.fn(async (input: string) => {
    const [path, query = ''] = String(input).split('?') as [string, string?];
    if (path === '/ui/api/session') return json({ authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: 'admin', realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
    if (path === '/api/questions') return json({ questions: new URLSearchParams(query).get('status') === 'all' ? [fromDesk, unknown, handled] : [fromDesk, unknown] });
    if (path.startsWith('/ui/api/')) return json({});
    return json(routes[path] ?? {});
  });
}

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(): void {}
  close(): void {}
}

let root: Root | undefined;

async function render(make: (m: Record<string, unknown>) => ReturnType<typeof createElement>, path: string) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  vi.resetModules();
  const mod = (await import(path)) as Record<string, unknown>;
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(make(mod)); });
}

async function boot(hash: string) {
  window.location.hash = hash;
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  vi.stubGlobal('fetch', fakeFetch());
  vi.stubGlobal('EventSource', FakeEventSource);
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  await render((m) => createElement(m.App as () => ReturnType<typeof createElement>), app);
}

const cardOf = (text: string) => [...document.querySelectorAll('[data-slot="card"]')].find((c) => c.textContent?.includes(text)) ?? null;
const raised = (within: ParentNode) => within.querySelector('[data-slot="raised-by"]');

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('the raising machine in the UI (issue #485)', () => {
  it('the question card names the machine, with its id and lane on hover; one with none says machine unknown', async () => {
    await boot('#questions');
    const desk = await vi.waitFor(() => { const c = cardOf('Which branch?'); expect(c).not.toBeNull(); return c!; });
    expect(raised(desk)!.textContent).toContain('Desk tower');
    expect(raised(desk)!.getAttribute('title')).toContain('desk');
    expect(raised(desk)!.getAttribute('title')).toContain('desk/lane-2');
    expect(raised(cardOf('Rebase or merge?')!)!.textContent).toContain('machine unknown');
  });

  it('the question history row and its opened detail name the machine', async () => {
    await boot('#settings/history');
    const row = await vi.waitFor(() => { const r = document.querySelector('[data-slot="handled-question"]'); expect(r).not.toBeNull(); return r!; });
    expect(raised(row)!.textContent).toContain('Desk tower');
    await act(async () => { (row.querySelector('button') as HTMLElement).click(); });
    await vi.waitFor(() => expect(row.querySelectorAll('[data-slot="raised-by"]').length).toBeGreaterThanOrEqual(2));
  });

  it('an event line of a question names the machine; an older one with none says machine unknown', async () => {
    await boot('#events');
    await vi.waitFor(() => expect(document.body.textContent).toContain('on Desk tower'));
    expect(document.body.textContent).toContain('on machine unknown');
  });

  it('the device code shows the machine when given, and nothing extra when not', async () => {
    const props = { provider: 'GitHub', userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device', waiting: 'waiting', onCancel: () => {} };
    const path = '../../ui/src/components/device-code.tsx';
    await render((m) => createElement(m.DeviceCode as never, { ...props, machine: { name: 'Desk tower', id: 'desk' } }), path);
    expect(raised(document)!.textContent).toContain('Desk tower');
    expect(raised(document)!.getAttribute('title')).toContain('desk');
    await act(async () => root?.unmount());
    await render((m) => createElement(m.DeviceCode as never, props), path);
    expect(document.querySelector('[data-device-code]')).not.toBeNull();
    expect(raised(document)).toBeNull();
  });
});
