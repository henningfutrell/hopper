// @vitest-environment happy-dom
// The Proposals view (issue #537), rendered inside the whole app against a fake of the daemon's HTTP surface. A
// proposal waiting on a person shows its parts, the parts it left out, its review trail and its job; the nav badge
// counts the ones waiting on a person, high-priority ones marked and first, and never the questions. An operator
// continues with selected paths, steers or rejects all (the last two only with a reason, issue #651); a viewer sees a notice. An admin's settings
// offer only the escalation levels the server names.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const T0 = '2026-10-09T12:00:00.000Z';
const job = (id: string, priority = 50) => ({
  id, status: 'waiting_answer', priority, attempts: 1, createdAt: T0, updatedAt: T0, proposalId: `p-${id}`,
  spec: { executor: 'herdr-claude', payload: { prompt: 'Paint the shed' }, goal: `shed ${id}` },
});
const proposal = (id: string, over: Record<string, unknown> = {}) => ({
  id: `p-${id}`, jobId: id, status: 'open', stage: 'human', levelRevisions: 0, priority: 50, high: false, createdAt: T0, updatedAt: T0,
  versions: [{
    number: 1, text: 'TL;DR: paint the shed', recentOutput: '', at: T0, missing: ['context'],
    sections: { tldr: 'paint the shed', problem: 'the shed is bare wood' },
    paths: { paths: [{ id: '1', title: 'two coats with a brush', summary: 'a brush', tradeoffs: { risk: 'rain' }, text: 'a brush', recommended: true }, { id: '2', title: 'a spray gun', tradeoffs: {}, text: 'spray' }] },
  }],
  reviews: [{ version: 1, stage: 'opus', role: 'level', verdict: 'approve', notes: 'sound and small', startedAt: T0, finishedAt: T0 }],
  ...over,
});
const SETTINGS = { reviewers: ['opus'], signOff: 'owner', levelRevisions: 1, levels: ['opus', 'fable'] };
// The section type as the server declares it (issue #543): the UI offers exactly these parts and decisions.
const TYPE = {
  parts: [['tldr', 'TL;DR'], ['problem', 'Problem'], ['paths', 'Paths'], ['recommended', 'Recommended'], ['context', 'Context']],
  decisions: [
    { id: 'accept', route: 'accept', label: 'Continue with selected', effect: 'accept', notes: 'optional' },
    { id: 'more_paths', route: 'more-paths', label: 'Ask for more paths', effect: 'send_back', notes: 'optional' },
    { id: 'steer', route: 'steer', label: 'Steer', effect: 'send_back', notes: 'required' },
    { id: 'reject', route: 'reject', label: 'Reject all', effect: 'reject', notes: 'required' },
  ],
};

type Role = 'viewer' | 'operator' | 'admin';
interface Daemon { proposals: Record<string, unknown>[]; jobs: Record<string, unknown>[]; role?: Role }

function fakeDaemon(d: Daemon) {
  const posts: { path: string; body: unknown }[] = [];
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': { waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: d.jobs, ended: [], locked: [] },
    '/api/machines': { machines: [] },
    '/api/decisions': { decisions: [] },
    '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] },
    '/api/webhooks/deliveries': { deliveries: [] },
    '/api/sources': { sources: [] },
    '/api/questions': { questions: [] },
    '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] },
    '/api/accounts': { accounts: [] },
  };
  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const [path, query = ''] = String(input).split('?') as [string, string?];
    if (path === '/ui/api/session') return json(200, { authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: d.role ?? 'operator', realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
    if (path === '/api/proposals') {
      const open = !query.includes('status=all');
      return json(200, { items: open ? d.proposals.filter((p) => p.status === 'open' || p.status === 'revising') : d.proposals, settings: SETTINGS, type: TYPE });
    }
    if (path.startsWith('/ui/api/')) {
      posts.push({ path, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (path === '/ui/api/proposals/settings') return json(200, { ...SETTINGS, ...(JSON.parse(String(init.body)) as object) });
      return json(200, d.proposals[0]);
    }
    return json(200, routes[path] ?? {});
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
  await settle();
}

async function settle() {
  for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const card = (id: string) => document.querySelector(`[data-item="p-${id}"]`) as HTMLElement | null;
const navBadge = () => document.querySelector('a[href="#proposals"] [data-slot="nav-badge"]');
const button = (within: Element, text: string) => [...within.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined;
async function type(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); });
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('the Proposals view', () => {
  it('shows a proposal waiting on a person: its problem, its paths, its trail and its job; the badge counts it', async () => {
    await boot('#proposals', { proposals: [proposal('j1')], jobs: [job('j1')] });
    const c = card('j1')!;
    expect(c).not.toBeNull();
    expect(c.textContent).toContain('paint the shed');
    expect(c.textContent).toContain('the shed is bare wood');
    expect(c.querySelector('[data-path="1"]')!.textContent).toContain('two coats with a brush');
    expect(c.querySelector('[data-path="2"]')!.textContent).toContain('a spray gun');
    expect(c.textContent).toContain('sound and small');
    expect(c.textContent).toContain('shed j1');
    expect(navBadge()!.textContent).toBe('1');
    expect(document.querySelector('a[href="#questions"] [data-slot="nav-badge"]')).toBeNull();
  });

  it('a proposal still with a reviewer level is listed, but the badge does not count it', async () => {
    await boot('#proposals', { proposals: [proposal('j1', { stage: 'opus', reviews: [] })], jobs: [job('j1')] });
    expect(card('j1')!.textContent).toContain('With opus');
    expect(navBadge()).toBeNull();
  });

  it('a high-priority job\'s proposal is tagged and first, and the badge marks it', async () => {
    await boot('#proposals', { proposals: [proposal('j1'), proposal('j2', { priority: 80, high: true })], jobs: [job('j1'), job('j2', 80)] });
    const order = [...document.querySelectorAll('[data-item]')].map((e) => e.getAttribute('data-item'));
    expect(order).toEqual(['p-j2', 'p-j1']);
    expect(navBadge()!.getAttribute('data-high')).toBe('1');
  });

  it('an operator continues with a selected path and a note; steering or rejecting all needs a reason', async () => {
    await boot('#proposals', { proposals: [proposal('j1')], jobs: [job('j1')] });
    const c = card('j1')!;
    expect(button(c, 'Steer')!.disabled).toBe(true);
    expect(button(c, 'Reject all')!.disabled).toBe(true);
    await act(async () => { (c.querySelector('[data-path="1"] input[type="checkbox"]') as HTMLInputElement).click(); });
    await type(card('j1')!.querySelector('textarea')!, 'go ahead');
    await act(async () => { button(card('j1')!, 'Continue with selected')!.click(); });
    await settle();
    expect(daemon.posts).toContainEqual({ path: '/ui/api/proposals/p-j1/accept', body: { notes: 'go ahead', paths: [{ id: '1' }] } });
    await type(card('j1')!.querySelector('textarea')!, 'say which paint');
    await act(async () => { button(card('j1')!, 'Steer')!.click(); });
    await settle();
    expect(daemon.posts).toContainEqual({ path: '/ui/api/proposals/p-j1/steer', body: { notes: 'say which paint' } });
  });

  it('a viewer sees a notice instead of the decisions', async () => {
    await boot('#proposals', { proposals: [proposal('j1')], jobs: [job('j1')], role: 'viewer' });
    const c = card('j1')!;
    expect(button(c, 'Continue with selected')).toBeUndefined();
    expect(c.querySelector('[data-slot="login-notice"]')).not.toBeNull();
  });

  it('an admin\'s settings offer only the escalation levels the server names, and save the reviewers', async () => {
    await boot('#proposals', { proposals: [], jobs: [], role: 'admin' });
    const panel = document.querySelector('[data-slot="review-settings"][data-section="proposals"]')!;
    const boxes = [...panel.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
    expect(boxes.map((b) => b.name)).toEqual(['opus', 'fable']);
    expect(boxes.map((b) => b.checked)).toEqual([true, false]);
    await act(async () => { boxes[1]!.click(); });
    await act(async () => { button(panel, 'Save')!.click(); });
    await settle();
    expect(daemon.posts).toContainEqual({ path: '/ui/api/proposals/settings', body: { reviewers: ['opus', 'fable'], signOff: 'owner', levelRevisions: 1 } });
  });
});
