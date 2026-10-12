// @vitest-environment happy-dom
// Issue #432: every lane card shows the repo and issue of the job on it, as owner/repo#number linked to the issue,
// while the job starts, runs or waits; an idle lane says idle.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Job, JobStatus, Lane } from '../../src/domain/types.ts';

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const pointed = (id: string, status: JobStatus, repo: string, number: number, laneId: string): Job => ({
  id, spec: { executor: 'test', payload: {}, goal: `goal ${id}` }, priority: 50, status, approved: false, laneId,
  createdAt: minutesAgo(30), updatedAt: minutesAgo(1), attempts: 1, startedAt: minutesAgo(5),
  source: { source: 'github', kind: 'issue', key: `https://github.com/${repo}/issues/${number}`, url: `https://github.com/${repo}/issues/${number}`, repo, number },
} as Job);

const jobs = [
  pointed('starting', 'claimed', 'acme/widgets', 7, 'm1/lane-1'),
  pointed('busy', 'running', 'other-org/tools', 42, 'm1/lane-2'),
  pointed('waiting', 'waiting_answer', 'acme/widgets', 9, 'm1/lane-3'),
  pointed('closing', 'running', 'acme/site', 3, 'm1/lane-4'),
];
const lane = (n: number, state: Lane['state'], jobId?: string): Lane => ({ id: `m1/lane-${n}`, machineId: 'm1', state, ...(jobId ? { jobId } : {}), openedAt: minutesAgo(5) });

function fakeDaemon() {
  const of = (...s: JobStatus[]) => jobs.filter((j) => s.includes(j.status));
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': { waiting: [], running: of('claimed', 'running'), operatorLed: [], parked: [], waitingAnswer: of('waiting_answer'), ended: [], locked: [] },
    '/api/machines': { machines: [{ id: 'm1', label: 'm1', maxLanes: 6, online: true, executors: ['test'], usage: [], lanes: [
      lane(1, 'busy', 'starting'), lane(2, 'busy', 'busy'), lane(3, 'busy', 'waiting'), lane(4, 'draining', 'closing'), lane(5, 'idle'),
    ] }] },
    '/api/decisions': { decisions: [] }, '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] },
    '/api/questions': { questions: [] }, '/api/sources': { sources: [] },
    '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }, '/api/accounts': { accounts: [] },
  };
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  return vi.fn(async (input: string) => {
    const path = String(input).split('?')[0]!;
    if (path === '/ui/api/session') return json({ authenticated: true, user: { role: 'viewer', realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
    return path in routes ? json(routes[path]) : new Response('{"error":"not found"}', { status: 404 });
  });
}

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(): void {}
  close(): void {}
}

let root: Root | undefined;

async function boot() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = '#overview';
  localStorage.clear();
  vi.stubGlobal('fetch', fakeDaemon());
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
  await vi.waitFor(() => expect(document.querySelector('[data-lane-job="waiting"]')).not.toBeNull());
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

const card = (jobId: string) => document.querySelector<HTMLElement>(`[data-lane-job="${jobId}"]`)!;
const target = (jobId: string) => card(jobId).querySelector<HTMLAnchorElement>('[data-slot="lane-target"] a');
const badge = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-slot="status-badge"]')!;

describe('Lane surface (issue #432)', () => {
  it.each([
    ['starting', 'starting', 'acme/widgets#7'],
    ['busy', 'busy', 'other-org/tools#42'],
    ['waiting', 'waiting', 'acme/widgets#9'],
    ['closing', 'busy', 'acme/site#3'],
  ])('a lane with a %s job says %s and shows owner/repo#number linked to the issue', async (jobId, state, ref) => {
    await boot();
    expect(badge(card(jobId)).textContent).toBe(state);
    expect(badge(card(jobId)).title).not.toBe('');
    const link = target(jobId);
    expect(link?.textContent).toBe(ref);
    const [repo, number] = ref.split('#');
    expect(link?.getAttribute('href')).toBe(`https://github.com/${repo}/issues/${number}`);
  });

  it('an idle lane says idle and shows no repo or issue', async () => {
    await boot();
    const idle = [...document.querySelectorAll<HTMLElement>('[data-lane-state="idle"]')];
    expect(idle).toHaveLength(1);
    const idleCard = idle[0]!;
    expect(badge(idleCard).textContent).toBe('idle');
    expect(idleCard.querySelector('[data-lane-idle]')?.textContent).toBe('idle');
    expect(idleCard.querySelector('[data-slot="lane-target"]')).toBeNull();
  });
});
