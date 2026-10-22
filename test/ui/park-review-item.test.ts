// @vitest-environment happy-dom
// Park on a proposal (issue #2167), rendered inside the whole app against a fake of the daemon's HTTP surface: the card
// offers Park, which asks first and takes an optional reason. A parked proposal is out of the list, in the folded Parked
// group below it, with who parked it and why, and Pick up; the Parked view says what its job waits on.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const T0 = '2026-10-09T12:00:00.000Z';
const job = (id: string, over: Record<string, unknown> = {}) => ({
  id, status: 'waiting_answer', priority: 50, attempts: 1, createdAt: T0, updatedAt: T0, proposalId: `p-${id}`, agentSession: 's',
  spec: { executor: 'herdr-claude', payload: { prompt: 'Paint the shed' }, goal: `shed ${id}` }, ...over,
});
const proposal = (id: string, over: Record<string, unknown> = {}) => ({
  id: `p-${id}`, jobId: id, status: 'open', stage: 'human', levelRevisions: 0, priority: 50, high: false, createdAt: T0, updatedAt: T0,
  versions: [{ number: 1, text: 'TL;DR: paint the shed', recentOutput: '', at: T0, missing: [], sections: { tldr: 'paint the shed' }, paths: { paths: [] } }],
  reviews: [], ...over,
});
const SETTINGS = { reviewers: [], signOff: 'owner', levelRevisions: 1, autoContinue: false, levels: [] };
const TYPE = {
  parts: [['tldr', 'TL;DR'], ['problem', 'Problem'], ['paths', 'Paths'], ['recommended', 'Recommended'], ['context', 'Context']],
  decisions: [{ id: 'accept', route: 'accept', label: 'Continue with selected', effect: 'accept', notes: 'optional' }],
};
const PARK = { at: T0, by: 'a person', via: 'ui', reason: 'Wait for the spring.' };

interface Daemon { open: Record<string, unknown>[]; parked: Record<string, unknown>[]; waiting: Record<string, unknown>[]; parkedJobs: Record<string, unknown>[] }

function fakeDaemon(d: Daemon) {
  const posts: { path: string; body: unknown }[] = [];
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: ['herdr-claude'], parkingExecutors: ['herdr-claude'], uptimeS: 1 },
    '/api/queue': { waiting: [], running: [], operatorLed: [], parked: d.parkedJobs, waitingAnswer: d.waiting, ended: [], locked: [] },
    '/api/machines': { machines: [] }, '/api/decisions': { decisions: [] }, '/api/events': { events: [] }, '/api/webhooks': { subscriptions: [] },
    '/api/webhooks/deliveries': { deliveries: [] }, '/api/sources': { sources: [] }, '/api/questions': { questions: [] },
    '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }, '/api/accounts': { accounts: [] },
  };
  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const [path, query = ''] = String(input).split('?') as [string, string?];
    if (path === '/ui/api/session') return json({ authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: 'operator', realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
    if (path === '/api/proposals') {
      const items = query.includes('status=parked') ? d.parked : query.includes('status=all') ? [...d.open, ...d.parked] : d.open;
      return json({ items, settings: SETTINGS, type: TYPE });
    }
    if (path.startsWith('/ui/api/')) {
      posts.push({ path, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return json({});
    }
    return json(routes[path] ?? {});
  });
  return { fetch, posts };
}

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(): void {}
  close(): void {}
}

let root: Root | undefined;
let daemon: ReturnType<typeof fakeDaemon>;

async function boot(hash: string, d: Daemon) {
  window.location.hash = hash;
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  daemon = fakeDaemon(d);
  vi.stubGlobal('fetch', daemon.fetch);
  vi.stubGlobal('EventSource', FakeEventSource);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const mod = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(mod.App)); });
  for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const button = (within: ParentNode, text: string) => [...within.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
const click = (b: HTMLElement | undefined) => act(async () => { b!.click(); });
const dialog = () => vi.waitFor(() => { const x = document.querySelector('[role="alertdialog"]'); expect(x).not.toBeNull(); return x!; });

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('Park on a proposal (issue #2167)', () => {
  it('the card offers Park; it asks first, takes a reason, and parks the job', async () => {
    await boot('#proposals', { open: [proposal('j1')], parked: [], waiting: [job('j1')], parkedJobs: [] });
    const c = await vi.waitFor(() => { const x = document.querySelector<HTMLElement>('[data-item="p-j1"]'); expect(x && button(x, 'Park')).toBeDefined(); return x!; });
    await click(button(c, 'Park'));
    const d = await dialog();
    expect(d.textContent).toContain('its proposal leaves Proposals');
    const input = d.querySelector<HTMLInputElement>('[data-park-reason]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(input, '  Wait for the spring.  '); input.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(daemon.posts.some((x) => x.path.endsWith('/park'))).toBe(false);
    await click(button(d, 'Park job'));
    await vi.waitFor(() => expect(daemon.posts).toContainEqual({ path: '/ui/api/jobs/j1/park', body: { reason: 'Wait for the spring.' } }));
  });

  it('a parked proposal is out of the list, in the folded Parked group with who parked it and why, and Pick up', async () => {
    const parkedJob = job('j2', { status: 'parked', resumeOn: 'local', parked: { ...PARK, from: 'waiting_answer' } });
    await boot('#proposals', { open: [], parked: [proposal('j2', { parked: PARK })], waiting: [], parkedJobs: [parkedJob] });
    expect(document.querySelector('[data-item="p-j2"]')).toBeNull();
    expect(document.body.textContent).toContain('no open proposals');
    const group = await vi.waitFor(() => { const x = document.querySelector<HTMLElement>('[data-slot="parked-items"]'); expect(x).not.toBeNull(); return x!; });
    expect(group.textContent).toContain('Parked (1)');
    await click(group.querySelector('button')!);
    const row = await vi.waitFor(() => { const x = document.querySelector<HTMLElement>('[data-parked-item="p-j2"]'); expect(x).not.toBeNull(); return x!; });
    expect(row.textContent).toContain('paint the shed');
    expect(row.querySelector('[data-slot="parked-by"]')!.textContent).toBe('parked by a person: Wait for the spring.');
    await click(button(row, 'Pick up'));
    await vi.waitFor(() => expect(daemon.posts).toContainEqual({ path: '/ui/api/jobs/j2/requeue', body: {} }));
  });

  it('the Parked view says what the job waits on, and who parked it and why', async () => {
    const parkedJob = job('j3', { status: 'parked', resumeOn: 'local', parked: { ...PARK, from: 'waiting_answer' } });
    await boot('#parked', { open: [], parked: [proposal('j3', { parked: PARK })], waiting: [], parkedJobs: [parkedJob] });
    const row = await vi.waitFor(() => { const x = document.querySelector<HTMLElement>('[data-parked-job="j3"] [data-slot="item-line"]'); expect(x).not.toBeNull(); return x!.closest<HTMLElement>('[data-parked-job]')!; });
    expect(row.querySelector('[data-slot="item-line"]')!.textContent).toBe('waits on its proposal: paint the shed');
    expect(row.querySelector('[data-slot="parked-by"]')!.textContent).toBe('parked by a person: Wait for the spring.');
  });

  it('auto-parked on its proposal, it has no Pick up: Decide opens its card, and a link opens Proposals (issue #2415)', async () => {
    const parkedJob = job('j4', { status: 'parked', resumeOn: 'local', parked: { at: T0, from: 'waiting_answer', auto: true, why: 'Parked automatically.' } });
    await boot('#parked', { open: [proposal('j4')], parked: [], waiting: [], parkedJobs: [parkedJob] });
    const row = await vi.waitFor(() => { const x = document.querySelector<HTMLElement>('[data-parked-job="j4"] [data-slot="waits-on"]'); expect(x).not.toBeNull(); return x!.closest<HTMLElement>('[data-parked-job]')!; });
    expect(button(row, 'Pick up')).toBeUndefined();
    const waits = row.querySelector('[data-slot="waits-on"]')!;
    expect(waits.textContent).toContain('Waits on a person for its proposal: a decision on it picks it up. Pick up would only park it again.');
    expect(waits.querySelector('a')!.getAttribute('href')).toBe('#proposals');
    expect(row.querySelector('[data-slot="item-card"]')).toBeNull();
    await click(button(waits, 'Decide'));
    expect(row.querySelector('[data-slot="item-card"]')!.textContent).toContain('For you');
  });
});
