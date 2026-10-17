// The hopper's steps on a job's pull request are spans of the job's trace (issue #1486 part 7, design.md "Telemetry: job
// steps"). Real daemon and store, telemetry on with in-memory exporters, the in-memory fake GitHub at the GitHubApi seam.
//
// Feature: job steps in the job's trace
//   Scenario: a conflict the mirror resolves, yolo mode on
//     Then the base merge is a span of the job's trace, outcome pushed, linked to the sync that ran it
//     And the hopper's merge is a follow span of the job's trace, outcome merged_by_hopper
//   Scenario: a conflict the mirror does not resolve
//     Then the base merge's outcome is conflicts, and the tend is a span of the job's trace, outcome started
//     And the job the tend starts links to the tend span
import { InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { startTelemetry, type Telemetry } from '../../src/telemetry/sdk.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { connectGitHub } from '../support/github-account.ts';
import { waitFor } from '../support/wait.ts';

const REPO = 'owner/hopper-sandbox';
let a: TestApp | undefined;
let cleanup: (() => void) | undefined;
let telemetry: Telemetry | undefined;
let spans: InMemorySpanExporter;

afterEach(async () => {
  await a?.stop();
  a = undefined;
  cleanup?.();
  await telemetry?.shutdown();
  telemetry = undefined;
});

async function boot(gh: FakeGitHub): Promise<TestApp> {
  spans = new InMemorySpanExporter();
  telemetry = startTelemetry({ env: {}, version: '0.0.0-test', spanProcessors: [new SimpleSpanProcessor(spans)] });
  const db = tempDbPath();
  cleanup = db.cleanup;
  const plugins = { jobSources: [{ name: 'github', plugin: 'github-account', options: { enabled: true, pollSeconds: 3600, executor: 'scripted' } }] };
  a = await startTestApp({ dbPath: db.dbPath, env: {}, seams: { github: gh }, plugins });
  connectGitHub(a, [REPO]);
  return a;
}

/** A job that opens a ready pull request, waiting on it. */
async function waitingPullRequest(gh: FakeGitHub, app: TestApp, checks?: 'passing'): Promise<{ issue: number; job: Job; url: string }> {
  let url = '';
  app.scripted.ships((j) => {
    if (!url) url = gh.openPullRequest(REPO, j.source!.number!, { createdAt: new Date(Date.now() - 600_000).toISOString(), ...(checks ? { checks } : {}) }).url;
    else gh.pushToPullRequest(url, new Date().toISOString());
  });
  const issue = gh.createIssue({ repo: REPO, body: `${JSON.stringify({ op: 'echo' })}\n\nPlease do the thing.`, labels: ['hopper'] });
  await app.sync();
  const job = (await app.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.find((j) => j.source?.key === issue.url)!;
  await app.waitForStatus(job.id, 'finished');
  await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:pr-ready'), { what: 'hopper:pr-ready' });
  return { issue: issue.number, job, url };
}

const named = (name: string, jobId: string): ReadableSpan[] => spans.getFinishedSpans().filter((s) => s.name === name && s.attributes['hopper.job.id'] === jobId);
const rootOf = (jobId: string): ReadableSpan | undefined => named('hopper.job', jobId)[0];
const exported = (): string => JSON.stringify(spans.getFinishedSpans().map((s) => [s.name, s.attributes, s.events.map((e) => e.attributes)]));

describe('the hopper\'s steps on a job\'s pull request are spans of its trace (issue #1486 part 7)', () => {
  it('a base merge and the hopper\'s merge: in the job\'s trace, the base merge linked to the sync that ran it', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const token = await app.login();
    expect((await app.ui('/ui/api/yolo-mode', { repos: { [REPO]: true } }, { token })).status).toBe(200);
    const only = await waitingPullRequest(gh, app, 'passing');
    gh.setBaseMerge(only.url, { resolved: ['WHATS-NEW.md'] });
    gh.setConflicting(only.url, true);
    await app.sync();
    gh.setChecks(only.url, 'passing');
    await app.sync();
    await waitFor(() => gh.issue(REPO, only.issue).state === 'closed', { what: 'the pull request merged' });
    const merged = await waitFor(() => named('hopper.job.follow', only.job.id).find((s) => s.attributes['hopper.job.step.outcome'] === 'merged_by_hopper'), { what: 'the merge span' });

    const root = rootOf(only.job.id)!;
    const [baseMerge] = named('hopper.job.base_merge', only.job.id);
    expect(baseMerge!.attributes).toMatchObject({ 'hopper.job.step': 'base_merge', 'hopper.job.step.outcome': 'pushed' });
    // The job followed its pull request from its report: no pull request span, so the steps are children of its root.
    for (const step of [baseMerge!, merged]) {
      expect(step.spanContext().traceId).toBe(root.spanContext().traceId);
      expect(step.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    }
    expect(merged.attributes['hopper.pull_request.act']).toBe('none');
    const syncIds = spans.getFinishedSpans().filter((s) => s.name === 'hopper.source.sync').map((s) => s.spanContext().spanId);
    expect(syncIds).toContain(baseMerge!.links[0]?.context.spanId);
    // No pull request URL or text goes out: ids, numbers and enums only.
    expect(exported()).not.toMatch(/\/pull\/|Please do the thing|WHATS-NEW/);
  });

  it('a conflict the mirror does not resolve: the tend is a span of the job\'s trace, and its new job links to it', async () => {
    const gh = createFakeGitHub();
    const app = await boot(gh);
    const only = await waitingPullRequest(gh, app);
    gh.setBaseMerge(only.url, { conflicts: ['src/main.ts'] });
    gh.setConflicting(only.url, true);
    await app.sync();
    const next = ((await app.events('types=job.pull_request_tended')).find((e) => e.jobId === only.job.id)!.data as { nextJobId: string }).nextJobId;
    await app.waitForStatus(next, 'finished');

    const root = rootOf(only.job.id)!;
    const [baseMerge] = named('hopper.job.base_merge', only.job.id);
    expect(baseMerge!.attributes['hopper.job.step.outcome']).toBe('conflicts');
    const [tend] = named('hopper.job.tend', only.job.id);
    expect(tend!.attributes).toMatchObject({ 'hopper.tend.step': 'rebase', 'hopper.job.step.outcome': 'started' });
    expect(tend!.spanContext().traceId).toBe(root.spanContext().traceId);
    const nextRoot = await waitFor(() => rootOf(next), { what: 'the tend job\'s trace' });
    expect(nextRoot.links.map((l) => l.context.spanId)).toContain(tend!.spanContext().spanId);
    expect(exported()).not.toMatch(/\/pull\/|Please do the thing|src\/main\.ts/);
  });
});
