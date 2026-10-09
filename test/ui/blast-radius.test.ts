// @vitest-environment happy-dom
// Issue #542: blast radius in the UI. The settings read as one sentence; a discovery's changes as a short line. A job
// held at the gate shows why, as other holds do; an admin sees Let through, and nobody sees Approve for it — approving
// would not move it past the gate. A role the server refuses sees no button.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { changesText, summaryOf } from '../../ui/src/model/blast-radius.ts';
import { DEFAULT_BLAST_RADIUS_SETTINGS, type BlastRadiusView } from '../../src/domain/types.ts';

const view = (over: Partial<BlastRadiusView['settings']> = {}): BlastRadiusView => ({
  settings: { ...DEFAULT_BLAST_RADIUS_SETTINGS, ...over }, defaults: DEFAULT_BLAST_RADIUS_SETTINGS, machines: [], awsActions: { write: [], admin: [] }, kubeChecks: [],
});

describe('blast radius, as people read it', () => {
  it('the settings in one sentence', () => {
    expect(summaryOf(view())).toBe('Machines rated high, and actor machines, take only jobs let through by a person. Discovered every 60 minutes.');
    expect(summaryOf(view({ gateAt: 'medium', pass: { labels: ['hopper:actor'], repos: ['org/infra'], minPriority: 90 } })))
      .toBe('Machines rated medium or high, and actor machines, take only jobs let through by a person or with the label hopper:actor, from org/infra or of priority 90 and above. Discovered every 60 minutes.');
    expect(summaryOf(view({ gateAt: 'off' }))).toBe('Only actor machines are gated: they take only jobs let through by a person. Discovered every 60 minutes.');
  });

  it('what a discovery changed', () => {
    expect(changesText({ first: true, added: [], removed: [] })).toBe('first discovery');
    expect(changesText({ first: false, added: [], removed: [] })).toBe('nothing changed');
    expect(changesText({ first: false, added: ['aws prod', 'tool /usr/bin/kubectl'], removed: ['credential file pgpass'], level: { from: 'low', to: 'high' } }))
      .toBe('level low → high; added aws prod, tool /usr/bin/kubectl; removed credential file pgpass');
  });
});

const HOLD = 'held at the blast-radius gate: desk is rated high; only a job let through the gate runs there';
const heldJob = {
  id: 'g1', spec: { executor: 'test', payload: {}, goal: 'goal g1' }, priority: 50, status: 'held', holdReason: HOLD, approved: false, accepted: true,
  createdAt: '2026-10-03T10:00:00Z', updatedAt: '2026-10-03T10:00:00Z', attempts: 0,
};

function fakeDaemon(role: string, posts: string[]) {
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': {
      waiting: [heldJob], running: [], operatorLed: [], parked: [], waitingAnswer: [], ended: [], locked: [],
      gate: { mode: 'auto-accept', autoAcceptPerHour: null }, presort: { sorter: 'priority', jobIds: [], reject: [] },
    },
    '/api/machines': { machines: [] }, '/api/decisions': { decisions: [] }, '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] },
    '/api/questions': { questions: [] }, '/api/sources': { sources: [] },
    '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }, '/api/accounts': { accounts: [] },
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  return vi.fn(async (input: string, init?: RequestInit) => {
    const path = String(input).split('?')[0]!;
    if (path === '/ui/api/session') return json(200, { authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role, realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
    if (init?.method === 'POST') { posts.push(path); return json(200, { ...heldJob, gatePass: { at: '2026-10-03T10:01:00Z' } }); }
    if (path in routes) return json(200, routes[path]);
    return json(404, { error: 'not found' });
  });
}

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(): void {}
  close(): void {}
}

let root: Root | undefined;

async function boot(role: string, posts: string[] = []) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = '#queue';
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  vi.stubGlobal('fetch', fakeDaemon(role, posts));
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx';
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

const row = () => document.querySelector('[data-job-id="g1"]');
const buttons = () => [...row()!.querySelectorAll('button')].map((b) => b.textContent?.trim());

describe('a job held at the gate', () => {
  it('shows why; an admin may let it through, and nobody is offered Approve', async () => {
    const posts: string[] = [];
    await boot('admin', posts);
    await vi.waitFor(() => expect(row()?.textContent).toContain(HOLD));
    expect(buttons()).toContain('Let through');
    expect(buttons()).not.toContain('Approve');
    const pass = row()!.querySelector<HTMLButtonElement>('[data-slot="gate-pass"]')!;
    await act(async () => { pass.click(); });
    await vi.waitFor(() => expect(posts).toContain('/ui/api/jobs/g1/gate-pass'));
  });

  it('an operator sees why, and no button the server would refuse', async () => {
    await boot('operator');
    await vi.waitFor(() => expect(row()?.textContent).toContain(HOLD));
    expect(buttons()).not.toContain('Let through');
    expect(buttons()).not.toContain('Approve');
  });
});
