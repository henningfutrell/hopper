// The Planned work tab in a browser (issue #2861): the built UI in Chromium, against the real daemon and the real
// database. Jobs → Planned work lists no plan; a work plan is imported from its issue's sub-issues through the tab, which
// then draws it from the plan store — its plan pieces, plan tasks, jobs and roll-up —; a plan artifact is added there and
// shows; CSV and JSON export save the files the API answers. With HOPPER_TEST_SCREENSHOT set, it saves a screenshot there.
// Needs the built UI (`npm run build:ui`) and a Chromium: Playwright's own (`npx playwright install chromium`), or the one
// HOPPER_TEST_CHROMIUM names. Without either the test is skipped, and says why.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { placeGraph, type ItemRef } from '../../src/domain/issue-graph.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

const UI_BUILT = existsSync(fileURLToPath(new URL('../../ui/dist/index.html', import.meta.url)));
const CHROMIUM = process.env.HOPPER_TEST_CHROMIUM || chromium.executablePath();
const SKIP = !UI_BUILT ? 'the UI is not built (npm run build:ui)'
  : !existsSync(CHROMIUM) ? 'no Chromium (npx playwright install chromium, or HOPPER_TEST_CHROMIUM)' : undefined;
if (SKIP) console.warn(`planned-work-browser: skipped, ${SKIP}`);

let a: TestApp | undefined;
let browser: Browser | undefined;
let cleanup: (() => void) | undefined;
/** Chromium's own temp dir, one level above the run's: its socket path must fit in 108 bytes, and the run's is deep. */
let browserTmp: string | undefined;

beforeAll(async () => {
  if (SKIP) return;
  browserTmp = mkdtempSync(join(dirname(tmpdir()), 'cr-'));
  browser = await chromium.launch({ executablePath: CHROMIUM, env: { ...process.env, TMPDIR: browserTmp } });
});
afterAll(async () => {
  await browser?.close();
  if (browserTmp) rmSync(browserTmp, { recursive: true, force: true });
});
afterEach(async () => {
  await a?.stop();
  a = undefined;
  cleanup?.();
});

const url = (n: number) => `https://github.com/acme/app/issues/${n}`;
const ref = (n: number): ItemRef => ({ kind: 'issue', repo: 'acme/app', number: n, url: url(n) });
function read(app: TestApp, n: number, subIssues: number[] = []): void {
  app.user().store.issueGraph.record(url(n), placeGraph({
    issue: { repo: 'acme/app', number: n, url: url(n), title: `title ${n}`, state: 'OPEN', updatedAt: '2026-10-02T00:00:00Z' },
    owner: { login: 'acme' }, projects: [], closedBy: [], references: [], subIssues: subIssues.map(ref),
  }), new Date().toISOString());
}

/** A page signed in to the daemon at `hash`, that reaches the daemon and nothing else. */
async function open(app: TestApp, hash: string): Promise<Page> {
  const token = await app.login();
  const context = await browser!.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  await context.addInitScript((t) => localStorage.setItem('jh_session', t), token);
  await context.route((u) => u.hostname !== '127.0.0.1', (route) => route.abort());
  const page = await context.newPage();
  await page.goto(`${app.url}/${hash}`);
  return page;
}

describe.skipIf(SKIP !== undefined)('the Planned work tab in a browser (issue #2861)', () => {
  it('imports a plan, draws it from the plan store, adds an artifact and saves both exports', async () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    a = await startTestApp({ dbPath: db.dbPath });
    // Plan 1: piece 2 (tasks 4 and 5) and piece 3 (its own task). Task 4's job is done.
    read(a, 1, [2, 3]); read(a, 2, [4, 5]); read(a, 3); read(a, 4); read(a, 5);
    const { store } = a.user();
    const spec = { executor: 'test', payload: {}, machineId: 'nowhere' };
    const job = store.jobs.create(spec, 50, { source: 'github', kind: 'github', key: url(4), url: url(4), repo: 'acme/app', number: 4, title: 'title 4' });
    store.jobs.update(job.id, { status: 'finished', finishedAt: new Date().toISOString(), sourceState: { source: { pullRequest: 'https://github.com/acme/app/pull/40', follow: 'merged' } } });
    store.events.append({ type: 'job.queued', jobId: job.id, data: { spec, priority: 50 } });
    store.events.append({ type: 'job.finished', jobId: job.id, data: { result: 'pull request ready for review' } });

    const page = await open(a, '#jobs/planned-work');
    await page.getByText('No work plan is kept yet').waitFor();
    await page.locator('[data-slot="planned-work-issue"]').fill('acme/app#1');
    await page.locator('[data-slot="planned-work-import"]').click();
    await page.locator('[data-slot="plan-node"][data-node-id="plan:acme/app#1"]').waitFor();
    expect(page.url()).toContain('#jobs/planned-work/acme%2Fapp%231');
    const status = (id: string) => page.locator(`[data-slot="plan-node"][data-node-id="${id}"]`).getAttribute('data-status');
    expect(await status('task:acme/app#4')).toBe('done');
    expect(await status('task:acme/app#5')).toBe('planned');
    expect(await status('piece:acme/app#2')).toBe('running');
    expect(await page.locator('[data-slot="planned-work-count"][data-status="done"]').textContent()).toBe('1 done');
    // The job's pull request is an artifact the sync recorded; a person adds a report to task 5.
    await page.locator('[data-slot="planned-work-artifact"]', { hasText: 'https://github.com/acme/app/pull/40' }).waitFor();
    const form = page.locator('[data-slot="planned-work-artifact-add"]');
    await form.locator('select[name="task"]').selectOption('acme/app#5');
    await form.locator('select[name="type"]').selectOption('report');
    await form.locator('input[name="ref"]').fill('https://example.org/report');
    await form.getByRole('button', { name: 'Add artifact' }).click();
    await page.locator('[data-slot="planned-work-artifact"]', { hasText: 'https://example.org/report' }).waitFor();
    if (process.env.HOPPER_TEST_SCREENSHOT) await page.screenshot({ path: process.env.HOPPER_TEST_SCREENSHOT, fullPage: true });

    const saved = async (slot: string) => {
      const [d] = await Promise.all([page.waitForEvent('download'), page.locator(`[data-slot="${slot}"]`).click()]);
      return readFileSync((await d.path())!, 'utf8');
    };
    const csv = await saved('planned-work-export-csv');
    expect(csv).toBe(await (await fetch(`${a.url}/api/planned-work/export?plan=${encodeURIComponent('acme/app#1')}&format=csv`)).text());
    expect(csv).toContain('acme/app#5,planned,,,,https://example.org/report');
    const json = JSON.parse(await saved('planned-work-export-json')) as { plan_id: string; counts: unknown };
    expect(json).toEqual(await (await fetch(`${a.url}/api/planned-work/export?plan=${encodeURIComponent('acme/app#1')}&format=json`)).json());
    // The list shows the kept plan.
    await page.goto(`${a.url}/#jobs/planned-work`);
    await page.locator('[data-slot="planned-work-plan"][data-plan-id="acme/app#1"]').waitFor();
  });
});
