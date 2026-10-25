// @vitest-environment happy-dom
// A job's kept delivery track on its job view (issue #2775), the panel rendered against a fake of GET /api/delivery-tracks:
// a job in progress shows the step it is in, since when and what it waits on; a completed job shows its deployment record.
// A person flips the deployment expectation from it (POST /ui/api/delivery-tracks/deploy|no-deploy) until a deployment
// completes: a delivered record is final and offers no flip; each flip is listed.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KeptTrack } from '../../src/domain/kept-tracks.ts';
import type { Job } from '../../src/domain/types.ts';

const PR = 'https://github.com/octo/shed/pull/11';
const steps = [
  { step: 'queued', start: '2026-10-20T08:00:00.000Z', end: '2026-10-20T08:05:00.000Z' },
  { step: 'coding', start: '2026-10-20T08:05:00.000Z', end: '2026-10-20T09:00:00.000Z' },
  { step: 'pr_checks', start: '2026-10-20T09:00:00.000Z', end: '2026-10-20T09:20:00.000Z' },
  { step: 'landing', start: '2026-10-20T09:20:00.000Z', end: '2026-10-20T09:20:00.000Z' },
  { step: 'landing_checks', start: '2026-10-20T09:20:00.000Z' },
] as KeptTrack['steps'];
const OPEN: KeptTrack = {
  jobId: 'j1', repo: 'octo/shed', issue: 'octo/shed#7', pullRequest: PR, marks: { queued: steps[0]!.start }, steps, state: 'open',
  current: { step: 'landing_checks', since: '2026-10-20T09:20:00.000Z', blocker: 'ci_red', waitingOn: 'a green run of the checks on the landing branch that carries it (a batch run for the hopper)' },
};
const DELIVERED: KeptTrack = {
  ...OPEN, state: 'closed', closedAt: '2026-10-20T14:00:00.000Z', current: { step: 'production', since: '2026-10-20T13:00:00.000Z', blocker: 'rollout_failed', waitingOn: 'the release to production' },
  deployment: { jobId: 'j1', repo: 'octo/shed', at: '2026-10-20T14:00:00.000Z', kind: 'deploy', artifact: { pullRequest: PR }, target: 'production', expected: 'delivered', observed: steps },
};
const RESEARCH: KeptTrack = {
  ...OPEN, pullRequest: undefined, state: 'closed', closedAt: '2026-10-20T08:30:00.000Z',
  deployment: { jobId: 'j1', repo: 'octo/shed', at: '2026-10-20T08:30:00.000Z', kind: 'none', source: 'octo/shed#7', outcome: { status: 'finished', report: 'research' } },
};
const job = { id: 'j1', status: 'finished' } as Job;

let root: Root | undefined;
const posts: { path: string; body: unknown }[] = [];

async function boot(tracks: KeptTrack[]) {
  localStorage.setItem('jh_session', 'a'.repeat(64));
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  posts.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    if (init?.method === 'POST') { posts.push({ path: String(input), body: JSON.parse(String(init.body)) }); return json(tracks[0] ?? {}); }
    return json(String(input) === '/api/delivery-tracks?job=j1' ? { tracks } : {});
  }));
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  vi.resetModules();
  // Imported by a path in a variable: the UI's modules are typed by the UI's own tsconfig, not this one.
  const store = '../../ui/src/store/index.ts';
  const path = '../../ui/src/views/job-delivery.tsx';
  const { useHopper } = (await import(store)) as { useHopper: { setState(s: unknown): void } };
  useHopper.setState({ authed: true, user: { role: 'viewer', realm: 'local', name: 'someone' } });
  const { JobDelivery } = (await import(path)) as { JobDelivery: (p: { job: Job }) => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(JobDelivery, { job })); });
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const text = (slot: string) => document.querySelector(`[data-slot="${slot}"]`)?.textContent ?? '';

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('a job\'s delivery on its job view', () => {
  it('a job in progress shows the step it is in, since when, and what it waits on', async () => {
    await boot([OPEN]);
    expect(text('job-delivery-current')).toContain('Landing checks');
    expect(document.querySelector('[data-slot="job-delivery-current"] [title]')?.getAttribute('title')).toBe('2026-10-20T09:20:00.000Z');
    expect(text('job-delivery-waits')).toContain('a green run of the checks on the landing branch');
    expect(document.querySelectorAll('[data-slot="job-delivery-step"]')).toHaveLength(5);
    expect(text('job-delivery-record')).toBe('');
  });

  it('a completed job shows its deployment record: delivered, with its pull request', async () => {
    await boot([DELIVERED]);
    expect(text('job-delivery-record')).toContain('Delivered to production');
    expect(document.querySelector('[data-slot="job-delivery-record"] a')?.getAttribute('href')).toBe(PR);
    expect(text('job-delivery-waits')).toBe('');
  });

  it('a research job shows no deployment expected, with its source and outcome', async () => {
    await boot([RESEARCH]);
    expect(text('job-delivery-record')).toContain('No deployment expected');
    expect(text('job-delivery-record')).toContain('octo/shed#7');
    expect(text('job-delivery-record')).toContain('research');
  });

  it('a job in progress offers the no-deploy mark and the flip to deploy; a click posts it for the job', async () => {
    await boot([OPEN]);
    const button = (slot: string) => document.querySelector<HTMLButtonElement>(`[data-slot="${slot}"]`);
    expect(button('job-delivery-no-deploy')).not.toBeNull();
    expect(button('job-delivery-deploy')).not.toBeNull();
    await act(async () => { button('job-delivery-no-deploy')!.click(); await new Promise((r) => setTimeout(r, 0)); });
    expect(posts).toEqual([{ path: '/ui/api/delivery-tracks/no-deploy', body: { job: 'j1' } }]);
  });

  it('a delivered record is final: it offers no flip and says so', async () => {
    await boot([DELIVERED]);
    expect(document.querySelector('[data-slot="job-delivery-no-deploy"]')).toBeNull();
    expect(document.querySelector('[data-slot="job-delivery-deploy"]')).toBeNull();
    expect(text('job-delivery-record')).toContain('final');
  });

  it('a none record stays open to a flip to deploy, and lists each flip', async () => {
    const flips: KeptTrack['expectations'] = [{ expect: 'deploy', by: 'release-owner', at: '2026-10-20T08:10:00.000Z' }, { expect: 'none', by: 'release-owner', at: '2026-10-20T08:20:00.000Z', note: 'not now' }];
    await boot([{ ...RESEARCH, expectations: flips }]);
    expect(document.querySelector('[data-slot="job-delivery-deploy"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="job-delivery-no-deploy"]')).toBeNull();
    const listed = [...document.querySelectorAll('[data-slot="job-delivery-expectation"]')].map((e) => e.textContent ?? '');
    expect(listed).toHaveLength(2);
    expect(listed[0]).toContain('deploy');
    expect(listed[1]).toContain('not now');
  });

  it('says so when the job has no kept track yet', async () => {
    await boot([]);
    expect(text('job-delivery-none')).toContain('No delivery track');
  });
});
