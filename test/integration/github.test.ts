// The GitHub source end to end through the real daemon, against the in-memory fake GitHub at
// the GitHubApi seam (never the real one). Issues carry a scripted-executor op as their first
// body line (test/support/scripted-executor.ts). Syncs are driven with syncNow (pollSeconds is long).
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const REPO = 'owner/job-hopper-sandbox';
const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
});

function github(extra: Record<string, unknown> = {}) {
  return [{
    name: 'github', plugin: 'github-gh', options: {
      enabled: true, pollSeconds: 3600, repos: [REPO], authors: ['owner'], executor: 'scripted',
      defaultCwd: '/tmp', ...extra,
    },
  }];
}

async function boot(gh: FakeGitHub, o: { dbPath?: string; config?: Record<string, unknown>; env?: Record<string, string> } = {}) {
  let dbPath = o.dbPath;
  let plugins: Record<string, unknown> | undefined;
  if (!dbPath) {
    const db = tempDbPath();
    cleanup = db.cleanup;
    dbPath = db.dbPath;
    plugins = { jobSources: github(o.config) };
  }
  const a = await startTestApp({ dbPath, env: o.env ?? {}, seams: { github: gh }, ...(plugins ? { plugins } : {}) });
  apps.push(a);
  return a;
}

const body = (op: Record<string, unknown>, text = 'Please do the thing.') => `${JSON.stringify(op)}\n\n${text}`;
const jobFor = async (a: TestApp, url: string): Promise<Job | undefined> =>
  (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.find((j) => j.source?.key === url);

const bodies = (gh: FakeGitHub, n: number) => gh.commentsOn(REPO, n).map((c) => c.body);

describe('GitHub issue → job → issue', () => {
  it('ignores issues by authors outside the allowlist', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const issue = gh.createIssue({ repo: REPO, author: 'stranger', body: body({ op: 'echo' }), labels: ['hopper'] });
    await a.sync();
    expect(await jobFor(a, issue.url)).toBeUndefined();
    expect(gh.commentsOn(REPO, issue.number)).toEqual([]);
    expect(gh.issue(REPO, issue.number).labels).toEqual(['hopper']);
  });

  it('closing the issue cancels the running job without a comment; removing the label does too', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const closed = gh.createIssue({ repo: REPO, body: body({ op: 'sleep', ms: 10000 }), labels: ['hopper'] });
    const unlabelled = gh.createIssue({ repo: REPO, body: body({ op: 'sleep', ms: 10000 }), labels: ['hopper'] });
    await a.sync();
    const j1 = (await jobFor(a, closed.url))!;
    const j2 = (await jobFor(a, unlabelled.url))!;
    await a.waitForStatus(j1.id, 'running');
    gh.closeIssue(REPO, closed.number);
    gh.removeLabel(REPO, unlabelled.number, 'hopper');
    await a.sync();
    await a.waitForStatus(j1.id, 'cancelled');
    await a.waitForStatus(j2.id, 'cancelled');
    const reasons = (await a.events('types=job.cancelled')).map((e) => [e.jobId, e.data.reason]);
    expect(reasons).toEqual(expect.arrayContaining([[j1.id, 'issue closed'], [j2.id, 'label removed']]));
    await waitFor(() => !gh.issue(REPO, closed.number).labels.includes('hopper:claimed'), { what: 'claimed label removed' });
    await waitFor(() => !gh.issue(REPO, unlabelled.number).labels.includes('hopper:claimed'), { what: 'claimed label removed 2' });
    expect(bodies(gh, closed.number)).toEqual([]);
    expect(bodies(gh, unlabelled.number)).toEqual([]);
  });

  it('a failed job labels the issue hopper:failed, leaves no comment, and logs one line', async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args.join(' ')); });
    try {
      const gh = createFakeGitHub();
      const a = await boot(gh);
      const issue = gh.createIssue({ repo: REPO, body: body({ op: 'fail', message: 'boom' }), labels: ['hopper'] });
      await a.sync();
      const job = (await jobFor(a, issue.url))!;
      await a.waitForStatus(job.id, 'failed');
      await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:failed'), { what: 'failed label' });
      expect(gh.issue(REPO, issue.number).labels).not.toContain('hopper:claimed');
      expect(bodies(gh, issue.number)).toEqual([]);
      expect((await jobFor(a, issue.url))!.error).toBe('boom');
      expect(logged).toContain(`job-hopper: job ${job.id} failed (${issue.url}): boom`);
    } finally {
      spy.mockRestore();
    }
  });

  it('removing hopper:failed re-runs a failed issue once its failure was reported; the label is the only gate', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    // An empty body is an invalid item: the job is created and failed at once.
    const issue = gh.createIssue({ repo: REPO, body: '', labels: ['hopper'] });
    const jobsFor = async () => (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.filter((j) => j.source?.key === issue.url);
    await a.sync();
    await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:failed'), { what: 'hopper:failed' });
    const [first] = await jobsFor();
    expect(first).toMatchObject({ status: 'failed', sourceState: { sync: { finalReported: true } } });

    await a.sync();
    expect(await jobsFor()).toHaveLength(1); // hopper:failed still there: no new job

    gh.removeLabel(REPO, issue.number, 'hopper:failed'); // hopper:claimed stays on the issue
    await a.sync();
    await waitFor(async () => (await jobsFor()).length === 2, { what: 'second job' });
    const jobs = await jobsFor();
    expect(jobs.find((j) => j.id !== first!.id)).toMatchObject({ status: 'failed' });
    await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:failed'), { what: 'hopper:failed again' });
    await a.sync();
    expect(await jobsFor()).toHaveLength(2); // failed again, reported again: waits for the human
  });

  it('priority: label, project wins over label, and a re-sort on the next poll emits job.reprioritized', async () => {
    const gh = createFakeGitHub();
    const projects = { [REPO]: { owner: 'owner', number: 1, mode: 'field', field: 'Priority', map: { P0: 100, P1: 60 } } };
    const a = await boot(gh, { config: { projects } });
    a.setUsage(100);
    const labelled = gh.createIssue({ repo: REPO, body: body({ op: 'echo' }), labels: ['hopper', 'hopper:low'] });
    const both = gh.createIssue({ repo: REPO, body: body({ op: 'echo' }), labels: ['hopper', 'hopper:high'] });
    gh.setProjectItems('owner', 1, [{ url: both.url, fields: { priority: 'P1' } }]);
    await a.sync();
    const jl = (await jobFor(a, labelled.url))!;
    const jb = (await jobFor(a, both.url))!;
    expect(jl.priority).toBe(25);
    expect(jb.priority).toBe(60);

    gh.setProjectItems('owner', 1, [{ url: both.url, fields: { priority: 'P0' } }]);
    await a.sync();
    expect((await a.job(jb.id)).priority).toBe(100);
    const ev = (await a.events('types=job.reprioritized')).filter((e) => e.jobId === jb.id);
    expect(ev.map((e) => e.data)).toEqual([{ from: 60, to: 100, reason: 'project:Priority=P0' }]);
    expect((await a.api('GET', '/api/queue')).body.waiting.map((j: Job) => j.id)).toEqual([jb.id, jl.id]);
  });

  it('hopper:backburner: never picked up while set; a waiting job is cancelled; removing it takes the issue in again', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    a.setUsage(100);
    const parked = gh.createIssue({ repo: REPO, body: body({ op: 'echo' }), labels: ['hopper', 'hopper:backburner'] });
    const waiting = gh.createIssue({ repo: REPO, body: body({ op: 'echo' }), labels: ['hopper'] });
    await a.sync();
    expect(await jobFor(a, parked.url)).toBeUndefined();
    const job = (await jobFor(a, waiting.url))!;
    expect(['queued', 'held']).toContain(job.status);

    gh.addLabel(REPO, waiting.number, 'hopper:backburner');
    await a.sync();
    await waitFor(async () => (await a.job(job.id)).sourceState?.sync?.finalReported === true, { what: 'cancel reported' });
    expect(await a.job(job.id)).toMatchObject({ status: 'cancelled' });
    await a.sync();
    expect((await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs).toHaveLength(1);

    gh.removeLabel(REPO, parked.number, 'hopper:backburner');
    gh.removeLabel(REPO, waiting.number, 'hopper:backburner');
    await a.sync();
    expect(['queued', 'held']).toContain((await jobFor(a, parked.url))?.status);
    const jobs = (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.filter((j) => j.source?.key === waiting.url);
    expect(jobs.map((j) => j.status === 'cancelled' ? 'cancelled' : 'waiting').sort()).toEqual(['cancelled', 'waiting']);
    expect(gh.commentsOn(REPO, waiting.number)).toEqual([]);
  });

  it('a restart keeps sourced jobs deduped: the claimed issue is not ingested again', async () => {
    const gh = createFakeGitHub();
    const first = await boot(gh, { env: {} });
    first.setUsage(100);
    const issue = gh.createIssue({ repo: REPO, body: body({ op: 'echo' }), labels: ['hopper'] });
    await first.sync();
    const job = (await jobFor(first, issue.url))!;
    await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:claimed'));
    const dbPath = first.dbPath;
    await first.stop();

    const second = await boot(gh, { dbPath });
    await second.sync();
    const jobs = (await second.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=100')).body.jobs;
    expect(jobs.map((j) => j.id)).toEqual([job.id]);
    await second.waitForStatus(job.id, 'finished');
    await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:done'), { what: 'hopper:done' });
    expect(gh.commentsOn(REPO, issue.number)).toEqual([]);
    const gh2 = (await second.api('GET', '/api/sources')).body.sources.find((s: { name: string }) => s.name === 'github');
    expect(gh2).toMatchObject({ state: 'ok', kind: 'github' });
    expect(gh2.detail.skippedClaimedWithoutJob).toBeUndefined();
  });
});
