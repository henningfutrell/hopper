// How the work after a person's act spent its time (issue #1194): GET /api/sources answers `afterAnswer`, per act the
// wait on its queue apart from its run. An Approve sent while a sync runs answers; the sync it asks for
// waits for the running one, and that wait shows apart from the sync's own run. Real daemon, real database; the fake
// GitHub, slowed at its seam.
import { afterEach, describe, expect, it } from 'vitest';
import type { IntakeOutcome } from '../../src/domain/intake.ts';
import type { AfterAnswerTiming, Job } from '../../src/domain/types.ts';
import { createFakeGitHub } from '../../src/sources/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { connectGitHub } from '../support/github-account.ts';
import { withinBudget } from '../support/latency.ts';
import { slowGitHub } from '../support/slow-github.ts';
import { waitFor } from '../support/wait.ts';

const REPO = 'owner/hopper-sandbox';
/** Each GitHub call while the running sync runs: a full sync makes several, so it runs a second at least. */
const CALL_MS = 300;
const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
});

describe('the wait on the queue apart from the run, per act (issue #1194)', () => {
  it('Approve while a sync runs: answered at once; its sync waits, and the wait shows apart from the run', { timeout: 60_000 }, async () => {
    const gh = createFakeGitHub();
    const slow = slowGitHub(gh);
    const db = tempDbPath();
    cleanup = db.cleanup;
    const plugins = { jobSources: [{ name: 'github', plugin: 'github-account', options: { enabled: true, pollSeconds: 3600, executor: 'scripted' } }] };
    const a = await startTestApp({ dbPath: db.dbPath, env: {}, seams: { github: slow.api }, plugins });
    apps.push(a);
    connectGitHub(a, [REPO]);
    const token = await a.login();
    const issue = gh.createIssue({ repo: REPO, author: 'stranger', body: `${JSON.stringify({ op: 'sleep', ms: 10000 })}\n\nFix the typo.`, labels: ['hopper'] });
    await a.sync();
    const sources = async () => (await a.api<{ sources: { name: string; detail: { intake: IntakeOutcome[] } }[]; afterAnswer: AfterAnswerTiming[] }>('GET', '/api/sources')).body;
    const hash = (await sources()).sources.find((s) => s.name === 'github')!.detail.intake.find((x) => x.key === issue.url)!.request!.hash;
    expect((await sources()).afterAnswer).toEqual([]);

    slow.delay.ms = CALL_MS;
    const running = a.sync();
    await new Promise((r) => setTimeout(r, 50));
    const t0 = performance.now();
    const r = await a.ui('/ui/api/sources/github/intake', { kind: 'approve', keys: [issue.url], hash }, { token });
    withinBudget(performance.now() - t0);
    expect(r).toMatchObject({ status: 200, body: { done: [issue.url], failed: {} } });
    await running;
    slow.release();
    await waitFor(async () => (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.find((j) => j.source?.key === issue.url), { what: 'the approved job', timeoutMs: 20_000 });
    const timing = await waitFor(async () => (await sources()).afterAnswer.find((t) => t.act === 'sync:approve'), { what: 'the sync\'s timing' });
    expect(timing).toMatchObject({ count: 1, lastAt: expect.any(String) });
    // It waited for the running sync, which made several slowed calls after the Approve.
    expect(timing.waitMs.max).toBeGreaterThanOrEqual(CALL_MS);
    expect(timing.runMs.max).toBeGreaterThanOrEqual(0);
    // The Approve's own GitHub work after the answer (its write-behind) is timed too, as the source's (part 8).
    expect((await sources()).afterAnswer).toContainEqual(expect.objectContaining({ act: 'approve', source: 'github', count: 1 }));
  });
});
