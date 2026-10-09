// @vitest-environment happy-dom
// The Failures view (issue #509), rendered inside the whole app against a fake of the daemon's HTTP surface: the
// open problems with their jobs and actions, the recent assessed failures with their decision and summary, the
// profile, the settings (admin). An action shows only when the daemon would take it — the answer's `actions` and
// the session's role — and goes to the daemon. It updates live: an assessor event reads the failures again. A
// failed job shows its assessment where its error shows.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const T0 = Date.parse('2026-10-08T12:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

const failedJob = {
  id: 'j1', status: 'failed', priority: 50, attempts: 1, createdAt: at(-600), updatedAt: at(-60), finishedAt: at(-60), error: 'no space left on device',
  spec: { executor: 'herdr-claude', payload: {}, goal: 'Fix the build' }, approved: false,
  assessment: { recordId: 'f1', at: at(-59), class: 'shared', decision: 'hold', summary: 'Held: Disk full on desk', reasons: ['known cause: Disk full'], problemId: 'p1', problemTitle: 'Disk full on desk' },
};
const settings = { maxAttempts: 3, backoffSec: 60, backoffFactor: 2, backoffMaxSec: 1800, groupThreshold: 3, groupWindowMin: 60, auto: { retry: true, hold: true, redirect: true }, retentionDays: 90 };
const evidence = { error: 'no space left on device', executor: 'herdr-claude', machineId: 'desk', attempt: 1, sameSignature: 2 };
const problem = (over: Record<string, unknown> = {}) => ({
  id: 'p1', signature: 'aaa', title: 'Disk full on desk', causeId: 'disk-full', decision: 'redirect', scope: { machineId: 'desk' }, status: 'open',
  openedAt: at(-120), updatedAt: at(-60), general: false, jobIds: ['j1', 'j2', 'j3'], held: ['j1'],
  actions: { resolve: { ok: true }, release: { ok: false, why: 'no job is held' } }, ...over,
});
const record = (over: Record<string, unknown> = {}) => ({
  id: 'f1', jobId: 'j1', at: at(-59), signature: 'aaa', normalised: 'no space left on device', cls: 'shared', decision: 'hold', causeId: 'disk-full', causeName: 'Disk full',
  reasons: ['known cause: Disk full'], summary: 'Held: Disk full on desk', auto: true, evidence, problemId: 'p1', outcome: 'held',
  actions: { retry: { ok: false, why: 'it waits on its problem' } }, ...over,
});
const handoff = (over: Record<string, unknown> = {}) => ({
  id: 'h1', jobId: 'j9', recordId: 'f2', status: 'open', reason: 'person', openedAt: at(-30), decision: 'person', class: 'job',
  summary: 'Needs a person. Ran 1 time on desk. Failed: tests fail.', reasons: ['no known cause matches', 'not seen on other jobs: it needs a person'], error: 'HOPPER_FAILED tests fail',
  actions: { continue: { ok: true }, fixed: { ok: true }, doneByHand: { ok: true }, wontDo: { ok: true } }, continueResumes: true, signature: 'bbbbbbbbbbbb', ...over,
});
const view = (over: Record<string, unknown> = {}) => ({
  now: at(0), counts: { unassessed: 0, needsPerson: 0 }, settings, handoffs: [] as ReturnType<typeof handoff>[], causes: [{ id: 'disk-full', name: 'Disk full', description: 'The disk is full.', cls: 'shared', decision: 'redirect', builtin: true }],
  problems: [problem()], recent: [record(), record({ id: 'f2', jobId: 'j9', cls: 'job', decision: 'person', outcome: 'surfaced', problemId: undefined, summary: 'Needs a person. Ran 1 time on desk. Failed: tests fail.', actions: { retry: { ok: true } } })],
  profile: {
    days: [{ day: '2026-10-07', count: 1 }, { day: '2026-10-08', count: 3 }],
    signatures: [{ signature: 'aaa', name: 'Disk full', cls: 'shared', count: 3, jobs: 3, machines: 1, lastAt: at(-59), general: false, trend: [0, 3] }],
    byMachine: [{ key: 'desk', count: 3 }], byRepo: [{ key: 'o/a', count: 3 }], byExecutor: [{ key: 'herdr-claude', count: 3 }],
  },
  ...over,
});

type Role = 'viewer' | 'operator' | 'admin';
interface Daemon { failures: ReturnType<typeof view>; role?: Role }

function fakeDaemon(d: Daemon) {
  const posts: string[] = [];
  const bodies: unknown[] = [];
  let reads = 0;
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': { waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: [], ended: [failedJob], locked: [failedJob] },
    '/api/machines': { machines: [] }, '/api/decisions': { decisions: [] }, '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] }, '/api/sources': { sources: [] },
    '/api/questions': { questions: [] }, '/api/accounts': { accounts: [] },
    '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] },
    '/api/logins': { now: at(0), settings: { onExpiry: 'fail', warnSec: 60 }, logins: [] },
  };
  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const [path] = String(input).split('?') as [string];
    if (path === '/ui/api/session') return json(200, { authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: d.role ?? 'operator', realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
    if (path === '/api/failures') { reads += 1; return json(200, d.failures); }
    if (path.startsWith('/ui/api/')) { posts.push(`${init.method ?? 'GET'} ${path}`); bodies.push(init.body ? JSON.parse(String(init.body)) : undefined); return json(200, {}); }
    return json(200, routes[path] ?? {});
  });
  return { fetch, posts, bodies, reads: () => reads };
}

class FakeEventSource {
  static last: FakeEventSource | undefined;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, (m: { data: string }) => void>();
  constructor() { FakeEventSource.last = this; }
  addEventListener(type: string, fn: (m: { data: string }) => void): void { this.listeners.set(type, fn); }
  close(): void {}
  send(e: Record<string, unknown>): void { this.listeners.get(String(e.type))?.({ data: JSON.stringify(e) }); }
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
  const app = '../../ui/src/app/app.tsx';
  const mod = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(mod.App)); });
  await settle();
}

async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

const buttonsIn = (el: Element | null) => [...(el?.querySelectorAll('button') ?? [])].map((b) => b.textContent ?? '');
const problemCard = () => document.querySelector('[data-problem="p1"]');
const handoffRow = (id = 'h1') => document.querySelector(`[data-handoff="${id}"]`);
const navBadge = () => document.querySelector('a[href="#failures"] [data-slot="nav-badge"]')?.textContent;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(T0);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the Failures view', () => {
  it('an open problem: its cause, its jobs and the held ones; the nav badge counts open problems', async () => {
    await boot('#failures', { failures: view() });
    const c = problemCard()!;
    expect(c).not.toBeNull();
    expect(c.textContent).toContain('Disk full on desk');
    expect(c.textContent).toContain('3 jobs');
    expect(c.textContent).toContain('1 held');
    expect(document.querySelector('a[href="#failures"] [data-slot="nav-badge"]')?.textContent).toBe('1');
  });

  it('offers only the actions the daemon would take: Resolve yes, Release held no (none held)', async () => {
    await boot('#failures', { failures: view() });
    expect(buttonsIn(problemCard())).toContain('Resolve');
    expect(buttonsIn(problemCard()).join(' ')).not.toContain('Release held');
    const retryable = document.querySelector('[data-failure="f2"]');
    const waiting = document.querySelector('[data-failure="f1"]');
    expect(buttonsIn(retryable)).toContain('Retry');
    expect(buttonsIn(waiting)).not.toContain('Retry');
  });

  it('a viewer is offered no action, and sees no settings', async () => {
    await boot('#failures', { failures: view(), role: 'viewer' });
    expect(buttonsIn(problemCard())).not.toContain('Resolve');
    expect(buttonsIn(document.querySelector('[data-failure="f2"]'))).not.toContain('Retry');
    expect(document.querySelector('[data-section="failure-settings"]')).toBeNull();
  });

  it('an admin sees the settings', async () => {
    await boot('#failures', { failures: view(), role: 'admin' });
    expect(document.querySelector('[data-section="failure-settings"]')).not.toBeNull();
  });

  it('Resolve and Retry go to the daemon', async () => {
    await boot('#failures', { failures: view({ problems: [problem({ actions: { resolve: { ok: true }, release: { ok: true } } })] }) });
    const click = async (el: Element | null, text: string) => {
      const b = [...(el?.querySelectorAll('button') ?? [])].find((x) => x.textContent === text) as HTMLButtonElement;
      await act(async () => { b.click(); });
      await settle();
    };
    await click(problemCard(), 'Release held');
    expect(daemon.posts).toContain('POST /ui/api/failures/problems/p1/release');
    await click(problemCard(), 'Resolve');
    expect(daemon.posts).toContain('POST /ui/api/failures/problems/p1/resolve');
    await click(document.querySelector('[data-failure="f2"]'), 'Retry');
    expect(daemon.posts).toContain('POST /ui/api/failures/f2/retry');
  });

  it('the recent failures show decision and summary; the profile its top signatures and breakdowns', async () => {
    await boot('#failures', { failures: view() });
    const f2 = document.querySelector('[data-failure="f2"]')!;
    expect(f2.textContent).toContain('needs a person');
    expect(f2.textContent).toContain('Needs a person. Ran 1 time on desk. Failed: tests fail.');
    const profile = document.querySelector('[data-section="failure-profile"]')!;
    expect(profile.textContent).toContain('Disk full');
    expect(profile.textContent).toContain('desk');
    expect(profile.textContent).toContain('o/a');
    expect(profile.textContent).toContain('herdr-claude');
  });

  it('updates live: a failure event reads the failures again', async () => {
    const d: Daemon = { failures: view({ problems: [] }) };
    await boot('#failures', d);
    expect(problemCard()).toBeNull();
    d.failures = view();
    await act(async () => { FakeEventSource.last!.send({ seq: 1, schemaVersion: 1, id: 'e1', type: 'failure.grouped', at: at(1), jobId: 'j1', data: {} }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    await settle();
    expect(problemCard()).not.toBeNull();
  });

  it('a failed job shows its assessment where its error shows', async () => {
    await boot('#queue', { failures: view() });
    const a = document.querySelector('[data-job-id="j1"] [data-assessment]');
    expect(a?.textContent).toContain('Held: Disk full on desk');
  });

  it('Needs a person: each open hand-off with its reason and summary, its own count; the nav badge counts it too', async () => {
    await boot('#failures', { failures: view({ handoffs: [handoff(), handoff({ id: 'h2', jobId: 'j8', reason: 'retry_limit' })] }) });
    const section = document.querySelector('[data-section="needs-a-person"]')!;
    expect(section).not.toBeNull();
    expect(section.querySelector('[data-slot="handoff-count"]')?.textContent).toBe('2');
    expect(handoffRow()!.textContent).toContain('Needs a person. Ran 1 time on desk. Failed: tests fail.');
    expect(handoffRow('h2')!.textContent).toContain('retries used up');
    // One open problem and two open hand-offs.
    expect(navBadge()).toBe('3');
  });

  it('says the next step for why it was handed off, and what each resolution leads to (issue #551)', async () => {
    await boot('#failures', { failures: view({ handoffs: [handoff(), handoff({ id: 'h2', reason: 'retry_limit', continueResumes: false })] }) });
    const row = handoffRow()!;
    expect(row.querySelector('[data-slot="next-step"]')!.textContent).toContain('Continue with a note');
    expect(handoffRow('h2')!.querySelector('[data-slot="next-step"]')!.textContent).toContain('the cause is likely outside the job');
    expect(row.querySelector('[data-resolution="continue"]')!.textContent).toContain('Its own session goes on in its work tree');
    expect(handoffRow('h2')!.querySelector('[data-resolution="continue"]')!.textContent).toContain('a new job of its item runs');
    expect(row.querySelector('[data-resolution="done_by_hand"]')!.textContent).toContain('the job ends finished');
  });

  it('a refused resolution says why instead of disappearing; a viewer is offered none', async () => {
    const refused = { ok: false, why: 'a newer job of its item exists' };
    await boot('#failures', { failures: view({ handoffs: [handoff(), handoff({ id: 'h2', actions: { continue: refused, fixed: refused, doneByHand: { ok: true }, wontDo: { ok: true } } })] }) });
    expect(buttonsIn(handoffRow())).toEqual(expect.arrayContaining(['Continue', 'I fixed it', 'Done by hand', "Won't do"]));
    expect(buttonsIn(handoffRow('h2'))).not.toContain('Continue');
    expect(buttonsIn(handoffRow('h2'))).toContain('Done by hand');
    expect(handoffRow('h2')!.querySelector('[data-resolution="continue"]')!.textContent).toContain('not now — a newer job of its item exists');
    await act(async () => root?.unmount());
    await boot('#failures', { failures: view({ handoffs: [handoff()] }), role: 'viewer' });
    expect(handoffRow()!.querySelector('[data-slot="resolve"]')).toBeNull();
  });

  it('a resolution goes to the daemon with the note (Won\'t do only with one); once resolved, the card says what was done and links the next job', async () => {
    const d: Daemon = { failures: view({ problems: [], handoffs: [handoff()] }) };
    await boot('#failures', d);
    expect(navBadge()).toBe('1');
    const button = (text: string) => [...(handoffRow()?.querySelectorAll('button') ?? [])].find((x) => x.textContent === text) as HTMLButtonElement;
    expect(button("Won't do").disabled).toBe(true);
    const note = handoffRow()!.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(note, 'Use the blue paint.');
      note.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(button("Won't do").disabled).toBe(false);
    await act(async () => { button('Continue').click(); });
    await settle();
    expect(daemon.posts).toContain('POST /ui/api/failures/handoffs/h1/resolve');
    expect(daemon.bodies.at(-1)).toEqual({ action: 'continue', note: 'Use the blue paint.' });
    d.failures = view({ problems: [], handoffs: [handoff({
      status: 'closed', end: 'continued', closedAt: at(1), nextJobId: 'j9',
      resolution: { action: 'continue', resumed: true, by: 'Pat', at: at(1), note: 'Use the blue paint.', writeBack: 'written' },
      actions: { continue: { ok: false, why: 'already resolved: continued' }, fixed: { ok: false, why: 'already resolved: continued' }, doneByHand: { ok: false, why: 'x' }, wontDo: { ok: false, why: 'x' } },
    })] });
    await act(async () => { FakeEventSource.last!.send({ seq: 2, schemaVersion: 1, id: 'e2', type: 'handoff.closed', at: at(1), jobId: 'j9', data: {} }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    await settle();
    expect(navBadge()).toBeUndefined();
    const resolved = handoffRow()!.querySelector('[data-slot="resolution"]')!.textContent;
    expect(resolved).toContain('continued in its session');
    expect(resolved).toContain('by Pat');
    expect(resolved).toContain('told its issue');
    expect(handoffRow()!.querySelector('[data-slot="next-job"]')!.textContent).toContain('Goes on as');
    expect(handoffRow()!.querySelector('[data-slot="resolve"]')).toBeNull();
  });

  it('an admin can name the cause from the card, with what to do next time', async () => {
    await boot('#failures', { failures: view({ handoffs: [handoff()] }), role: 'admin' });
    const learn = handoffRow()!.querySelector('[data-slot="learn"]')!;
    expect(learn.textContent).toContain('Name this cause');
    await act(async () => { (learn.querySelector('button') as HTMLButtonElement).click(); });
    expect(handoffRow()!.querySelector('input[aria-label="Next time"]')).not.toBeNull();
  });

  it('counts what is left (issue #517): failed jobs not assessed yet, and those that need a person', async () => {
    await boot('#failures', { failures: view({ counts: { unassessed: 2, needsPerson: 1 } }) });
    const counts = document.querySelector('[data-section="failure-counts"]')!;
    expect(counts.textContent).toContain('2 failed jobs not assessed yet');
    expect(counts.textContent).toContain('1 failed job needs a person');
  });

  it('nothing left: it says so', async () => {
    await boot('#failures', { failures: view({ counts: { unassessed: 0, needsPerson: 0 } }) });
    expect(document.querySelector('[data-section="failure-counts"]')!.textContent).toContain('Every failed job is assessed, and none needs a person');
  });

  it('a superseded failure says its item ran again, and offers no Retry', async () => {
    await boot('#failures', { failures: view({ recent: [record({ id: 'f3', jobId: 'j3', outcome: 'superseded', nextJobId: 'j4', problemId: undefined, summary: 'Already run again (job j4).', actions: { retry: { ok: false, why: 'already run again' } } })] }) });
    const f3 = document.querySelector('[data-failure="f3"]')!;
    expect(f3.textContent).toContain('its item ran again');
    expect(buttonsIn(f3)).not.toContain('Retry');
  });
});
