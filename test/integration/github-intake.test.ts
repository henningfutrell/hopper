// Issue #440, end to end through the real daemon against the in-memory fake GitHub at the GitHubApi seam.
// Every open labelled issue in the source's scope shows on /api/sources as taken (with its job) or with one
// reason; the intake migration moves an install whose issues predate assignee intake and claim holders to the
// current rules, once, across restarts; the user assigns or releases from Sources; repos outside the job
// repositories with work for the user are suggested, never added; a waiting job and an idle lane say why.
import { afterEach, describe, expect, it } from 'vitest';
import type { Decision, DomainEvent, Job } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { connectGitHub } from '../support/github-account.ts';
import { waitFor } from '../support/wait.ts';

const REPO = 'owner/hopper-sandbox';
const THEIRS = 'hopper:held-by:0f0f0f0f0f0f';
const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
});

async function boot(gh: FakeGitHub, dbPath?: string) {
  let path = dbPath;
  if (!path) {
    const db = tempDbPath();
    cleanup = db.cleanup;
    path = db.dbPath;
  }
  const plugins = {
    machines: lanes(2),
    jobSources: [{ name: 'github', plugin: 'github-account', options: { enabled: true, pollSeconds: 3600, executor: 'scripted', defaultCwd: '/tmp' } }],
  };
  const a = await startTestApp({ dbPath: path, env: {}, seams: { github: gh }, ...(dbPath ? {} : { plugins }) });
  apps.push(a);
  connectGitHub(a, [REPO]);
  return a;
}

const body = (op: Record<string, unknown>) => `${JSON.stringify(op)}\n\nPlease do the thing.`;
const sleepy = body({ op: 'sleep', ms: 60000 });
const jobsFor = async (a: TestApp, url: string): Promise<Job[]> =>
  (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.filter((j) => j.source?.key === url);
interface Outcome { key: string; reason?: string; action?: string; jobId?: string }
const detail = async (a: TestApp) => (await a.api('GET', '/api/sources')).body.sources.find((s: { name: string }) => s.name === 'github').detail;
const intake = async (a: TestApp): Promise<Record<string, Outcome>> =>
  Object.fromEntries(((await detail(a)).intake as Outcome[]).map((x) => [x.key, x]));
const ofType = (events: DomainEvent[], type: string) => events.filter((e) => e.type === type);
const review = async (a: TestApp) => a.ui('/ui/api/queue-gate', { mode: 'review', autoAcceptPerHour: null }, { token: await a.login() });

/** An install from before assignee intake and claim holders: an unassigned labelled issue, a claim with no job, another hopper's claim. */
function fixture(gh: FakeGitHub) {
  return {
    unassigned: gh.createIssue({ repo: REPO, assignees: [], body: sleepy, labels: ['hopper'] }),
    stale: gh.createIssue({ repo: REPO, body: sleepy, labels: ['hopper', 'hopper:claimed'] }),
    theirs: gh.createIssue({ repo: REPO, body: sleepy, labels: ['hopper', 'hopper:claimed', THEIRS] }),
    parked: gh.createIssue({ repo: REPO, body: sleepy, labels: ['hopper', 'hopper:backburner'] }),
  };
}

describe('intake outcomes and the intake migration (issue #440)', () => {
  it('migrates an install once, across restarts: a claim with no holder and no job is released and taken, every change listed', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    await review(a);
    const i = fixture(gh);
    await a.sync();

    const [job] = await jobsFor(a, i.stale.url);
    expect(job).toBeDefined();
    await waitFor(() => gh.issue(REPO, i.stale.number).labels.some((l) => l.startsWith('hopper:held-by:')), { what: 'the claim names its holder' });
    expect(gh.issue(REPO, i.theirs.number).labels).toEqual(['hopper', 'hopper:claimed', THEIRS]);
    expect(await jobsFor(a, i.theirs.url)).toEqual([]);

    const outcomes = await intake(a);
    expect(outcomes[i.unassigned.url]).toMatchObject({ reason: 'not assigned to you', action: 'assign' });
    expect(outcomes[i.stale.url]).toMatchObject({ jobId: job!.id });
    expect(outcomes[i.stale.url]!.reason).toBeUndefined();
    expect(outcomes[i.theirs.url]).toMatchObject({ reason: 'claimed by another hopper', action: 'release' });
    expect(outcomes[i.parked.url]).toMatchObject({ reason: 'on the backburner' });
    const changes = [
      { key: i.stale.url, change: 'released a claim with no holder recorded and no job in this hopper' },
      { key: i.unassigned.url, change: 'not assigned to you: assign it to you to take it' },
    ];
    expect((await detail(a)).intakeMigration).toMatchObject({ changes });

    const events = await a.events();
    expect(ofType(events, 'source.intake_migrated').map((e) => e.data)).toEqual([{ source: 'github', changes }]);
    expect(ofType(events, 'source.claim_released').map((e) => e.data)).toEqual([{
      source: 'github', key: i.stale.url, by: 'migration', reason: 'claimed before claims named their holder, with no job in this hopper',
    }]);

    await a.sync();
    const dbPath = a.dbPath;
    await a.stop();
    const b = await boot(gh, dbPath);
    await b.sync();
    expect(ofType(await b.events(), 'source.intake_migrated')).toHaveLength(1);
    expect(await jobsFor(b, i.stale.url)).toHaveLength(1);
    expect((await intake(b))[i.theirs.url]).toMatchObject({ reason: 'claimed by another hopper' });
  });

  it('Assign to me and Release claim from Sources: the issues are taken at once; others are refused with why', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    await review(a);
    const i = fixture(gh);
    await a.sync();
    const token = await a.login();

    const assigned = await a.ui('/ui/api/sources/github/intake', { kind: 'assign', keys: [i.unassigned.url, i.parked.url] }, { token });
    expect(assigned).toEqual({ status: 200, body: { done: [i.unassigned.url], failed: { [i.parked.url]: 'not offered: on the backburner' } } });
    expect(gh.issue(REPO, i.unassigned.number).assignees).toEqual(['owner']);
    expect(await jobsFor(a, i.unassigned.url)).toHaveLength(1);

    const released = await a.ui('/ui/api/sources/github/intake', { kind: 'release', keys: [i.theirs.url] }, { token });
    expect(released).toEqual({ status: 200, body: { done: [i.theirs.url], failed: {} } });
    expect(await jobsFor(a, i.theirs.url)).toHaveLength(1);
    await waitFor(() => !gh.issue(REPO, i.theirs.number).labels.includes(THEIRS), { what: 'the other holder label gone' });

    const events = await a.events();
    expect(ofType(events, 'source.issues_assigned').map((e) => e.data)).toEqual([{ source: 'github', keys: [i.unassigned.url], assignee: 'owner' }]);
    expect(ofType(events, 'source.claim_released').map((e) => e.data.by)).toEqual(['migration', 'user']);

    expect((await a.ui('/ui/api/sources/nope/intake', { kind: 'assign', keys: ['x'] }, { token })).status).toBe(404);
    expect((await a.ui('/ui/api/sources/github/intake', { kind: 'assign', keys: [i.unassigned.url] })).status).toBe(403);
  });

  it('suggests a repo outside the job repositories with open labelled issues for the user, and does not add it', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const elsewhere = gh.createIssue({ repo: 'owner/elsewhere', body: sleepy, labels: ['hopper'] });
    await a.sync();
    expect((await detail(a)).outsideRepos).toEqual([{ repo: 'owner/elsewhere', items: [elsewhere.url] }]);
    expect(a.user().store.settings.getJobRepositories('github')).toEqual([REPO]);
    expect(await jobsFor(a, elsewhere.url)).toEqual([]);
  });

  it('a waiting job and the idle lanes say why nothing runs', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    await review(a);
    const issue = gh.createIssue({ repo: REPO, body: sleepy, labels: ['hopper'] });
    await a.sync();
    const [job] = await jobsFor(a, issue.url);
    const held = await waitFor(async () => { const j = await a.job(job!.id); return j.holdReason ? j : undefined; }, { what: 'a hold reason' });
    expect(held.holdReason).toBe('awaiting acceptance');
    const latest = await waitFor(async () => {
      const { decisions } = (await a.api<{ decisions: Decision[] }>('GET', '/api/decisions?limit=1')).body;
      return decisions[0]?.hold.some((h) => h.jobId === job!.id) ? decisions[0] : undefined;
    }, { what: 'a decision holding the job' });
    expect(latest.lanes.find((l) => l.machineId === 'local')?.idle).toBe('every waiting job is held: awaiting acceptance (1 job)');
  });
});
