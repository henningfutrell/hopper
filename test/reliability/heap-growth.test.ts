// The heap-growth check (issue #1383): the hopper's resident memory grew with no bound (2.5 GB after 48 minutes), and the
// event loop stalled behind the growth. This drives one real hopper idle, then busy — source syncs, intake actions the
// GitHub outbox sends, jobs that run and end, event-stream readers that come and go, and checkpoints that fail — and
// checks, after a forced garbage collection, that the heap used stays within a fixed bound after a warm-up.
// A run is local, not a pull request check: it takes minutes, and a heap bound is a reading of the machine
// (`docs/design.md` "Reading the held event loop"). Its numbers go in the log; run it with the verbose reporter to see them:
// HOPPER_HEAP_CHECK=1 npx vitest run test/reliability/heap-growth.test.ts --reporter=verbose
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TERMINAL_STATUSES, type Job } from '../../src/domain/types.ts';
import { createFakeHerdrClient } from '../../src/executors/herdr/index.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { connectGitHub } from '../support/github-account.ts';
import { manualItem } from '../support/manual-source.ts';
import { openSse } from '../support/sse.ts';
import { waitFor } from '../support/wait.ts';

const RUN = process.env.HOPPER_HEAP_CHECK === '1';
const MIB = 1024 ** 2;
const REPO = 'owner/hopper-sandbox';
/** Rounds before the baseline, so caches, compiled code and the store's pools are at their size. */
const WARM_UP = 3;
/** Busy rounds measured. */
const ROUNDS = Number(process.env.HOPPER_HEAP_CHECK_ROUNDS ?? 12);
/** Jobs each round pulls and runs to their end. */
const JOBS = 10;
/** Event-stream readers each round opens and closes. */
const READERS = 5;
/** Checkpoints each round tries on the job at work; each one fails. */
const CHECKPOINTS = 5;
/** How long the idle hopper runs. */
const IDLE_MS = Number(process.env.HOPPER_HEAP_CHECK_IDLE_MS ?? 30_000);
/** The most the heap used may grow after the warm-up, idle and busy. */
const IDLE_BOUND_MB = 8;
const BUSY_BOUND_MB = 24;
const ENDED = new Set<string>(TERMINAL_STATUSES);

const EXECUTORS = [
  { name: 'test', plugin: 'test' },
  { name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 50, idleNudgeMs: 60_000, promptSteadyMs: 100 } },
];

/** The heap used after a full garbage collection, in MiB. */
function heapAfterGc(): number {
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc') as () => void;
  gc();
  gc();
  return process.memoryUsage().heapUsed / MIB;
}

const say = (line: string): void => { console.warn(`heap check: ${line}`); };

describe.skipIf(!RUN)('the heap stays in a bound (issue #1383; local only: HOPPER_HEAP_CHECK=1)', () => {
  let a: TestApp;
  let gh: FakeGitHub;
  let cleanup: () => void;
  let atWork: Job;
  let round = 0;

  beforeAll(async () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    gh = createFakeGitHub();
    const herdr = createFakeHerdrClient({
      session: 'jh-test', repositories: [`${process.env.HOME}/shed`],
      turns: [{ steps: ['● Sanding'], output: [], end: 'working' }],
      checkpoint: new Error('git could not read the work tree'),
    });
    a = await startTestApp({
      dbPath: db.dbPath,
      plugins: {
        executors: EXECUTORS,
        machines: [{ name: 'local', plugin: 'local', options: { lanes: JOBS + 2, workTree: '~/shed' } }],
        jobSources: [{ name: 'github', plugin: 'github-account', options: { enabled: true, pollSeconds: 3600, executor: 'test' } }],
      },
      seams: { github: gh, herdr, levels: [] },
    });
    connectGitHub(a, [REPO]);
    atWork = await a.pull({}, { executor: 'herdr-claude', prompt: 'Paint the shed', env: {} });
    await a.waitForStatus(atWork.id, 'running', 30_000);
  }, 120_000);

  afterAll(async () => { await a?.stop(); cleanup?.(); });

  /** One busy round: a sync, an intake action the outbox sends, jobs to their end, readers, failed checkpoints. */
  async function busy(token: string): Promise<void> {
    round++;
    const issue = gh.createIssue({ repo: REPO, title: `Round ${round}`, body: JSON.stringify({ op: 'echo', message: `${round}` }), labels: ['hopper'], assignees: [] });
    await a.sync();
    const r = await a.ui<{ done: string[] }>('/ui/api/sources/github/intake', { kind: 'assign', keys: [issue.url] }, { token });
    expect(r.status).toBe(200);
    await waitFor(() => (gh.issue(REPO, issue.number).assignees.length > 0 ? true : undefined), { what: 'the outbox sent the assignment', timeoutMs: 30_000 });

    const readers = await Promise.all(Array.from({ length: READERS }, () => openSse(`${a.url}/api/events/stream`, { 'x-hopper-session': token })));
    const keys = new Set<string>();
    for (let i = 0; i < JOBS; i++) {
      const item = manualItem({ prompt: JSON.stringify({ op: 'echo', message: `${round}.${i}` }) });
      keys.add(item.key);
      a.source.add(item);
    }
    await a.sync();
    await waitFor(async () => {
      const { jobs } = (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000', undefined, { 'x-hopper-session': token })).body;
      const mine = jobs.filter((j) => j.source && keys.has(j.source.key));
      return mine.length === JOBS && mine.every((j) => ENDED.has(j.status)) ? true : undefined;
    }, { what: `the round's ${JOBS} jobs ended`, timeoutMs: 60_000 });

    for (let i = 0; i < CHECKPOINTS; i++) await a.user().engine.checkpoints.take(atWork.id).catch(() => undefined);
    await waitFor(() => (readers.every((c) => c.messages.length > 0) ? true : undefined), { what: 'each reader heard an event', timeoutMs: 30_000 });
    for (const c of readers) c.close();
  }

  it('an idle hopper\'s heap does not grow', async () => {
    const before = heapAfterGc();
    await new Promise((r) => setTimeout(r, IDLE_MS));
    const after = heapAfterGc();
    say(`idle ${IDLE_MS / 1000} s: ${before.toFixed(1)} MiB → ${after.toFixed(1)} MiB (${(after - before).toFixed(1)} MiB)`);
    expect(after - before).toBeLessThan(IDLE_BOUND_MB);
  }, IDLE_MS + 60_000);

  it('a busy hopper\'s heap stays in a bound after the warm-up', async () => {
    const token = await a.login();
    for (let i = 0; i < WARM_UP; i++) await busy(token);
    const base = heapAfterGc();
    const readings: number[] = [];
    for (let i = 0; i < ROUNDS; i++) {
      await busy(token);
      readings.push(heapAfterGc());
      say(`round ${i + 1} of ${ROUNDS}: ${readings.at(-1)!.toFixed(1)} MiB`);
    }
    const last = readings.at(-1)!;
    say(`busy ${ROUNDS} rounds of ${JOBS} jobs, ${READERS} readers, ${CHECKPOINTS} failed checkpoints and one outbox write: ${base.toFixed(1)} MiB → ${last.toFixed(1)} MiB (${(last - base).toFixed(1)} MiB); each round: ${readings.map((n) => n.toFixed(1)).join(', ')}`);
    expect(last - base).toBeLessThan(BUSY_BOUND_MB);
  }, 30 * 60_000);
});
