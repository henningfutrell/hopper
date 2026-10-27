// @vitest-environment happy-dom
// Grades in the UI (issue #2845), each view rendered against a fake of the daemon's grade routes: a job's Grade panel on
// its job view — the automatic grade with its breakdown, the user grade with its history, the disagreement, and the form
// an operator grades with —, the Grades tab of Jobs — the rollup by the group picked and the graded jobs —, and the grade
// settings in Settings, an admin's.
//
// Feature: Grades in the UI
//   Scenario: an ended job's Grade panel shows its automatic grade, user grade, history and disagreement
//   Scenario: an operator grades a job: Save posts the score and the note, and the panel shows the answer
//   Scenario: a viewer reads the grades and gets no form; a running job shows no panel
//   Scenario: the Grades tab rolls up by the group picked and lists the graded jobs
//   Scenario: the grade settings save only what changed
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_GRADE_SETTINGS, type GradesView, type JobGradeView } from '../../src/domain/grades.ts';
import type { Job } from '../../src/domain/types.ts';

const T = '2026-10-26T12:30:00.000Z';
const GRADED: JobGradeView = {
  jobId: 'j1',
  grade: {
    jobId: 'j1', endedAt: T, executor: 'herdr-claude', model: 'claude-opus-5-5', repo: 'o/r', kind: 'code', gradedAt: T,
    auto: { score: 82, lines: [
      { signal: 'outcome', value: 1, weight: 3, why: 'finished' },
      { signal: 'pull_request', value: 0, weight: 3, why: 'merged, then reverted by https://github.com/o/r/pull/9' },
    ] },
  },
  user: { score: 1, note: 'broke main', by: 'someone', at: T },
  history: [{ score: 1, note: 'broke main', by: 'someone', at: T }, { score: 4, by: 'someone', at: '2026-10-26T10:00:00.000Z' }],
  disagree: true,
};
const ROLLUP: GradesView = {
  by: 'executor', total: { jobs: 3, auto: 70, userGraded: 1, user: 4, disagreements: 0 },
  groups: [{ key: 'herdr-claude', jobs: 2, auto: 80, userGraded: 1, user: 4, disagreements: 0 }, { key: 'opencode', jobs: 1, auto: 50, userGraded: 0, disagreements: 0 }],
  jobs: [{ jobId: 'j1', endedAt: T, executor: 'herdr-claude', repo: 'o/r', kind: 'code', auto: 82, user: 4 }],
};

let calls: { method: string; path: string; body?: unknown }[] = [];
let root: Root | undefined;

function fakeDaemon(answers: Record<string, unknown>) {
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  return vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = String(input);
    calls.push({ method: init.method ?? 'GET', path, ...(init.body ? { body: JSON.parse(String(init.body)) as unknown } : {}) });
    const key = `${init.method ?? 'GET'} ${path.split('?')[0]}`;
    return json(key in answers ? answers[key] : {});
  });
}

async function render(module: string, name: string, props: object, answers: Record<string, unknown>, role = 'operator') {
  calls = [];
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  vi.stubGlobal('fetch', fakeDaemon(answers));
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  vi.resetModules();
  // Imported by a path in a variable: the UI's modules are typed by the UI's own tsconfig, not this one.
  const store = '../../ui/src/store/index.ts';
  const { useHopper } = (await import(store)) as { useHopper: { setState(s: unknown): void } };
  useHopper.setState({ authed: true, user: { role, realm: 'local', name: 'someone' } });
  const m = (await import(module)) as Record<string, (p: object) => ReturnType<typeof createElement>>;
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(m[name]!, props)); });
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const texts = (slot: string) => [...document.querySelectorAll(`[data-slot="${slot}"]`)].map((e) => e.textContent ?? '');
const button = (text: RegExp) => [...document.querySelectorAll('button')].find((b) => text.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el) as object, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

const JOB_GRADE = '../../ui/src/views/job-grade.tsx';
const finished = { id: 'j1', status: 'finished' } as Job;

describe('a job\'s Grade panel on its job view', () => {
  it('shows the automatic grade with its breakdown, the user grade, its history and the disagreement', async () => {
    await render(JOB_GRADE, 'JobGrade', { job: finished }, { 'GET /api/jobs/j1/grade': GRADED });
    expect(texts('grade-score')).toEqual(['82']);
    expect(texts('grade-line')).toEqual([
      'Outcome: finished (100 of 100, weight 3)',
      'Pull request: merged, then reverted by https://github.com/o/r/pull/9 (0 of 100, weight 3)',
    ]);
    expect(texts('grade-user')).toEqual(['1 of 5 by someone, 2026-10-26 12:30 UTC: broke main']);
    expect(texts('grade-history')).toEqual(['4 of 5 by someone, 2026-10-26 10:00 UTC']);
    expect(texts('grade-disagree')).toEqual(['The user grade and the automatic grade disagree.']);
  });

  it('Save posts the score and the note, and the panel shows the answer', async () => {
    await render(JOB_GRADE, 'JobGrade', { job: finished }, {
      'GET /api/jobs/j1/grade': { jobId: 'j1', history: [] },
      'POST /ui/api/jobs/j1/grade': { jobId: 'j1', user: { score: 5, note: 'clean', by: 'someone', at: T }, history: [{ score: 5, note: 'clean', by: 'someone', at: T }] },
    });
    expect(texts('grade-none')).toEqual(['Not graded yet: the hopper grades a job a minute after it ends.']);
    expect(button(/^Save$/)!.disabled).toBe(true);
    await act(async () => { button(/^5$/)!.click(); });
    await type(document.querySelector<HTMLTextAreaElement>('[data-slot="grade-note"]')!, ' clean ');
    await act(async () => { button(/^Save$/)!.click(); });
    await vi.waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toEqual([{ method: 'POST', path: '/ui/api/jobs/j1/grade', body: { score: 5, note: 'clean' } }]));
    await vi.waitFor(() => expect(texts('grade-user')).toEqual(['5 of 5 by someone, 2026-10-26 12:30 UTC: clean']));
  });

  it('a viewer reads the grades and gets no form', async () => {
    await render(JOB_GRADE, 'JobGrade', { job: finished }, { 'GET /api/jobs/j1/grade': GRADED }, 'viewer');
    expect(texts('grade-score')).toEqual(['82']);
    expect(document.querySelector('[data-slot="grade-note"]')).toBeNull();
    expect(button(/^Save$/)).toBeUndefined();
  });

  it('a running job shows no panel', async () => {
    await render(JOB_GRADE, 'JobGrade', { job: { id: 'j1', status: 'running' } as Job }, { 'GET /api/jobs/j1/grade': { jobId: 'j1', history: [] } });
    expect(document.body.textContent).not.toContain('Grade');
  });
});

describe('the Grades tab of Jobs', () => {
  it('rolls up by the group picked and lists the graded jobs, each linked to its job view', async () => {
    await render('../../ui/src/views/grades.tsx', 'Grades', {}, { 'GET /api/grades': ROLLUP });
    expect(calls.filter((c) => c.path.startsWith('/api/grades')).map((c) => c.path)).toEqual(['/api/grades?by=executor']);
    expect(texts('grades-total')).toEqual(['3 graded jobs, mean automatic grade 70, 1 graded by a person (mean 4 of 5), 0 disagree']);
    expect(texts('grades-group')).toEqual(['herdr-claude2 jobs8014 of 50', 'opencode1 job500—0']);
    const job = document.querySelector<HTMLAnchorElement>('[data-slot="grades-job"] a')!;
    expect(job.getAttribute('href')).toBe('#job/j1');
    await act(async () => { button(/^Repository$/)!.click(); });
    await vi.waitFor(() => expect(calls.map((c) => c.path)).toContain('/api/grades?by=repo'));
  });
});

describe('the grade settings in Settings', () => {
  it('saves only what changed', async () => {
    await render('../../ui/src/views/grade-settings.tsx', 'GradeSettingsView', {}, {
      'GET /api/grades/settings': DEFAULT_GRADE_SETTINGS,
      'POST /ui/api/grades/settings': { ...DEFAULT_GRADE_SETTINGS, weights: { ...DEFAULT_GRADE_SETTINGS.weights, cost: 0 } },
    }, 'admin');
    expect(texts('grade-settings-summary')).toEqual(['Grade-aware routing is off: grades are kept and shown, and intake does not read them.']);
    expect(button(/^Save$/)!.disabled).toBe(true);
    await type(document.querySelector<HTMLInputElement>('input[aria-label="Weight of Cost"]')!, '0');
    await act(async () => { button(/^Save$/)!.click(); });
    await vi.waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toEqual([{ method: 'POST', path: '/ui/api/grades/settings', body: { weights: { cost: 0 } } }]));
  });
});
