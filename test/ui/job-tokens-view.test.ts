// @vitest-environment happy-dom
// A job's token use on its job view (issue #2302), the panel rendered against a fake of GET /api/jobs/:id/tokens: its
// totals and estimated cost, then one row per model, then its waste signals (part 4). A job with no session read says so.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import type { JobTokenView } from '../../src/domain/token-usage.ts';

const totals = { turns: 12, input: 1500, output: 25_000, cacheRead: 2_400_000, cacheWrite: 180_000, costUsd: 2.5, costKnown: true };
const VIEW: JobTokenView = {
  jobId: 'j1', total: totals, sessions: 1, machines: ['m1'], accounts: ['someone@example.com'], first: '2026-10-21T08:00:00.000Z', last: '2026-10-21T09:00:00.000Z',
  models: [{ model: 'claude-opus-5-5', ...totals, costUsd: 2.4 }, { model: 'claude-haiku-4-5', ...totals, turns: 2, costUsd: 0.1 }],
};
const WASTEFUL: JobTokenView = { ...VIEW, total: { ...totals, failedTests: 6 }, waste: [{ kind: 'failing_tests', why: '6 test runs failed.' }, { kind: 'resume_loop', why: 'Started 7 times: it resumed or started again many times.' }] };
const NONE: JobTokenView = { jobId: 'j1', total: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, costKnown: true }, sessions: 0, models: [], machines: [], accounts: [] };
const job = { id: 'j1', status: 'finished' } as Job;

let root: Root | undefined;

async function boot(view: JobTokenView) {
  localStorage.setItem('jh_session', 'a'.repeat(64));
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', vi.fn(async (input: string) => json(String(input) === '/api/jobs/j1/tokens' ? view : {})));
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  vi.resetModules();
  // Imported by a path in a variable: the UI's modules are typed by the UI's own tsconfig, not this one.
  const store = '../../ui/src/store/index.ts';
  const path = '../../ui/src/views/job-tokens.tsx';
  const { useHopper } = (await import(store)) as { useHopper: { setState(s: unknown): void } };
  useHopper.setState({ authed: true, user: { role: 'viewer', realm: 'local', name: 'someone' } });
  const { JobTokens } = (await import(path)) as { JobTokens: (p: { job: Job }) => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(JobTokens, { job })); });
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const text = (slot: string) => document.querySelector(`[data-slot="${slot}"]`)?.textContent ?? '';

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('a job\'s token use on its job view', () => {
  it('shows its totals and estimated cost, then each model', async () => {
    await boot(VIEW);
    expect(text('job-tokens-total')).toContain('$2.50');
    expect(text('job-tokens-total')).toContain('12 turns');
    expect(text('job-tokens-total')).toContain('2.4M cache read');
    const models = [...document.querySelectorAll('[data-slot="job-tokens-model"]')].map((r) => r.textContent ?? '');
    expect(models).toHaveLength(2);
    expect(models[0]).toContain('claude-opus-5-5');
    expect(models[0]).toContain('$2.40');
  });

  it('shows no waste signal for a job that has none', async () => {
    await boot(VIEW);
    expect(document.querySelectorAll('[data-slot="job-tokens-waste"]')).toHaveLength(0);
  });

  it('shows its failed test runs and each waste signal with why (part 4)', async () => {
    await boot(WASTEFUL);
    expect(text('job-tokens-total')).toContain('6 failed test runs');
    const waste = [...document.querySelectorAll('[data-slot="job-tokens-waste"]')].map((r) => r.textContent ?? '');
    expect(waste).toEqual(['Failing tests: 6 test runs failed.', 'Resume loop: Started 7 times: it resumed or started again many times.']);
  });

  it('says so when no agent session of it was read', async () => {
    await boot(NONE);
    expect(text('job-tokens-none')).toContain('No token use read');
  });
});
