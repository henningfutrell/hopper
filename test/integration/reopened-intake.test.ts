// A reopened issue re-enters Intake end to end (issue #1126), through the real daemon and the fake GitHub at its seam, with
// no GitHub delivery set up: an issue whose job was done is reopened; the next sync lists it, its work item waits for
// approval, and Intake shows its reopened card with the job and the pull request before; Approve takes `hopper:done` off,
// and a new job of the item runs.
import { afterEach, describe, expect, it } from 'vitest';
import type { IntakeOutcome } from '../../src/domain/intake.ts';
import type { Job } from '../../src/domain/types.ts';
import type { WorkItem } from '../../src/domain/work-items.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { connectGitHub } from '../support/github-account.ts';
import { waitFor } from '../support/wait.ts';

const REPO = 'owner/hopper-sandbox';
const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
});

async function boot(gh: FakeGitHub) {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const plugins = { jobSources: [{ name: 'github', plugin: 'github-account', options: { enabled: true, pollSeconds: 3600, executor: 'scripted' } }] };
  const a = await startTestApp({ dbPath: db.dbPath, env: {}, seams: { github: gh }, plugins });
  apps.push(a);
  connectGitHub(a, [REPO]);
  return a;
}

const body = `${JSON.stringify({ op: 'sleep', ms: 1500 })}\n\nFix the typo.`;
const jobsFor = async (a: TestApp, url: string): Promise<Job[]> =>
  (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.filter((j) => j.source?.key === url);
const cardOf = async (a: TestApp, url: string): Promise<IntakeOutcome | undefined> =>
  ((await a.api('GET', '/api/sources')).body.sources.find((s: { name: string }) => s.name === 'github').detail.intake as IntakeOutcome[]).find((x) => x.key === url);
const itemOf = async (a: TestApp, url: string): Promise<WorkItem | undefined> =>
  (await a.api<{ items: WorkItem[] }>('GET', '/api/work-items')).body.items.find((i) => i.key === url);

describe('a reopened issue re-enters Intake (issue #1126)', () => {
  it('reopened after its job was done, it waits for approval with its history; approved, a new job runs', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const token = await a.login();
    const issue = gh.createIssue({ repo: REPO, body, labels: ['hopper'] });
    await a.sync();
    const [first] = await jobsFor(a, issue.url);
    await a.waitForStatus(first!.id, 'running');
    const now = new Date().toISOString();
    gh.closeByPullRequest(REPO, issue.number, { createdAt: now, mergedAt: now });
    await a.sync();
    await a.waitForStatus(first!.id, 'finished');
    await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:done'), { what: 'hopper:done' });

    await gh.reopenIssue(REPO, issue.number);
    await a.sync();
    const card = await cardOf(a, issue.url);
    expect(card).toMatchObject({ action: 'approve', group: 'request', request: { why: ['reopened after its job was done'], reopened: { jobs: [{ id: first!.id, status: 'finished' }] } } });
    expect(await itemOf(a, issue.url)).toMatchObject({ state: 'waiting_for_approval' });
    expect(await jobsFor(a, issue.url)).toHaveLength(1);

    const approved = await a.ui('/ui/api/sources/github/intake', { kind: 'approve', keys: [issue.url], hash: card!.request!.hash }, { token });
    expect(approved).toMatchObject({ status: 200, body: { done: [issue.url], failed: {} } });
    expect(gh.issue(REPO, issue.number).labels).not.toContain('hopper:done');
    const jobs = await jobsFor(a, issue.url);
    expect(jobs).toHaveLength(2);
    expect(jobs.find((j) => j.id !== first!.id)).toMatchObject({ rerunOf: first!.id });
  });
});
