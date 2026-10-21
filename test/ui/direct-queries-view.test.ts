// @vitest-environment happy-dom
// Direct queries in the UI (issue #2184, part 2), a view of its own (#direct-queries), rendered against a fake of the
// daemon's HTTP: the list reads each question a caller asked the hopper straight back — where it stands, who asked it,
// its callback, its hints, its open questions (answered in Questions), its answer, its error and its evidence (the job's
// artifacts) —, an operator cancels one whose job is not at an end, and asks a question from the form. A viewer reads the
// list and sees no form and no cancel.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

type El = ReturnType<typeof createElement>;
let root: Root | undefined;
let calls: { method: string; path: string; body?: unknown }[] = [];

const base = { labels: ['direct:query'], authorizations: [], submittedBy: { person: 'grok', via: 'api' }, artifacts: [] };
const Q1 = {
  ...base, id: 'query-1', title: 'Which cluster runs the collector?', brief: 'Which cluster runs the collector?', submittedAt: '2026-10-19T10:00:00.000Z',
  query: { requestId: 'r-1', callback: 'grok-bot', repos: ['octo-org/infra'], clusters: ['prod'] }, state: 'waiting',
  job: { id: 'j1', status: 'waiting_answer', questions: [{ id: 'q1', text: 'Which cluster do you mean?', tier: 'human', askedAt: '2026-10-19T10:05:00.000Z' }] },
};
const Q0 = {
  ...base, id: 'query-0', title: 'Where does the otel collector run?', brief: 'Where does the otel collector run?', submittedAt: '2026-10-18T10:00:00.000Z',
  query: { requestId: 'r-0' }, state: 'answered', artifacts: [{ id: 'a1', title: 'Collector pods', kind: 'markdown', revision: 1, url: 'http://hopper.invalid/#artifacts/a1' }],
  job: { id: 'j0', status: 'finished', result: 'The otel-collector deployment in the observability namespace.', questions: [] },
};
const QF = { ...Q0, id: 'query-f', title: 'Restart the collector', query: { requestId: 'r-f' }, state: 'failed', artifacts: [], job: { id: 'jf', status: 'failed', error: 'the answer needs a change: file an issue', questions: [] } };
const QN = { ...base, id: 'query-n', title: 'Who owns the collector?', brief: 'Who owns the collector?', submittedAt: '2026-10-19T11:00:00.000Z', query: { requestId: 'ui-x' }, state: 'accepted' };

async function render(role: 'operator' | 'viewer' = 'operator', list: unknown[] = [Q1, Q0, QF]) {
  calls = [];
  let directQueries = list;
  localStorage.setItem('jh_session', 'a'.repeat(64));
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) as unknown : undefined;
    calls.push({ method: init.method ?? 'GET', path: String(path), ...(body !== undefined ? { body } : {}) });
    if (path === '/ui/api/direct-queries') { directQueries = [QN, ...directQueries]; return json({ directQuery: QN }); }
    if (String(path).endsWith('/cancel')) return json({ ok: true });
    return json({ directQueries });
  }));
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  const view = '../../ui/src/views/direct-queries.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const store = '../../ui/src/store/index.ts';
  const { useHopper } = (await import(store)) as { useHopper: { setState(s: Record<string, unknown>): void } };
  useHopper.setState({ authed: true, user: { id: 'u1', name: 'ada', role, realm: 'local', identity: 'ada' } });
  const { DirectQueries } = (await import(view)) as { DirectQueries: () => El };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(DirectQueries)); });
  await settle();
}

const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const rows = () => [...document.querySelectorAll('[data-slot="direct-query-row"]')];
const field = (label: string) => document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`);
const button = (in_: ParentNode, text: RegExp) => [...in_.querySelectorAll('button')].find((b) => text.test(b.textContent ?? ''));
const dialog = () => vi.waitFor(() => { const d = document.querySelector('[role="alertdialog"]'); expect(d).not.toBeNull(); return d!; });
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

describe('Direct queries', () => {
  it('reads each query back: where it stands, who asked it, its callback and hints, its question, its answer and evidence', async () => {
    await render();
    expect(calls[0]).toEqual({ method: 'GET', path: '/api/direct-queries' });
    expect(rows()).toHaveLength(3);
    const [waiting, answered, failed] = rows();
    expect(waiting!.textContent).toContain('Which cluster runs the collector?');
    expect(waiting!.textContent).toContain('waits on a question');
    expect(waiting!.textContent).toContain('Asked by grok with an API token');
    expect(waiting!.textContent).toContain('callback grok-bot');
    expect(waiting!.textContent).toContain('octo-org/infra');
    expect(waiting!.textContent).toContain('prod');
    expect(waiting!.textContent).toContain('Which cluster do you mean?');
    expect(waiting!.querySelector('a[href="#questions"]')).not.toBeNull();
    expect(waiting!.querySelector('a[href="#job/j1"]')).not.toBeNull();
    expect(answered!.textContent).toContain('answered');
    expect(answered!.querySelector('[data-slot="direct-query-answer"]')!.textContent).toContain('observability namespace');
    expect(answered!.querySelector('[data-slot="direct-query-evidence"] a[href="#artifacts/a1"]')!.textContent).toBe('Collector pods');
    expect(failed!.textContent).toContain('needs a change');
  });

  it('cancels a query whose job is not at an end, after a confirm', async () => {
    await render();
    expect(button(rows()[1]!, /^Cancel$/)).toBeUndefined();
    await act(async () => { button(rows()[0]!, /^Cancel$/)!.click(); });
    const d = await dialog();
    await act(async () => { [...d.querySelectorAll('button')].find((b) => b.textContent === 'Cancel query')!.click(); });
    await vi.waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toEqual([{ method: 'POST', path: '/ui/api/jobs/j1/cancel', body: {} }]));
  });

  it('asks a question from the form, with a new request id, and lists it', async () => {
    await render();
    expect(button(document, /Ask/)?.disabled).toBe(true);
    await type(field('Question'), 'Who owns the collector?');
    await type(field('Callback'), 'grok-bot');
    await type(field('Repositories'), 'octo-org/infra');
    await act(async () => { button(document, /Ask/)!.click(); });
    await settle();
    const sent = calls.find((c) => c.method === 'POST');
    expect(sent).toMatchObject({ path: '/ui/api/direct-queries', body: { question: 'Who owns the collector?', mode: 'look', callback: 'grok-bot', repos: ['octo-org/infra'], clusters: [] } });
    expect((sent!.body as { requestId: string }).requestId).toMatch(/^ui-[0-9a-f]{32}$/);
    expect(rows()[0]!.textContent).toContain('Who owns the collector?');
    expect(field('Question')!.value).toBe('');
  });

  it('a viewer reads the list and gets no form and no cancel', async () => {
    await render('viewer');
    expect(rows()).toHaveLength(3);
    expect(field('Question')).toBeNull();
    expect(button(rows()[0]!, /^Cancel$/)).toBeUndefined();
  });

  it('says so when there are no direct queries', async () => {
    await render('operator', []);
    expect(document.body.textContent).toContain('No questions yet');
  });
});
