// The tending queue's integration tests' shared steps (issues #796, #1162): waiting pull requests of a repository, made
// through the real daemon and the in-memory fake GitHub, and what the tends did.
import type { Job } from '../../src/domain/types.ts';
import type { FakeGitHub } from '../../src/sources/index.ts';
import type { TestApp } from './app.ts';
import { waitFor } from './wait.ts';

export const body = (op: Record<string, unknown>) => `${JSON.stringify(op)}\n\nPlease do the thing.`;
export const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
export const sourceOf = (j: Job) => j.sourceState?.source as { follow?: string; heldBehind?: unknown; seen?: { mergeHeldBehind?: string } } | undefined;

const urlsOf = new WeakMap<TestApp, Map<string, string>>();

export interface Waiting { issue: number; job: Job; url: string }

/**
 * `count` issues of `repo`, each a job that opens a ready pull request (the first the oldest), with `checks`; each later run
 * of an item — a tend — does `tend` to its pull request.
 */
export async function waitingPullRequests(gh: FakeGitHub, app: TestApp, repo: string, count: number, o: { checks?: 'passing'; tend?: (url: string) => void } = {}): Promise<Waiting[]> {
  // One map per app: a later call's handler tends the pull requests of an earlier call too.
  const urls = urlsOf.get(app) ?? urlsOf.set(app, new Map()).get(app)!;
  const tend = o.tend ?? ((url: string) => gh.pushToPullRequest(url, new Date().toISOString()));
  app.scripted.ships((j) => {
    const n = j.source!.number!;
    const at = urls.get(j.source!.key);
    if (at === undefined) urls.set(j.source!.key, gh.openPullRequest(j.source!.repo!, n, { createdAt: ago(10 * (count - n + 1)), ...(o.checks ? { checks: o.checks } : {}) }).url);
    else tend(at);
  });
  const issues = Array.from({ length: count }, () => gh.createIssue({ repo, body: body({ op: 'echo' }), labels: ['hopper'] }));
  await app.sync();
  const out: Waiting[] = [];
  for (const issue of issues) {
    const job = (await app.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.find((j) => j.source?.key === issue.url)!;
    await app.waitForStatus(job.id, 'finished');
    await waitFor(() => gh.issue(repo, issue.number).labels.includes('hopper:pr-ready'), { what: `hopper:pr-ready on #${issue.number}` });
    out.push({ issue: issue.number, job, url: urls.get(issue.url)! });
  }
  return out;
}

export const tends = async (app: TestApp) => (await app.events('types=job.pull_request_tended')).map((e) => [e.jobId, (e.data as { step: string }).step]);
export const nextJobOf = async (app: TestApp, jobId: string): Promise<string> =>
  ((await app.events('types=job.pull_request_tended')).find((e) => e.jobId === jobId)!.data as { nextJobId: string }).nextJobId;

/** The tend job of `jobId` finished, and follows its pull request again. */
export async function tendDone(app: TestApp, jobId: string): Promise<void> {
  const next = await nextJobOf(app, jobId);
  await app.waitForStatus(next, 'finished');
  await waitFor(async () => sourceOf(await app.job(next))?.follow === 'open', { what: 'the tend job follows its pull request' });
}
