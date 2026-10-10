// @vitest-environment happy-dom
// Issue #662, rendered inside the whole app against a fake of the daemon's HTTP surface: a job held because its item's text
// changed since the snapshot shows a card under Waiting — the title change, the body's lines removed and added, who edited
// it, the new comments — and the ways on: Rerun the original and Accept the new text post their routes; Approve is not
// offered, for no approval starts it. A viewer reads only.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

type Role = 'viewer' | 'admin';
const T = '2026-10-09T12:00:00.000Z';
const heldJob = {
  id: 'h1', spec: { executor: 'herdr-claude', payload: { body: 'Fix the bug.\nIn the parser.' }, goal: 'Fix the bug' }, priority: 50, status: 'held', approved: false, attempts: 0,
  holdReason: 'its item changed since the snapshot: keep the original, accept the new text, or cancel',
  createdAt: T, updatedAt: T, source: { source: 'github', kind: 'github', key: 'k-h1', title: 'Fix the bug', repo: 'o/r', number: 7 },
  textChange: {
    detectedAt: T, snapshotHash: 'a'.repeat(64), liveHash: 'b'.repeat(64),
    from: { title: 'Fix the bug', body: 'Fix the bug.\nIn the parser.', comments: [{ author: 'owner', at: T, body: 'Old note.' }] },
    to: { title: 'Fix the bugs', body: 'Fix the bug.\nIn the parser and the lexer.', comments: [{ author: 'owner', at: T, body: 'Old note.' }, { author: 'owner', at: '2026-10-09T12:05:00.000Z', body: 'Also the lexer.' }] },
    edits: [{ what: 'body', editor: 'someone-else', at: '2026-10-09T12:04:00.000Z' }, { what: 'title', editor: 'someone-else', at: '2026-10-09T12:04:30.000Z' }],
    accepted: { title: 'Fix the bugs', body: 'Fix the bug.\nIn the parser and the lexer.', prompt: 'p', env: {} },
  },
};

function fakeDaemon(role: Role) {
  const posts: { path: string; body: unknown }[] = [];
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: ['herdr-claude'], parkingExecutors: ['herdr-claude'], uptimeS: 1 },
    '/api/queue': { waiting: [heldJob], running: [], operatorLed: [], ended: [], locked: [], highPriority: 75, waitingAnswer: [], parked: [], waitingOn: [] },
    '/api/machines': { machines: [{ id: 'desk', label: 'desk', maxLanes: 2, online: true, executors: ['herdr-claude'], lanes: [], usage: [] }] },
    '/api/decisions': { decisions: [] }, '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] }, '/api/sources': { sources: [] },
    '/api/questions': { questions: [] },
    '/api/accounts': { accounts: [] }, '/api/usage': { readings: [], sources: [], machines: [], limits: { soft: 0.7, hard: 0.95, defaults: { soft: 0.7, hard: 0.95 }, set: false } },
    '/api/logins': { now: T, settings: { onExpiry: 'fail', warnSec: 60 }, logins: [] },
    '/api/usage/history': { view: { range: { preset: '24h' } }, from: '2026-10-08T12:00:00.000Z', to: T, stepMs: 900000, retentionDays: 90, series: [] },
    '/api/machines/history': { view: { range: { preset: '24h' } }, from: '2026-10-08T12:00:00.000Z', to: T, stepMs: 900000, retentionDays: 90, series: [] },
  };
  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const [path] = String(input).split('?') as [string];
    if (path === '/ui/api/session') return json(200, { authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role, realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
    if (path.startsWith('/ui/api/')) { posts.push({ path, body: JSON.parse(String(init.body ?? '{}')) }); return json(200, {}); }
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

async function boot(role: Role, hash: string) {
  window.location.hash = hash;
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  daemon = fakeDaemon(role);
  vi.stubGlobal('fetch', daemon.fetch);
  vi.stubGlobal('EventSource', FakeEventSource);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx';
  const mod = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(mod.App)); });
  await settle();
}

const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const buttonIn = (el: Element, label: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

const row = () => document.querySelector('[data-job-group="waiting"][data-job-id="h1"]');
const card = () => row()?.querySelector('[data-slot="text-change"]');

describe('a job held for its changed item (issue #662)', () => {
  it('shows what changed, who edited it and the new comments', async () => {
    await boot('admin', '#overview');
    const c = card()!;
    expect(c).not.toBeNull();
    expect(c.querySelector('[data-slot="editors"]')!.textContent).toBe('someone-else');
    expect(c.querySelector('[data-slot="title-change"]')!.textContent).toContain('Fix the bugs');
    const removed = [...c.querySelectorAll('[data-change="removed"]')].map((e) => e.textContent).join('');
    const added = [...c.querySelectorAll('[data-change="added"]')].map((e) => e.textContent).join('');
    expect(removed).toContain('In the parser.');
    expect(added).toContain('In the parser and the lexer.');
    const comments = c.querySelector('[data-slot="new-comments"]')!.textContent!;
    expect(comments).toContain('Also the lexer.');
    expect(comments).not.toContain('Old note.');
    expect(buttonIn(row()!, 'Approve')).toBeUndefined();
  });

  it('Rerun the original and Accept the new text post their routes', async () => {
    await boot('admin', '#overview');
    await act(async () => buttonIn(card()!, 'Rerun the original')!.click());
    await act(async () => buttonIn(card()!, 'Accept the new text')!.click());
    expect(daemon.posts.map((p) => p.path)).toEqual(['/ui/api/jobs/h1/keep-original', '/ui/api/jobs/h1/accept-new-text']);
  });

  it('a viewer sees the card and no buttons', async () => {
    await boot('viewer', '#overview');
    expect(card()).not.toBeNull();
    expect(buttonIn(card()!, 'Rerun the original')).toBeUndefined();
    expect(buttonIn(card()!, 'Accept the new text')).toBeUndefined();
  });
});
