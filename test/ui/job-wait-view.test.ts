// @vitest-environment happy-dom
// Issue #483, rendered inside the whole app against a fake of the daemon's HTTP surface: a job on its own wait is listed
// under Waiting as waiting on what it named, not as a question; it is in no question list or badge. End the wait posts
// the end; a viewer reads only.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

type Role = 'viewer' | 'admin';
const T = '2026-10-09T12:00:00.000Z';
const waitingJob = {
  id: 'w1', spec: { executor: 'herdr-claude', payload: {} }, priority: 50, status: 'waiting_on', approved: true, attempts: 1, resumeOn: 'desk',
  createdAt: T, updatedAt: T, source: { source: 'github', kind: 'github', key: 'k-w1', title: 'Fix the bug', repo: 'o/r', number: 7 },
  wait: { for: 'write access to the repository', until: 'a background poll of the push', since: T },
};

const ownCommandJob = {
  ...waitingJob, id: 'w2', source: { ...waitingJob.source, key: 'k-w2', title: 'Run the tests', number: 8 },
  wait: { for: 'the test run to end', until: 'background command b7x2 ends', since: T, ownCommand: true },
};

function fakeDaemon(role: Role, waitingOn: unknown[] = [waitingJob]) {
  const posts: { path: string; body: unknown }[] = [];
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: ['herdr-claude'], parkingExecutors: ['herdr-claude'], uptimeS: 1 },
    '/api/queue': { waiting: [], running: [], operatorLed: [], ended: [], locked: [], highPriority: 75, waitingAnswer: [], parked: [], waitingOn },
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

async function boot(role: Role, hash: string, waitingOn?: unknown[]) {
  window.location.hash = hash;
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  daemon = fakeDaemon(role, waitingOn);
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
const row = () => document.querySelector('[data-job-group="waitingOn"][data-job-id="w1"]');
const buttonIn = (el: Element, label: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('a job on its own wait', () => {
  it('is listed under Waiting with what it waits for and how it will know; it is no question', async () => {
    await boot('admin', '#dashboard');
    const r = row()!;
    expect(r).not.toBeNull();
    expect(r.getAttribute('data-status')).toBe('waiting_on');
    expect(r.textContent).toContain('Fix the bug');
    expect(r.querySelector('[data-slot="waits-for"]')!.textContent).toBe('write access to the repository');
    expect(r.querySelector('[data-slot="wait-until"]')!.textContent).toBe('a background poll of the push');
    expect(r.textContent).toContain('desk');
    expect(document.querySelector('[data-job-group="waitingAnswer"]')).toBeNull();
  });

  it('End the wait posts the end of its wait', async () => {
    await boot('admin', '#dashboard');
    await act(async () => { buttonIn(row()!, 'End the wait')!.click(); });
    await settle();
    expect(daemon.posts).toEqual([{ path: '/ui/api/jobs/w1/end-wait', body: {} }]);
  });

  it('a viewer sees the wait, and no button', async () => {
    await boot('viewer', '#dashboard');
    expect(row()).not.toBeNull();
    expect(buttonIn(row()!, 'End the wait')).toBeUndefined();
  });

  it('shows its wait check: what the hopper checks, the last result, and overdue past its deadline (issue #1694)', async () => {
    const check = { condition: { kind: 'items_ended', refs: [{ kind: 'issue', repo: 'octo/tools', number: 9 }] }, nextCheckAt: T, everyMs: 120000, attempts: 2, deadline: T, checkedAt: T, result: 'not ended yet: octo/tools#9' };
    await boot('admin', '#dashboard', [{ ...waitingJob, wait: { ...waitingJob.wait, check } }, { ...ownCommandJob, wait: { ...ownCommandJob.wait, check: { ...check, condition: { kind: 'command_exited' }, overdueAt: T } } }]);
    const line = row()!.querySelector('[data-slot="wait-check"]')!.textContent!;
    expect(line).toContain('the hopper checks whether octo/tools#9 ended');
    expect(line).toContain('last check: not ended yet: octo/tools#9');
    const own = document.querySelector('[data-job-group="waitingOn"][data-job-id="w2"] [data-slot="wait-check"]')!.textContent!;
    expect(own).toContain('the hopper checks whether its own command ended');
    expect(own).toContain('overdue');
  });

  it('a wait on its own command shows as running, with its runtime, not as waiting on the outside world (issue #1037)', async () => {
    await boot('admin', '#dashboard', [ownCommandJob, { ...ownCommandJob, id: 'w3', wait: { ...ownCommandJob.wait, stuckAt: T } }]);
    const own = document.querySelector('[data-job-group="waitingOn"][data-job-id="w2"]')!;
    expect(own.querySelector('[data-slot="own-wait"]')!.textContent).toBe('running: waiting on its own command');
    expect(own.textContent).toContain('running for');
    const stuck = document.querySelector('[data-job-group="waitingOn"][data-job-id="w3"]')!;
    expect(stuck.querySelector('[data-slot="own-wait"]')!.textContent).toBe('stuck: its own command is gone');
  });

  it('a wait whose agent session ended shows as stranded, with End the wait (issue #1779)', async () => {
    await boot('admin', '#dashboard', [{ ...waitingJob, wait: { ...waitingJob.wait, on: { kind: 'grant' }, strandedAt: T } }]);
    expect(row()!.querySelector('[data-slot="own-wait"]')!.textContent).toBe('stranded: its agent session ended');
    expect(buttonIn(row()!, 'End the wait')).toBeDefined();
  });
});
