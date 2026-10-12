// Issue #798, end to end through the real daemon against the fake GitHub at its seam: every issue not taken carries its
// not-taken group (a request, not assigned to you, on the backburner, its pull request waits, partly done, other), so the
// UI groups and counts them; Take off the backburner removes the label from Sources and the issue is taken at once; a new
// request card records `source.request_opened` once for its text, across syncs and restarts; a taken issue carries its
// job's status now, not as of the last sync.
import { afterEach, describe, expect, it } from 'vitest';
import type { IntakeOutcome } from '../../src/domain/intake.ts';
import type { Job } from '../../src/domain/types.ts';
import { TERMINAL_STATUSES } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { connectGitHub } from '../support/github-account.ts';
import { waitFor } from '../support/wait.ts';

const REPO = 'owner/hopper-sandbox';
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
    jobSources: [{ name: 'github', plugin: 'github-account', options: { enabled: true, pollSeconds: 3600, executor: 'scripted' } }],
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
const intake = async (a: TestApp): Promise<Record<string, IntakeOutcome>> =>
  Object.fromEntries(((await a.api('GET', '/api/sources')).body.sources.find((s: { name: string }) => s.name === 'github').detail.intake as IntakeOutcome[]).map((x) => [x.key, x]));
const review = async (a: TestApp) => a.ui('/ui/api/queue-gate', { mode: 'review', autoAcceptPerHour: null }, { token: await a.login() });

describe('issues not taken, grouped and acted on (issue #798)', () => {
  it('each issue not taken names its group', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    await review(a);
    const i = {
      unassigned: gh.createIssue({ repo: REPO, assignees: [], body: sleepy, labels: ['hopper'] }),
      backburner: gh.createIssue({ repo: REPO, body: sleepy, labels: ['hopper', 'hopper:backburner'] }),
      prReady: gh.createIssue({ repo: REPO, body: sleepy, labels: ['hopper', 'hopper:pr-ready'] }),
      partly: gh.createIssue({ repo: REPO, body: sleepy, labels: ['hopper', 'hopper:partly-done'] }),
      failed: gh.createIssue({ repo: REPO, body: sleepy, labels: ['hopper', 'hopper:failed'] }),
      stranger: gh.createIssue({ repo: REPO, author: 'stranger', body: sleepy, labels: ['hopper'] }),
      taken: gh.createIssue({ repo: REPO, body: sleepy, labels: ['hopper'] }),
    };
    await a.sync();
    const o = await intake(a);
    expect(o[i.unassigned.url]).toMatchObject({ group: 'not-assigned', action: 'assign' });
    expect(o[i.backburner.url]).toMatchObject({ group: 'backburner', action: 'unbackburner', reason: 'on the backburner' });
    expect(o[i.prReady.url]).toMatchObject({ group: 'pr-waiting' });
    expect(o[i.partly.url]).toMatchObject({ group: 'partly-done' });
    expect(o[i.failed.url]).toMatchObject({ group: 'other' });
    expect(o[i.stranger.url]).toMatchObject({ group: 'request', action: 'approve' });
    expect(o[i.taken.url]!.group).toBeUndefined();
  });

  it('Take off the backburner removes the label, records it, and the issue is taken at once', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    await review(a);
    const parked = gh.createIssue({ repo: REPO, body: sleepy, labels: ['hopper', 'hopper:backburner'] });
    const assigned = gh.createIssue({ repo: REPO, assignees: [], body: sleepy, labels: ['hopper'] });
    await a.sync();
    const token = await a.login();

    const r = await a.ui('/ui/api/sources/github/intake', { kind: 'unbackburner', keys: [parked.url, assigned.url] }, { token });
    expect(r).toEqual({ status: 200, body: { done: [parked.url], failed: { [assigned.url]: 'not offered: not assigned to you' } } });
    expect(gh.issue(REPO, parked.number).labels).not.toContain('hopper:backburner');
    expect(await jobsFor(a, parked.url)).toHaveLength(1);
    expect((await a.events('types=source.backburner_lifted')).map((e) => e.data)).toEqual([{ source: 'github', key: parked.url }]);
    expect((await a.ui('/ui/api/sources/github/intake', { kind: 'unbackburner', keys: [parked.url] })).status).toBe(403);
  });

  it('a new request card records source.request_opened once for its text, across syncs and a restart', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const issue = gh.createIssue({ repo: REPO, author: 'stranger', body: sleepy, labels: ['hopper'], labelledBy: 'owner', assignedBy: 'owner' });
    await a.sync();
    await a.sync();
    const opened = await a.events('types=source.request_opened');
    const hash = (await intake(a))[issue.url]!.request!.hash;
    expect(opened.map((e) => e.data)).toEqual([{ source: 'github', key: issue.url, hash, author: 'stranger', why: ['written by stranger, not a trusted actor'] }]);

    const dbPath = a.dbPath;
    await a.stop();
    const b = await boot(gh, dbPath);
    await b.sync();
    expect(await b.events('types=source.request_opened')).toHaveLength(1);

    gh.editIssue(REPO, issue.number, { body: body({ op: 'sleep', ms: 1 }) }, 'stranger');
    await b.sync();
    const again = await b.events('types=source.request_opened');
    expect(again).toHaveLength(2);
    expect(again.map((e) => e.data.hash)).toContain((await intake(b))[issue.url]!.request!.hash);
  });

  it('a taken issue carries its job\'s status now, not as of the last sync', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const issue = gh.createIssue({ repo: REPO, body: body({ op: 'sleep', ms: 10 }), labels: ['hopper'] });
    await a.sync();
    const [job] = await jobsFor(a, issue.url);
    const ended = await waitFor(async () => { const j = await a.job(job!.id); return TERMINAL_STATUSES.includes(j.status) ? j : undefined; }, { what: 'the job ends' });
    const o = (await intake(a))[issue.url]!;
    expect(o.reason).toBeUndefined();
    expect(o).toMatchObject({ jobId: job!.id, jobStatus: ended.status });
  });
});
