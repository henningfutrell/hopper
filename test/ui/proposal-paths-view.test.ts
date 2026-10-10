// @vitest-environment happy-dom
// Issue #651, the UI: a proposal card shows its problem statement, then each path as its own sub-card — title, TL;DR,
// tradeoff badges, a recommended badge — that expands to its full Markdown, sanitized. A person checks one or more
// paths, adds a note to each, and continues with them; or asks for more paths, steers or rejects all. Zero paths: the
// reason, and only accept, steer and ask for paths. After the selection, each selected path links to its follow-on job
// with its live state, and the paths not selected are greyed out and kept (test 6). Rendered inside the whole app
// against a fake of the daemon's HTTP surface.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const T0 = '2026-10-10T12:00:00.000Z';
const job = (id: string, over: Record<string, unknown> = {}) => ({
  id, status: 'waiting_answer', priority: 50, attempts: 1, createdAt: T0, updatedAt: T0, proposalId: `p-${id}`,
  spec: { executor: 'herdr-claude', payload: { prompt: 'Paint the shed' }, goal: `shed ${id}` }, ...over,
});
const path = (id: string, title: string, over: Record<string, unknown> = {}) => ({
  id, title, summary: `${title}: the short of it.`, creates: 'one job',
  tradeoffs: { security: 'no change', effort: 'one afternoon', risk: 'rain', friction: 'buys paint' },
  text: `Summary: ${title}\n\nThe brush reaches the **corners**.\n\n<script>window.hacked = 1</script><img src="x" onerror="window.hacked = 2">`, ...over,
});
const PATHS = { paths: [path('1', 'Brush two coats', { recommended: true }), path('2', 'Spray gun'), path('3', 'Leave it bare', { recommended: true })], recommendation: 'the brush is cheap' };
const proposal = (id: string, over: Record<string, unknown> = {}) => ({
  id: `p-${id}`, jobId: id, status: 'open', stage: 'human', levelRevisions: 0, priority: 50, high: false, createdAt: T0, updatedAt: T0,
  versions: [{
    number: 1, text: 'TL;DR: paint it', recentOutput: '', at: T0, missing: [],
    sections: { tldr: 'Paint the shed with a brush.', problem: 'The shed is bare wood.', recommended: '1 and 3 — the brush is cheap', context: 'the shed' },
    paths: PATHS,
  }],
  reviews: [],
  ...over,
});
const SETTINGS = { reviewers: [], signOff: 'owner', levelRevisions: 1, levels: [] };
const TYPE = {
  parts: [['tldr', 'TL;DR'], ['problem', 'Problem'], ['paths', 'Paths'], ['recommended', 'Recommended'], ['context', 'Context']],
  decisions: [
    { id: 'accept', route: 'accept', label: 'Continue with selected', effect: 'accept', notes: 'optional' },
    { id: 'more_paths', route: 'more-paths', label: 'Ask for more paths', effect: 'send_back', notes: 'optional' },
    { id: 'steer', route: 'steer', label: 'Steer', effect: 'send_back', notes: 'required' },
    { id: 'reject', route: 'reject', label: 'Reject all', effect: 'reject', notes: 'required' },
  ],
};

interface Daemon { proposals: Record<string, unknown>[]; jobs: Record<string, unknown>[] }

function fakeDaemon(d: Daemon) {
  const posts: { path: string; body: unknown }[] = [];
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/machines': { machines: [] }, '/api/decisions': { decisions: [] }, '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] }, '/api/sources': { sources: [] },
    '/api/questions': { questions: [] }, '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }, '/api/accounts': { accounts: [] },
  };
  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const [p, query = ''] = String(input).split('?') as [string, string?];
    if (p === '/ui/api/session') return json(200, { authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: 'operator', realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
    if (p === '/api/queue') {
      const waiting = d.jobs.filter((j) => j.status === 'waiting_answer');
      const ended = d.jobs.filter((j) => j.status === 'finished');
      const running = d.jobs.filter((j) => j.status === 'running');
      return json(200, { waiting: [], running, operatorLed: [], parked: [], waitingAnswer: waiting, ended, locked: [] });
    }
    if (p === '/api/proposals') {
      const open = !query.includes('status=all');
      return json(200, { items: open ? d.proposals.filter((x) => x.status === 'open' || x.status === 'revising') : d.proposals, settings: SETTINGS, type: TYPE });
    }
    if (p.startsWith('/ui/api/')) {
      posts.push({ path: p, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return json(200, d.proposals[0]);
    }
    return json(200, routes[p] ?? {});
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

async function boot(d: Daemon) {
  window.location.hash = '#proposals';
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
  await settle();
}

async function settle() {
  for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const card = (id: string) => document.querySelector(`[data-item="p-${id}"]`) as HTMLElement;
const pathCard = (within: Element, id: string) => within.querySelector(`[data-path="${id}"]`) as HTMLElement;
const buttons = (within: Element) => [...within.querySelectorAll('button')].map((b) => b.textContent?.trim() ?? '');
const button = (within: Element, text: string) => [...within.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined;
async function type(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  await act(async () => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); });
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('a proposal card with paths', () => {
  it('shows the problem, then each path as a sub-card: title, TL;DR, tradeoff badges, recommended badge', async () => {
    await boot({ proposals: [proposal('j1')], jobs: [job('j1')] });
    const c = card('j1');
    expect(c.querySelector('[data-slot="problem"]')!.textContent).toContain('The shed is bare wood.');
    expect(c.querySelector('[data-slot="tldr"]')!.textContent).toContain('Paint the shed with a brush.');
    const one = pathCard(c, '1');
    expect(one.textContent).toContain('Brush two coats');
    expect(one.textContent).toContain('Brush two coats: the short of it.');
    expect([...one.querySelectorAll('[data-tradeoff]')].map((b) => b.getAttribute('data-tradeoff'))).toEqual(['security', 'effort', 'risk', 'friction']);
    expect(one.querySelector('[data-slot="recommended"]')).not.toBeNull();
    expect(pathCard(c, '2').querySelector('[data-slot="recommended"]')).toBeNull();
    expect(c.querySelector('[data-slot="recommendation"]')!.textContent).toContain('the brush is cheap');
  });

  it('a path expands to its full Markdown, with no raw HTML or script', async () => {
    await boot({ proposals: [proposal('j1')], jobs: [job('j1')] });
    const one = pathCard(card('j1'), '1');
    await act(async () => { button(one, 'Details')!.click(); });
    const md = one.querySelector('[data-slot="path-text"]')!;
    expect(md.querySelector('strong')!.textContent).toBe('corners');
    expect(md.querySelector('script')).toBeNull();
    expect(md.querySelector('img')).toBeNull();
    expect((window as { hacked?: number }).hacked).toBeUndefined();
  });

  it('test 6: select two paths with a note, and Continue with selected sends them', async () => {
    await boot({ proposals: [proposal('j1')], jobs: [job('j1')] });
    const c = card('j1');
    expect(button(c, 'Continue with selected')!.disabled).toBe(true);
    expect(button(c, 'Steer')!.disabled).toBe(true);
    expect(button(c, 'Reject all')!.disabled).toBe(true);
    await act(async () => { (pathCard(c, '1').querySelector('input[type="checkbox"]') as HTMLInputElement).click(); });
    await act(async () => { (pathCard(c, '3').querySelector('input[type="checkbox"]') as HTMLInputElement).click(); });
    await type(pathCard(card('j1'), '1').querySelector('[data-slot="path-note"]') as HTMLInputElement, 'oil paint');
    expect(pathCard(card('j1'), '2').querySelector('[data-slot="path-note"]')).toBeNull();
    await act(async () => { button(card('j1'), 'Continue with selected')!.click(); });
    await settle();
    expect(daemon.posts).toContainEqual({ path: '/ui/api/proposals/p-j1/accept', body: { paths: [{ id: '1', note: 'oil paint' }, { id: '3' }] } });
  });

  it('Ask for more paths sends the selection along, so it is kept', async () => {
    await boot({ proposals: [proposal('j1')], jobs: [job('j1')] });
    await act(async () => { (pathCard(card('j1'), '2').querySelector('input[type="checkbox"]') as HTMLInputElement).click(); });
    await act(async () => { button(card('j1'), 'Ask for more paths')!.click(); });
    await settle();
    expect(daemon.posts).toContainEqual({ path: '/ui/api/proposals/p-j1/more-paths', body: { paths: [{ id: '2' }] } });
  });

  it('the selection kept from before is checked again', async () => {
    await boot({ proposals: [proposal('j1', { selection: { version: 1, paths: [{ id: '3', note: 'next year' }] } })], jobs: [job('j1')] });
    const three = pathCard(card('j1'), '3');
    expect((three.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true);
    expect((three.querySelector('[data-slot="path-note"]') as HTMLInputElement).value).toBe('next year');
  });

  it('a path a reviewer level found not viable cannot be checked, and says why; one it added says so', async () => {
    const paths = { paths: [path('1', 'Brush'), path('2', 'Spray', { notViable: { by: 'fable', why: 'no gun nearby' } }), path('4', 'Stain', { addedBy: 'fable' })] };
    await boot({ proposals: [proposal('j1', { versions: [{ ...proposal('j1').versions[0], paths }] })], jobs: [job('j1')] });
    const two = pathCard(card('j1'), '2');
    expect((two.querySelector('input[type="checkbox"]') as HTMLInputElement).disabled).toBe(true);
    expect(two.textContent).toContain('no gun nearby');
    expect(pathCard(card('j1'), '4').textContent).toContain('added by fable');
  });
});

describe('a proposal card with zero paths', () => {
  it('test 2: shows the reason, with only Accept, Ask for more paths and Steer', async () => {
    const none = { paths: [], none: 'the shed was painted last year.' };
    await boot({ proposals: [proposal('j1', { versions: [{ ...proposal('j1').versions[0], paths: none }] })], jobs: [job('j1')] });
    const c = card('j1');
    expect(c.querySelector('[data-slot="no-paths"]')!.textContent).toContain('the shed was painted last year.');
    expect(c.querySelector('[data-path]')).toBeNull();
    const shown = buttons(c).filter((b) => ['Accept', 'Ask for more paths', 'Steer', 'Reject all', 'Continue with selected'].includes(b));
    expect(shown).toEqual(['Accept', 'Ask for more paths', 'Steer']);
    await act(async () => { button(c, 'Accept')!.click(); });
    await settle();
    expect(daemon.posts).toContainEqual({ path: '/ui/api/proposals/p-j1/accept', body: {} });
  });
});

describe('after the selection', () => {
  it('test 6: each selected path links to its follow-on and shows its live state; the others are greyed out and kept', async () => {
    const accepted = proposal('j1', {
      status: 'accepted',
      signOff: { decision: 'accept', stage: 'human', by: 'login code', at: T0, version: 1, selected: [{ id: '1', title: 'Brush two coats', note: 'oil paint', jobId: 'f1' }, { id: '3', title: 'Leave it bare', jobId: 'f3' }] },
      followOns: [{ pathId: '1', jobId: 'f1', jobStatus: 'queued' }, { pathId: '3', jobId: 'f3', jobStatus: 'queued' }],
    });
    await boot({ proposals: [accepted], jobs: [job('j1', { status: 'finished' }), job('f1', { status: 'running', proposalId: undefined }), job('f3', { status: 'finished', proposalId: undefined })] });
    const list = document.querySelector('[data-earlier-item="p-j1"]') as HTMLElement;
    const follow = list.querySelector('[data-slot="follow-ons"]')!;
    const rows = [...follow.querySelectorAll('[data-path]')] as HTMLElement[];
    expect(rows.map((r) => [r.getAttribute('data-path'), r.getAttribute('data-selected')])).toEqual([['1', 'true'], ['2', 'false'], ['3', 'true']]);
    expect(rows[0]!.querySelector('a[href="#queue"]')!.textContent).toContain('f1');
    expect(rows[0]!.querySelector('[data-slot="follow-on-status"]')!.textContent).toBe('running');
    expect(rows[2]!.querySelector('[data-slot="follow-on-status"]')!.textContent).toBe('finished');
    expect(rows[0]!.textContent).toContain('oil paint');
    expect(rows[1]!.className).toContain('opacity');
  });
});
