// @vitest-environment happy-dom
// Direct jobs in the UI (issue #901, part 2), rendered against a fake of the daemon's HTTP: the submit form sends a job
// straight to the hopper, with no GitHub issue; the list reads each direct job back with its job's state, its result,
// its error and its open questions. A viewer reads the list and sees no form.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

type El = ReturnType<typeof createElement>;
let root: Root | undefined;
let calls: { method: string; path: string; body?: unknown }[] = [];

const D1 = {
  id: 'd1', title: 'Unlock a sign-in', brief: 'Clear the lockout.', labels: ['sme:identity'], authorizations: ['keycloak:otp-reset'],
  submittedBy: { person: 'ada', via: 'ui' }, submittedAt: '2026-10-12T10:00:00.000Z',
  job: { id: 'j1', status: 'waiting_answer', questions: [{ id: 'q1', text: 'Which account is locked?', tier: 'human', askedAt: '2026-10-12T10:05:00.000Z' }] },
};
const D0 = {
  id: 'd0', title: 'Look up a login', brief: 'Read the audit log.', labels: [], authorizations: [],
  submittedBy: { person: 'bob', via: 'api' }, submittedAt: '2026-10-11T10:00:00.000Z',
  job: { id: 'j0', status: 'finished', result: 'Two failed logins, no lockout.', questions: [] },
};
const D2 = { ...D1, id: 'd2', title: 'Reset a one-time password', job: undefined };

async function render(role: 'operator' | 'viewer' = 'operator', list: unknown[] = [D1, D0]) {
  calls = [];
  let directJobs = list;
  localStorage.setItem('jh_session', 'a'.repeat(64));
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) as unknown : undefined;
    calls.push({ method: init.method ?? 'GET', path: String(path), ...(body !== undefined ? { body } : {}) });
    if (path === '/ui/api/direct-jobs') { directJobs = [D2, ...directJobs]; return json({ directJob: D2 }); }
    return json({ directJobs });
  }));
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  const view = '../../ui/src/views/direct-jobs.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const store = '../../ui/src/store/index.ts';
  const { useHopper } = (await import(store)) as { useHopper: { setState(s: Record<string, unknown>): void } };
  useHopper.setState({ authed: true, user: { id: 'u1', name: 'ada', role, realm: 'local', identity: 'ada' } });
  const { DirectJobs } = (await import(view)) as { DirectJobs: () => El };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(DirectJobs)); });
  await settle();
}

const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const rows = () => [...document.querySelectorAll('[data-slot="direct-job-row"]')];
const field = (label: string) => document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`);
const button = (text: RegExp) => [...document.querySelectorAll('button')].find((b) => text.test(b.textContent ?? ''));
async function type(el: HTMLInputElement | HTMLTextAreaElement | null, value: string) {
  expect(el).not.toBeNull();
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('Direct jobs', () => {
  it('reads each direct job back: its state, its open question with a way to answer it, its result, a link to its job', async () => {
    await render();
    expect(calls[0]).toEqual({ method: 'GET', path: '/api/direct-jobs' });
    expect(rows()).toHaveLength(2);
    const [waiting, done] = rows().map((r) => r.textContent ?? '');
    expect(waiting).toContain('Unlock a sign-in');
    expect(waiting).toContain('1 question waits');
    expect(waiting).toContain('Which account is locked?');
    expect(waiting).toContain('sme:identity');
    expect(waiting).toContain('keycloak:otp-reset');
    expect(waiting).toContain('Submitted by ada in the UI');
    expect(rows()[0]!.querySelector('a[href="#questions"]')).not.toBeNull();
    expect(rows()[0]!.querySelector('a[href="#job/j1"]')).not.toBeNull();
    expect(done).toContain('Two failed logins, no lockout.');
    expect(done).toContain('Submitted by bob with an API token');
  });

  it('submits a job from the form, with no GitHub issue, and lists it', async () => {
    await render();
    expect(button(/Submit/)?.disabled).toBe(true);
    await type(field('Title'), 'Reset a one-time password');
    await type(field('Brief'), 'Reset the one-time password of the locked account.');
    await type(field('Labels'), 'sme:identity');
    await type(field('Authorizations'), 'keycloak:otp-reset');
    expect(button(/Submit/)?.disabled).toBe(false);
    await act(async () => { button(/Submit/)!.click(); });
    await settle();
    expect(calls.find((c) => c.method === 'POST')).toEqual({
      method: 'POST', path: '/ui/api/direct-jobs',
      body: { title: 'Reset a one-time password', brief: 'Reset the one-time password of the locked account.', labels: ['sme:identity'], authorizations: ['keycloak:otp-reset'] },
    });
    expect(rows()[0]!.textContent).toContain('Reset a one-time password');
    expect(rows()[0]!.textContent).toContain('not queued yet');
    expect(field('Title')!.value).toBe('');
  });

  it('says why the form cannot be sent yet', async () => {
    await render();
    await type(field('Title'), 'Reset a one-time password');
    expect(document.body.textContent).toContain('Say what to do');
  });

  it('a viewer reads the list and gets no form', async () => {
    await render('viewer');
    expect(rows()).toHaveLength(2);
    expect(field('Title')).toBeNull();
  });

  it('says so when there are no direct jobs', async () => {
    await render('operator', []);
    expect(document.body.textContent).toContain('No direct jobs yet');
  });
});
