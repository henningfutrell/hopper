// @vitest-environment happy-dom
// Direct jobs in the UI (issue #901, part 2), rendered against a fake of the daemon's HTTP: the submit form sends a job
// straight to the hopper, with no GitHub issue; the list reads each direct job back with its job's state, its result,
// its error and its open questions. A viewer reads the list and sees no form. Issue #946: a finished direct job is offered
// for promotion, pinned at the top; the person previews it, edits it, confirms a public repository, and posts it.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

type El = ReturnType<typeof createElement>;
let root: Root | undefined;
let calls: { method: string; path: string; body?: unknown }[] = [];

const D1 = {
  id: 'd1', title: 'Unlock a sign-in', brief: 'Clear the lockout.', labels: ['sme:identity'], authorizations: ['keycloak:otp-reset'],
  submittedBy: { person: 'ada', via: 'ui' }, submittedAt: '2026-10-12T10:00:00.000Z', artifacts: [],
  job: { id: 'j1', status: 'waiting_answer', questions: [{ id: 'q1', text: 'Which account is locked?', tier: 'human', askedAt: '2026-10-12T10:05:00.000Z' }] },
};
const D0 = {
  id: 'd0', title: 'Look up a login', brief: 'Read the audit log.', labels: [], authorizations: [],
  submittedBy: { person: 'bob', via: 'api' }, submittedAt: '2026-10-11T10:00:00.000Z', artifacts: [],
  job: { id: 'j0', status: 'finished', result: 'Two failed logins, no lockout.', questions: [] },
};
const D2 = { ...D1, id: 'd2', title: 'Reset a one-time password', job: undefined };
const ART = { id: 'a1', title: 'Lockout timeline', summary: 'When each sign-in failed', kind: 'svg', revision: 1, url: 'http://hopper.invalid/#artifacts/a1', commit: { branch: 'hopper-promotion/d3', path: 'hopper-promotions/d3/a1-timeline.svg' } };
const D3 = { ...D0, id: 'd3', title: 'Why was a sign-in locked?', repo: 'octo-org/hello', artifacts: [ART], offer: 'suggested' };
const DRAFT = {
  repo: 'octo-org/hello', visibility: 'public', target: { kind: 'issue' }, title: 'Why was a sign-in locked?', body: 'Find out why.\n\n### Results\n\nTwo failed logins.',
  labels: ['sme:identity'], artifacts: [ART], includeRequester: false, footer: '### Artifacts\n\n- Lockout timeline', findings: [], notes: ['A revoke does not unpublish anything.'],
};
const PROMOTED = { ...D3, offer: undefined, promotion: { id: 'p1', directJobId: 'd3', repo: 'octo-org/hello', kind: 'issue', number: 3, url: 'https://github.invalid/octo-org/hello/issues/3', artifacts: [{ id: 'a1', title: 'Lockout timeline', revision: 1 }], promotedBy: 'ada', promotedAt: '2026-10-12T11:00:00.000Z', updatedAt: '2026-10-12T11:00:00.000Z', stale: ['a1'] } };

async function render(role: 'operator' | 'viewer' = 'operator', list: unknown[] = [D1, D0]) {
  calls = [];
  let directJobs = list;
  localStorage.setItem('jh_session', 'a'.repeat(64));
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) as unknown : undefined;
    calls.push({ method: init.method ?? 'GET', path: String(path), ...(body !== undefined ? { body } : {}) });
    if (path === '/ui/api/direct-jobs') { directJobs = [D2, ...directJobs]; return json({ directJob: D2 }); }
    if (String(path).endsWith('/promotion/preview')) return json(DRAFT);
    if (String(path).endsWith('/promotion')) { directJobs = directJobs.map((d) => ((d as { id: string }).id === 'd3' ? PROMOTED : d)); return json(PROMOTED.promotion); }
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
    // Issue #1169: the result is a code block with a wrap toggle and copy.
    expect(rows()[1]!.querySelector('[data-slot="direct-job-result"] [data-slot="code-block-copy-button"]')).not.toBeNull();
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
    expect(document.body.textContent).toContain('No jobs run here yet');
  });

  it('leaves the direct queries out: they have a view of their own (issue #2184)', async () => {
    await render('operator', [D1, { ...D0, id: 'query-1', title: 'Where does the collector run?', query: { requestId: 'r-1' }, state: 'answered' }]);
    expect(rows()).toHaveLength(1);
    expect(document.body.textContent).not.toContain('Where does the collector run?');
  });

  it('pins a direct job offered for promotion at the top; a person previews it, edits it, confirms the public repository and posts it', async () => {
    await render('operator', [D1, D3]);
    expect(rows()[0]!.textContent).toContain('Why was a sign-in locked?');
    expect(rows()[0]!.textContent).toContain('It made an artifact you may want to share');
    expect(rows()[0]!.querySelector('a[href="#artifacts/a1"]')).not.toBeNull();
    expect(rows()[1]!.querySelector('[data-slot="direct-job-promotion"]')).toBeNull();
    await act(async () => { button(/Promote to GitHub/)!.click(); });
    expect(field('Promote to repository')!.value).toBe('octo-org/hello');
    await act(async () => { button(/Preview/)!.click(); });
    await settle();
    expect(calls.find((c) => c.path.endsWith('/promotion/preview'))).toEqual({ method: 'POST', path: '/ui/api/direct-jobs/d3/promotion/preview', body: { repo: 'octo-org/hello', target: { kind: 'issue' } } });
    expect(field('Text to post')!.value).toContain('Two failed logins.');
    expect(document.body.textContent).toContain('A revoke does not unpublish anything.');
    expect(button(/Confirm and post/)?.disabled).toBe(true);
    expect(document.body.textContent).toContain('Confirm that the repository is public');
    await type(field('Text to post'), 'What we found.');
    expect((field('Commit Lockout timeline to hopper-promotion/d3') as HTMLInputElement).checked).toBe(false);
    await act(async () => { field('Commit Lockout timeline to hopper-promotion/d3')!.click(); });
    await act(async () => { field('Post to this public repository')!.click(); });
    expect(button(/Confirm and post/)?.disabled).toBe(false);
    await act(async () => { button(/Confirm and post/)!.click(); });
    await settle();
    expect(calls.find((c) => c.path === '/ui/api/direct-jobs/d3/promotion')?.body).toEqual({
      repo: 'octo-org/hello', target: { kind: 'issue' }, title: 'Why was a sign-in locked?', body: 'What we found.', labels: ['sme:identity'], artifacts: ['a1'], commit: ['a1'], confirmPublic: true,
    });
    const promoted = rows().find((r) => r.textContent?.includes('Why was a sign-in locked?'))!;
    expect(promoted.textContent).toContain('Promoted as issue octo-org/hello#3 · 1 artifact changed since');
    expect(promoted.textContent).toContain('stale');
    expect(promoted.textContent).toContain('Promote again');
  });
});
