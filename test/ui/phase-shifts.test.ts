// @vitest-environment happy-dom
// Phase shifts from a question (issue #548), rendered inside the whole app against a fake of the daemon's HTTP surface.
// The question card offers Research this and Propose this — only the modes the server says it takes, the default
// first, with a note scoping the aspect —, or says why it offers none; a suggestion by the job or a level is one click.
// A job's phase shows wherever the job is named. In Research and Proposals, an item written in a switched phase asks
// at Accept what the job does next, and an item shows where it came from. An admin sets the phase-shift settings.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Job } from '../../src/domain/types.ts';

const at = '2026-10-09T08:00:00.000Z';
const job = (id: string, o: Partial<Job> = {}): Job => ({
  id, spec: { executor: 'herdr-claude', payload: { prompt: `Task ${id}` }, goal: `goal ${id}` }, priority: 50, status: 'waiting_answer', approved: false, attempts: 1,
  createdAt: at, updatedAt: at, phase: 'work', questionId: `q-${id}`, ...o,
} as Job);
const question = (jobId: string, o: Record<string, unknown> = {}) => ({
  id: `q-${jobId}`, jobId, text: `Question of ${jobId}`, recentOutput: 'line', detectedBy: 'marker', status: 'open', tier: 'human', attempts: [], notifyCount: 1,
  createdAt: at, updatedAt: at, priority: 50, high: false, shifts: { modes: ['fork', 'switch'], defaultMode: 'fork' }, ...o,
});
const report = (jobId: string, o: Record<string, unknown> = {}) => ({
  id: `r-${jobId}`, kind: 'research', jobId, status: 'open', stage: 'human', levelRevisions: 0, priority: 50, high: false, createdAt: at, updatedAt: at,
  versions: [{ number: 1, text: 'Findings: x', recentOutput: '', at, missing: [], sections: { findings: 'oil lasts longest' } }], reviews: [], ...o,
});
const RESEARCH_TYPE = {
  parts: [['findings', 'Findings']],
  decisions: [
    { id: 'accept', route: 'accept', label: 'Accept', effect: 'accept', notes: 'optional' },
    { id: 'dig_deeper', route: 'dig-deeper', label: 'Dig deeper', effect: 'send_back', notes: 'optional' },
  ],
};
const PHASE_SETTINGS = { defaultMode: 'fork', forkParent: 'wait', levels: [], choices: { levels: ['opus', 'fable'] } };

interface Daemon { jobs?: Job[]; questions?: unknown[]; reports?: unknown[]; role?: 'operator' | 'admin' }

function fakeDaemon(d: Daemon) {
  const posts: { path: string; body: unknown }[] = [];
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: ['herdr-claude'], parkingExecutors: ['herdr-claude'], reviewingExecutors: ['herdr-claude'], uptimeS: 1 },
    '/api/queue': { waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: d.jobs ?? [], ended: [], locked: [] },
    '/api/machines': { machines: [] }, '/api/decisions': { decisions: [] }, '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] }, '/api/sources': { sources: [] },
    '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }, '/api/accounts': { accounts: [] },
    '/api/questions': { questions: d.questions ?? [] },
    '/api/research': { items: d.reports ?? [], settings: { reviewers: [], signOff: 'owner', levelRevisions: 1, levels: [] }, type: RESEARCH_TYPE },
    '/api/phase-shifts': PHASE_SETTINGS,
  };
  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = String(input).split('?')[0]!;
    if (path === '/ui/api/session') {
      return json({ authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: d.role ?? 'operator', realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
    }
    if (path.startsWith('/ui/api/')) {
      posts.push({ path, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (path === '/ui/api/phase-shifts') return json({ ...PHASE_SETTINGS, ...(JSON.parse(String(init.body)) as object) });
      return json({});
    }
    return path in routes ? json(routes[path]) : new Response('{"error":"not found"}', { status: 404 });
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

async function boot(hash: string, d: Daemon) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = hash;
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  const daemon = fakeDaemon(d);
  vi.stubGlobal('fetch', daemon.fetch);
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
  return daemon;
}

const card = (text: string) => [...document.querySelectorAll('[data-slot="card"]')].find((c) => c.textContent?.includes(text)) ?? null;
const button = (label: string, within: ParentNode) => [...within.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
const click = (b: HTMLElement | null | undefined) => act(async () => { b!.click(); });
const type = (el: HTMLTextAreaElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('Research this and Propose this on the question card', () => {
  it('offers both, the default mode chosen; a note scopes the aspect, and Switch moves the whole job', async () => {
    const daemon = await boot('#questions', { jobs: [job('j1')], questions: [question('j1')] });
    const c = await vi.waitFor(() => { const x = card('Question of j1'); expect(x && button('Research this', x)).toBeDefined(); return x!; });
    expect(button('Propose this', c)).toBeDefined();
    await click(button('Research this', c));
    const form = c.querySelector<HTMLElement>('[data-slot="shift-form"]')!;
    expect(form.querySelector<HTMLInputElement>('input[value="fork"]')!.checked).toBe(true);
    await type(form.querySelector('textarea')!, 'research only the auth part');
    await click(form.querySelector<HTMLInputElement>('input[value="switch"]'));
    await click(button('Research', form));
    await vi.waitFor(() => expect(daemon.posts.find((p) => p.path === '/ui/api/questions/q-j1/research')?.body).toEqual({ mode: 'switch', note: 'research only the auth part' }));
  });

  it('a question whose job cannot shift says why, instead of the buttons', async () => {
    await boot('#questions', { jobs: [job('j2')], questions: [question('j2', { shifts: { modes: [], defaultMode: 'fork', refusal: 'its executor test cannot write a research report or a proposal' } })] });
    const c = await vi.waitFor(() => { const x = card('Question of j2'); expect(x?.querySelector('[data-slot="shift-refusal"]')).not.toBeNull(); return x!; });
    expect(button('Research this', c)).toBeUndefined();
    expect(c.querySelector('[data-slot="shift-refusal"]')!.textContent).toContain('cannot write a research report');
  });

  it('a suggestion by the job is one click, in the default mode', async () => {
    const daemon = await boot('#questions', { jobs: [job('j3')], questions: [question('j3', { suggestion: { to: 'research', note: 'the cache eviction options', by: 'job' } })] });
    const s = await vi.waitFor(() => { const x = card('Question of j3')?.querySelector<HTMLElement>('[data-slot="suggestion"]'); expect(x).toBeTruthy(); return x!; });
    expect(s.textContent).toContain('the job suggests');
    await click(s.querySelector('button'));
    await vi.waitFor(() => expect(daemon.posts.find((p) => p.path === '/ui/api/questions/q-j3/research')?.body).toEqual({ note: 'the cache eviction options' }));
  });
});

describe('a job\'s phase', () => {
  it('shows wherever the job is named, unless it is doing the work', async () => {
    await boot('#questions', { jobs: [job('j4', { phase: 'research' }), job('j5')], questions: [question('j4'), question('j5')] });
    await vi.waitFor(() => expect(card('Question of j4')?.querySelector('[data-phase="research"]')).not.toBeNull());
    expect(card('Question of j5')?.querySelector('[data-phase]')).toBeNull();
  });
});

describe('Research: an item of a switched phase, and a fork', () => {
  it('Accept asks what the job does next: back to work by default, or end, or on to a proposal', async () => {
    const daemon = await boot('#research', {
      jobs: [job('j6', { phase: 'research', researchId: 'r-j6', shift: { to: 'research', questionId: 'q-j6', by: 'owner', at } })],
      reports: [report('j6', { then: ['work', 'end', 'proposal'], switchedFrom: { jobId: 'j6', questionId: 'q-j6' } })],
    });
    const c = await vi.waitFor(() => { const x = document.querySelector<HTMLElement>('[data-item="r-j6"]'); expect(x?.querySelector('[data-slot="then"]')).toBeTruthy(); return x!; });
    expect(c.querySelector('[data-slot="origin"]')!.textContent).toMatch(/switched from its question/i);
    const then = c.querySelector<HTMLElement>('[data-slot="then"]')!;
    expect(then.querySelector<HTMLInputElement>('input[value="work"]')!.checked).toBe(true);
    await click(then.querySelector<HTMLInputElement>('input[value="end"]'));
    await click(button('Accept', c));
    await vi.waitFor(() => expect(daemon.posts.find((p) => p.path === '/ui/api/research/r-j6/accept')?.body).toEqual({ then: 'end' }));
  });

  it('a fork\'s item names the job and question it came from, and Accept asks nothing more', async () => {
    const daemon = await boot('#research', { jobs: [job('j7'), job('j8', { forkOf: { jobId: 'j7', questionId: 'q-j7', kind: 'research', question: 'Which?' }, phase: 'research', researchId: 'r-j8' })], reports: [report('j8', { forkOf: { jobId: 'j7', questionId: 'q-j7' } })] });
    const c = await vi.waitFor(() => { const x = document.querySelector<HTMLElement>('[data-item="r-j8"]'); expect(x?.querySelector('[data-slot="origin"]')).toBeTruthy(); return x!; });
    expect(c.querySelector('[data-slot="origin"]')!.textContent).toContain('goal j7');
    expect(c.querySelector('[data-slot="then"]')).toBeNull();
    await click(button('Accept', c));
    await vi.waitFor(() => expect(daemon.posts.find((p) => p.path === '/ui/api/research/r-j8/accept')?.body).toEqual({}));
  });
});

describe('the phase-shift settings', () => {
  it('an admin sets the default mode, what a parent does while its fork runs, and the levels that may shift', async () => {
    const daemon = await boot('#questions', { role: 'admin' });
    const panel = await vi.waitFor(() => { const x = document.querySelector<HTMLElement>('[data-slot="phase-shift-settings"]'); expect(x).toBeTruthy(); return x!; });
    await click(panel.querySelector<HTMLInputElement>('input[name="defaultMode"][value="switch"]'));
    await click(panel.querySelector<HTMLInputElement>('input[name="forkParent"][value="park"]'));
    await click(panel.querySelector<HTMLInputElement>('input[name="level"][value="opus"]'));
    await click(button('Save', panel));
    await vi.waitFor(() => expect(daemon.posts.find((p) => p.path === '/ui/api/phase-shifts')?.body).toEqual({ defaultMode: 'switch', forkParent: 'park', levels: ['opus'] }));
  });

  it('an operator does not see them', async () => {
    await boot('#questions', { jobs: [job('j9')], questions: [question('j9')] });
    await vi.waitFor(() => expect(card('Question of j9')).not.toBeNull());
    expect(document.querySelector('[data-slot="phase-shift-settings"]')).toBeNull();
  });
});
