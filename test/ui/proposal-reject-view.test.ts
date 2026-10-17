// @vitest-environment happy-dom
// Issue #1659, the UI: Reject on a proposal is always enabled — with paths, with none, sent back. It opens a dialog that
// asks for an optional note, and the dialog's Reject sends it. A refusal shows the server's error in the dialog. Several
// proposals selected are rejected at once, and the ones refused are named. Rendered inside the whole app against a fake
// of the daemon's HTTP surface.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const T0 = '2026-10-10T12:00:00.000Z';
const job = (id: string) => ({
  id, status: 'waiting_answer', priority: 50, attempts: 1, createdAt: T0, updatedAt: T0, proposalId: `p-${id}`,
  spec: { executor: 'herdr-claude', payload: { prompt: 'Paint the shed' }, goal: `shed ${id}` },
});
const PATHS = { paths: [{ id: '1', title: 'Brush two coats', summary: 'a brush', tradeoffs: {}, text: 'Summary: a brush' }] };
const proposal = (id: string, over: Record<string, unknown> = {}) => ({
  id: `p-${id}`, jobId: id, status: 'open', stage: 'human', levelRevisions: 0, priority: 50, high: false, createdAt: T0, updatedAt: T0,
  versions: [{ number: 1, text: 'TL;DR: paint it', recentOutput: '', at: T0, missing: [], sections: { tldr: 'Paint the shed.' }, paths: PATHS }],
  reviews: [], ...over,
});
const SETTINGS = { reviewers: [], signOff: 'owner', levelRevisions: 1, levels: [] };
const TYPE = {
  parts: [['tldr', 'TL;DR'], ['problem', 'Problem'], ['paths', 'Paths'], ['recommended', 'Recommended'], ['context', 'Context']],
  decisions: [
    { id: 'accept', route: 'accept', label: 'Continue with selected', effect: 'accept', notes: 'optional' },
    { id: 'steer', route: 'steer', label: 'Steer', effect: 'send_back', notes: 'required' },
    { id: 'reject', route: 'reject', label: 'Reject', effect: 'reject', notes: 'optional' },
  ],
};

type Reply = (path: string, body: Record<string, unknown>) => [number, unknown];
const ROUTES: Record<string, unknown> = {
  '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
  '/api/machines': { machines: [] }, '/api/decisions': { decisions: [] }, '/api/events': { events: [] },
  '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] }, '/api/sources': { sources: [] },
  '/api/questions': { questions: [] }, '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }, '/api/accounts': { accounts: [] },
};

function fakeDaemon(proposals: Record<string, unknown>[], reply: Reply) {
  const posts: { path: string; body: unknown }[] = [];
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const [p] = String(input).split('?') as [string];
    if (p === '/ui/api/session') return json(200, { authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: 'operator', realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
    if (p === '/api/queue') return json(200, { waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: proposals.map((x) => job(String(x.jobId))), ended: [], locked: [] });
    if (p === '/api/proposals') return json(200, { items: proposals, settings: SETTINGS, type: TYPE });
    if (p.endsWith('/seen')) return json(200, proposals[0]);
    if (p.startsWith('/ui/api/')) {
      const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      posts.push({ path: p, body });
      return json(...reply(p, body));
    }
    return json(200, ROUTES[p] ?? {});
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
const ok: Reply = () => [200, proposal('j1', { status: 'rejected' })];

async function boot(proposals: Record<string, unknown>[], reply: Reply = ok) {
  window.location.hash = '#proposals';
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  daemon = fakeDaemon(proposals, reply);
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
const rejectButton = (within: Element) => within.querySelector('[data-decision="reject"]') as HTMLButtonElement | null;
const dialog = () => document.querySelector('[data-slot="reject-dialog"]') as HTMLElement | null;
async function click(el: HTMLElement) { await act(async () => { el.click(); }); await settle(); }
async function type(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); });
}
const confirm = () => click(dialog()!.querySelector('[data-slot="reject-confirm"]') as HTMLElement);

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('reject one proposal', () => {
  it('Reject with no note typed opens the dialog, and its Reject sends the reject', async () => {
    await boot([proposal('j1')]);
    const b = rejectButton(card('j1'))!;
    expect(b.disabled).toBe(false);
    await click(b);
    expect(dialog()).not.toBeNull();
    await confirm();
    expect(daemon.posts).toContainEqual({ path: '/ui/api/proposals/p-j1/reject', body: {} });
    expect(dialog()).toBeNull();
  });

  it('the note typed in the dialog goes with it', async () => {
    await boot([proposal('j1')]);
    await click(rejectButton(card('j1'))!);
    await type(dialog()!.querySelector('[data-slot="reject-note"]') as HTMLTextAreaElement, 'not this year');
    await confirm();
    expect(daemon.posts).toContainEqual({ path: '/ui/api/proposals/p-j1/reject', body: { notes: 'not this year' } });
  });

  it('a proposal with zero paths, and one sent back, can be rejected too', async () => {
    const none = { ...proposal('j1').versions[0], paths: { paths: [], none: 'nothing to do' } };
    await boot([proposal('j1', { versions: [none] }), proposal('j2', { status: 'revising' })]);
    expect(rejectButton(card('j1'))!.disabled).toBe(false);
    await click(rejectButton(card('j2'))!);
    await confirm();
    expect(daemon.posts).toContainEqual({ path: '/ui/api/proposals/p-j2/reject', body: {} });
  });

  it('a refusal shows the server\'s error in the dialog, which stays open', async () => {
    await boot([proposal('j1')], () => [409, { error: 'proposal p-j1 is accepted: only an open proposal can be decided' }]);
    await click(rejectButton(card('j1'))!);
    await confirm();
    expect(dialog()).not.toBeNull();
    expect(dialog()!.querySelector('[data-slot="reject-error"]')!.textContent).toContain('is accepted');
  });
});

describe('reject several proposals', () => {
  const select = (id: string) => click(document.querySelector(`[data-select="p-${id}"]`) as HTMLElement);
  const bulk = () => document.querySelector('[data-slot="bulk-reject"]') as HTMLElement | null;

  it('the ones selected are rejected in one request', async () => {
    await boot([proposal('j1'), proposal('j2'), proposal('j3')], (p, b) => [200, p === '/ui/api/proposals/reject' ? { results: (b.ids as string[]).map((id) => ({ id, ok: true })) } : {}]);
    expect(bulk()).toBeNull();
    await select('j1');
    await select('j3');
    expect(rejectButton(bulk()!)!.textContent).toContain('Reject selected (2)');
    await click(rejectButton(bulk()!)!);
    await type(dialog()!.querySelector('[data-slot="reject-note"]') as HTMLTextAreaElement, 'all old');
    await confirm();
    expect(daemon.posts).toContainEqual({ path: '/ui/api/proposals/reject', body: { ids: ['p-j1', 'p-j3'], notes: 'all old' } });
    expect(bulk()).toBeNull();
  });

  it('the ones refused are named with their errors', async () => {
    await boot([proposal('j1'), proposal('j2')], () => [200, { results: [{ id: 'p-j1', ok: true }, { id: 'p-j2', ok: false, status: 409, error: 'proposal p-j2 is accepted' }] }]);
    await select('j1');
    await select('j2');
    await click(rejectButton(bulk()!)!);
    await confirm();
    await vi.waitFor(() => expect(document.body.textContent).toContain('1 of 2 rejected. p-j2: proposal p-j2 is accepted'));
  });
});
