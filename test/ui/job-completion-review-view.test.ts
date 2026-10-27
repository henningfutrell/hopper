// @vitest-environment happy-dom
// A job's completion review on its job view (issue #2846), the panel rendered against a fake of
// GET /api/jobs/:id/completion-review: its end and length, its stages, what went well, where it stalled, its restarts, waste
// signals and suggestions. A job with no review shows no panel.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CompletionReview } from '../../src/domain/completion-review.ts';
import type { Job } from '../../src/domain/types.ts';

const REVIEW: CompletionReview = {
  jobId: 'j1', outcome: 'failed', reviewedAt: '2026-10-26T12:00:00.000Z', durationMs: 120 * 60_000, jobs: 3, questions: 3,
  stages: [{ stage: 'queued', ms: 42 * 60_000 }, { stage: 'running', ms: 41 * 60_000 }, { stage: 'person', ms: 35 * 60_000 }, { stage: 'parked', ms: 2 * 60_000 }],
  went: [], stalls: ['Waited for a lane 42 min.', 'Its work item took 3 jobs.'],
  restarts: [{ kind: 'preempted', count: 2, causes: ['a waits'] }],
  waste: [{ kind: 'failing_tests', why: '6 test runs failed.' }],
  suggestions: [{ area: 'lane', text: 'It waited 42 min for a lane: add a lane or a machine, or give its jobs a higher priority.' }],
};
const job = { id: 'j1', status: 'failed' } as Job;

let root: Root | undefined;

async function boot(answer: unknown) {
  localStorage.setItem('jh_session', 'a'.repeat(64));
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', vi.fn(async (input: string) => json(String(input) === '/api/jobs/j1/completion-review' ? answer : {})));
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  vi.resetModules();
  // Imported by a path in a variable: the UI's modules are typed by the UI's own tsconfig, not this one.
  const store = '../../ui/src/store/index.ts';
  const path = '../../ui/src/views/job-completion-review.tsx';
  const { useHopper } = (await import(store)) as { useHopper: { setState(s: unknown): void } };
  useHopper.setState({ authed: true, user: { role: 'viewer', realm: 'local', name: 'someone' } });
  const { JobCompletionReview } = (await import(path)) as { JobCompletionReview: (p: { job: Job }) => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(JobCompletionReview, { job })); });
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const texts = (slot: string) => [...document.querySelectorAll(`[data-slot="${slot}"]`)].map((e) => e.textContent ?? '');

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('a job\'s completion review on its job view', () => {
  it('shows its end, its stages, its stalls, restarts, waste signals and suggestions', async () => {
    await boot({ review: REVIEW });
    expect(texts('completion-review-head')[0]).toBe('Failed after 2 h · job of a work item that took 3 jobs');
    expect(texts('completion-review-stage')).toEqual(['Waiting for a lane: 42 min', 'Running: 41 min', 'Waiting on a person: 35 min', 'Parked: 2 min']);
    expect(texts('completion-review-went')).toEqual([]);
    expect(texts('completion-review-stall')).toEqual(['Waited for a lane 42 min.', 'Its work item took 3 jobs.']);
    expect(texts('completion-review-restart')).toEqual(['Preempted 2 times: a waits']);
    expect(texts('completion-review-waste')).toEqual(['Failing tests: 6 test runs failed.']);
    expect(texts('completion-review-suggestion')).toEqual(['Lanes: It waited 42 min for a lane: add a lane or a machine, or give its jobs a higher priority.']);
  });

  it('shows nothing for a job with no review', async () => {
    await boot({});
    expect(document.body.textContent).not.toContain('Completion review');
  });
});
