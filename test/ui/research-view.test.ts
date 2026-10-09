// @vitest-environment happy-dom
// The Research view (issue #543, #538), rendered inside the whole app against a fake of the daemon's HTTP surface: a
// section of its own, built from the same section model as Proposals. A report waiting on a person shows its parts,
// its rounds and its job; the nav badge counts the open ones waiting on a person until they are decided, seen or not
// (#499), high-priority ones marked and first (#535). An operator accepts, asks to dig deeper (optionally on chosen
// open threads) or steers (only with a direction): exactly the decisions the server declares.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const T0 = '2026-10-09T12:00:00.000Z';
const job = (id: string, priority = 50) => ({
  id, status: 'waiting_answer', priority, attempts: 1, createdAt: T0, updatedAt: T0, researchId: `r-${id}`,
  spec: { executor: 'herdr-claude', payload: { prompt: 'Paint the shed' }, goal: `shed ${id}` },
});
const report = (id: string, over: Record<string, unknown> = {}) => ({
  id: `r-${id}`, kind: 'research', jobId: id, status: 'open', stage: 'human', levelRevisions: 0, priority: 50, high: false, createdAt: T0, updatedAt: T0,
  versions: [{
    number: 1, text: 'Question: which paint lasts', recentOutput: '', at: T0, missing: ['confidence'],
    sections: { question: 'which paint lasts', findings: 'oil lasts longest', sources: 'the shop', openThreads: 'cost\nweather', nextStep: 'buy oil paint' },
  }],
  reviews: [],
  ...over,
});
const SETTINGS = { reviewers: [], signOff: 'owner', levelRevisions: 1, levels: ['opus', 'fable'] };
// The section type as the server declares it (issue #543): the UI offers exactly these parts and decisions.
const TYPE = {
  parts: [['question', 'Question'], ['findings', 'Findings'], ['sources', 'Sources and evidence'], ['confidence', 'Confidence'], ['openThreads', 'Open threads'], ['nextStep', 'Next step']],
  decisions: [
    { id: 'accept', route: 'accept', label: 'Accept', effect: 'accept', notes: 'optional' },
    { id: 'dig_deeper', route: 'dig-deeper', label: 'Dig deeper', effect: 'send_back', notes: 'optional' },
    { id: 'steer', route: 'steer', label: 'Steer', effect: 'send_back', notes: 'required' },
  ],
};

type Role = 'viewer' | 'operator' | 'admin';
interface Daemon { reports: Record<string, unknown>[]; jobs: Record<string, unknown>[]; role?: Role }

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
    if (path === '/api/research') {
      const open = !query.includes('status=all');
      return json(200, { items: open ? d.reports.filter((p) => p.status === 'open' || p.status === 'revising') : d.reports, settings: SETTINGS, type: TYPE });
    }
    if (path.startsWith('/ui/api/')) {
      posts.push({ path, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (path === '/ui/api/research/settings') return json(200, { ...SETTINGS, ...(JSON.parse(String(init.body)) as object) });
      return json(200, d.reports[0]);
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

const card = (id: string) => document.querySelector(`[data-item="r-${id}"]`) as HTMLElement | null;
const navBadge = () => document.querySelector('a[href="#research"] [data-slot="nav-badge"]');
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

describe('the Research view', () => {
  it('is its own nav entry; a report waiting on a person shows its parts, what it left out and its job; the badge counts it', async () => {
    await boot('#research', { reports: [report('j1')], jobs: [job('j1')] });
    expect(document.querySelector('a[href="#research"]')!.textContent).toContain('Research');
    const c = card('j1')!;
    expect(c.textContent).toContain('which paint lasts');
    expect(c.textContent).toContain('Sources and evidence');
    expect(c.textContent).toContain('oil lasts longest');
    expect(c.querySelector('[data-slot="missing"]')!.textContent).toContain('Confidence');
    expect(c.textContent).toContain('shed j1');
    expect(navBadge()!.textContent).toBe('1');
    expect(document.querySelector('a[href="#proposals"] [data-slot="nav-badge"]')).toBeNull();
  });

  it('the badge stays up while a report is open, seen or not', async () => {
    await boot('#overview', { reports: [report('j1', { seenAt: T0 })], jobs: [job('j1')] });
    expect(navBadge()!.textContent).toBe('1');
  });

  it('a high-priority job\'s report is tagged and first, and the badge marks it', async () => {
    await boot('#research', { reports: [report('j1'), report('j2', { priority: 80, high: true })], jobs: [job('j1'), job('j2', 80)] });
    const order = [...document.querySelectorAll('[data-item]')].map((e) => e.getAttribute('data-item'));
    expect(order).toEqual(['r-j2', 'r-j1']);
    expect(navBadge()!.getAttribute('data-high')).toBe('1');
  });

  it('an operator gets exactly the decisions the server declares: accept, dig deeper on chosen threads, steer with a direction', async () => {
    await boot('#research', { reports: [report('j1')], jobs: [job('j1')] });
    const c = card('j1')!;
    expect([...c.querySelectorAll('[data-decision]')].map((b) => b.getAttribute('data-decision'))).toEqual(['accept', 'dig_deeper', 'steer']);
    expect(button(c, 'Reject')).toBeUndefined();
    expect(button(c, 'Steer')!.disabled).toBe(true);
    expect(button(c, 'Dig deeper')!.disabled).toBe(false);
    const threads = [...c.querySelectorAll('[data-slot="threads"] input[type="checkbox"]')] as HTMLInputElement[];
    expect(threads.map((b) => b.name)).toEqual(['cost', 'weather']);
    await act(async () => { threads[1]!.click(); });
    await act(async () => { button(c, 'Dig deeper')!.click(); });
    await settle();
    expect(daemon.posts).toContainEqual({ path: '/ui/api/research/r-j1/dig-deeper', body: { notes: 'Dig deeper on these open threads:\n- weather' } });
    await type(card('j1')!.querySelector('textarea')!, 'only the AWS side');
    await act(async () => { button(card('j1')!, 'Steer')!.click(); });
    await settle();
    expect(daemon.posts).toContainEqual({ path: '/ui/api/research/r-j1/steer', body: { notes: 'only the AWS side' } });
  });

  it('a viewer sees a notice instead of the decisions', async () => {
    await boot('#research', { reports: [report('j1')], jobs: [job('j1')], role: 'viewer' });
    const c = card('j1')!;
    expect(button(c, 'Accept')).toBeUndefined();
    expect(c.querySelector('[data-slot="login-notice"]')).not.toBeNull();
  });

  it('an admin\'s research settings offer only the escalation levels the server names', async () => {
    await boot('#research', { reports: [], jobs: [], role: 'admin' });
    const panel = document.querySelector('[data-slot="review-settings"][data-section="research"]')!;
    const boxes = [...panel.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
    expect(boxes.map((b) => b.name)).toEqual(['opus', 'fable']);
    await act(async () => { boxes[0]!.click(); });
    await act(async () => { button(panel, 'Save')!.click(); });
    await settle();
    expect(daemon.posts).toContainEqual({ path: '/ui/api/research/settings', body: { reviewers: ['opus'], signOff: 'owner', levelRevisions: 1 } });
  });
});
