// The clicked card changes at once, in a browser (issue #1194, part 9): the built UI in Chromium, against the real daemon
// and the real database, with GitHub held at its seam. Approve on a request card shows Approved, and Assign to me shows
// its GitHub write under way, while GitHub answers nothing; after the release, the approved job shows on Jobs. CI asserts
// the order; the time — 200 ms for the card, 1 s for the job — only off CI or with HOPPER_PERF=1 (test/support/latency.ts).
// Needs the built UI (`npm run build:ui`) and a Chromium: Playwright's own (`npx playwright install chromium`), or the
// one HOPPER_TEST_CHROMIUM names. Without either the test is skipped, and says why.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { IntakeOutcome } from '../../src/domain/intake.ts';
import type { Job } from '../../src/domain/types.ts';
import { createFakeGitHub } from '../../src/sources/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { connectGitHub } from '../support/github-account.ts';
import { withinBudget } from '../support/latency.ts';
import { slowGitHub } from '../support/slow-github.ts';
import { waitFor } from '../support/wait.ts';

const REPO = 'owner/hopper-sandbox';
/** The time from the release of GitHub to the approved job on Jobs: a sync and the stream. */
const JOB_MS = 1000;
const UI_BUILT = existsSync(fileURLToPath(new URL('../../ui/dist/index.html', import.meta.url)));
const CHROMIUM = process.env.HOPPER_TEST_CHROMIUM || chromium.executablePath();
const SKIP = !UI_BUILT ? 'the UI is not built (npm run build:ui)'
  : !existsSync(CHROMIUM) ? 'no Chromium (npx playwright install chromium, or HOPPER_TEST_CHROMIUM)' : undefined;
if (SKIP) console.warn(`action-latency-browser: skipped, ${SKIP}`);

const apps: TestApp[] = [];
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
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
});

async function boot() {
  const gh = createFakeGitHub();
  const slow = slowGitHub(gh);
  const db = tempDbPath();
  cleanup = db.cleanup;
  const plugins = { jobSources: [{ name: 'github', plugin: 'github-account', options: { enabled: true, pollSeconds: 3600, executor: 'scripted' } }] };
  const a = await startTestApp({ dbPath: db.dbPath, env: {}, seams: { github: slow.api }, plugins });
  apps.push(a);
  connectGitHub(a, [REPO]);
  return { gh, slow, a };
}

/** A page signed in to the daemon at `hash`, that reaches the daemon and nothing else. */
async function open(a: TestApp, hash: string): Promise<Page> {
  const token = await a.login();
  const context = await browser!.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript((t) => localStorage.setItem('jh_session', t), token);
  await context.route((url) => url.hostname !== '127.0.0.1', (route) => route.abort());
  const page = await context.newPage();
  await page.goto(`${a.url}/${hash}`);
  return page;
}

/** Clicks `button` and answers the ms until `changed` shows. */
async function clickUntil(page: Page, button: string, changed: string): Promise<number> {
  const t0 = performance.now();
  await page.locator(button).click();
  await page.locator(changed).waitFor({ state: 'visible', timeout: 10_000 });
  return performance.now() - t0;
}

describe.skipIf(SKIP !== undefined)('the clicked card changes at once, in a browser (issue #1194)', () => {
  it('Approve: the card shows Approved while GitHub answers nothing; after the release the job shows on Jobs', { timeout: 60_000 }, async () => {
    const { gh, slow, a } = await boot();
    const issue = gh.createIssue({ repo: REPO, author: 'stranger', body: `${JSON.stringify({ op: 'sleep', ms: 10000 })}\n\nFix the typo.`, labels: ['hopper'] });
    await a.sync();
    const page = await open(a, '#intake');
    const card = `[data-request="${issue.url}"]`;
    await page.locator(`${card} [data-slot=request-approve]`).waitFor({ state: 'visible', timeout: 10_000 });

    slow.hold();
    const ms = await clickUntil(page, `${card} [data-slot=request-approve]`, `${card} [data-slot=request-approved]`);
    withinBudget(ms);
    // GitHub answered nothing yet: no job.
    const jobs = async () => (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs;
    expect((await jobs()).find((j) => j.source?.key === issue.url)).toBeUndefined();

    const released = performance.now();
    slow.release();
    await page.evaluate(() => { location.hash = '#jobs'; });
    await page.locator('[data-slot=jobs-mode-list]').click();
    const job = await waitFor(async () => (await jobs()).find((j) => j.source?.key === issue.url), { what: 'the approved job', timeoutMs: 20_000 });
    await page.locator(`[data-slot=job-row][data-job-id="${job.id}"]`).first().waitFor({ state: 'visible', timeout: 20_000 });
    withinBudget(performance.now() - released, JOB_MS);
  });

  it('Assign to me: the row shows its GitHub write under way while GitHub answers nothing; the sync takes it after', { timeout: 60_000 }, async () => {
    const { gh, slow, a } = await boot();
    const issue = gh.createIssue({ repo: REPO, assignees: [], labels: ['hopper'] });
    await a.sync();
    const page = await open(a, '#intake');
    const row = `[data-intake-item="${issue.url}"]`;
    await page.locator(`${row} button:has-text("Assign to me")`).waitFor({ state: 'visible', timeout: 10_000 });

    slow.hold();
    const ms = await clickUntil(page, `${row} button:has-text("Assign to me")`, `${row} [data-write-behind=running]`);
    withinBudget(ms);
    expect(gh.issue(REPO, issue.number).assignees).toEqual([]);
    // The answer came: the toast says so, with GitHub still held.
    await page.getByText('Assigning to you').first().waitFor({ state: 'visible', timeout: 10_000 });
    expect(gh.issue(REPO, issue.number).assignees).toEqual([]);

    slow.release();
    await waitFor(async () => {
      const s = (await a.api<{ sources: { name: string; detail: { intake: IntakeOutcome[] } }[] }>('GET', '/api/sources')).body.sources.find((x) => x.name === 'github');
      return s?.detail.intake.find((x) => x.key === issue.url)?.action !== 'assign' || undefined;
    }, { what: 'the issue no longer offered Assign to me', timeoutMs: 20_000 });
    expect(gh.issue(REPO, issue.number).assignees.length).toBeGreaterThan(0);
  });
});
