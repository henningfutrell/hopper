// The token ledger (issue #2302, part 6): a print-mode Claude job keeps no agent session the checkpoint reads; each turn's
// JSON result says what it spent (`modelUsage`), and the hopper adds it to the job's ledger, by the turn's session. Real
// daemon, the `claude` executor over a stand-in CLI that answers as claude 2.1 does.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { TokenTotals } from '../../src/domain/token-usage.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { useStandInPodman } from '../support/stand-in-podman.ts';

const FAKE = join(import.meta.dirname, '..', 'adapters', 'fake-print-agent.mjs');
const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'jh-print-tokens-'));
  process.env.FAKE_AGENT_DIR = dir;
  process.env.FAKE_AGENT_KIND = 'claude';
  useStandInPodman(dir);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
  delete process.env.FAKE_AGENT_REPLY;
});

async function boot(): Promise<TestApp> {
  mkdirSync(join(homedir(), 'print-work'), { recursive: true });
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const a = await startTestApp({
    dbPath: db.dbPath,
    plugins: { executors: [{ name: 'test', plugin: 'test' }, { name: 'claude', plugin: 'claude', options: { bin: FAKE, args: [] } }], machines: [{ name: 'local', plugin: 'local', options: { lanes: 1, workTree: '~/print-work' } }] },
    // No escalation level answers the question: a person does.
    seams: { levels: [] },
  });
  apps.push(a);
  return a;
}

describe('the token ledger of a print-mode Claude job', () => {
  it('adds each turn\'s use to its session, so a question and its answer count both turns', async () => {
    const a = await boot();
    process.env.FAKE_AGENT_REPLY = 'Which colour?\nHOPPER_QUESTION';
    const job = await a.pull({}, { executor: 'claude', prompt: 'Paint the shed', env: {} });
    await a.waitForStatus(job.id, 'waiting_answer');
    expect(a.user().store.tokenLedger.list({ jobId: job.id })).toMatchObject([{ session: 'claude-session-1', model: 'claude-opus-5-5', machineId: 'local', turns: 2, input: 3, output: 30, cacheRead: 300, cacheWrite: 20 }]);

    process.env.FAKE_AGENT_REPLY = 'Painted it blue.\nHOPPER_DONE';
    const q = await a.waitForQuestion(job.id, () => true);
    expect((await a.ui(`/ui/api/questions/${q.id}/answer`, { answer: 'Blue.' }, { token: await a.login() })).status).toBe(200);
    await a.waitForStatus(job.id, 'finished');
    const tokens = await a.api<{ total: TokenTotals; sessions: number }>('GET', `/api/jobs/${job.id}/tokens`);
    expect(tokens.body).toMatchObject({ sessions: 1, total: { turns: 4, input: 6, output: 60, cacheRead: 600, cacheWrite: 40, costKnown: true } });
  });
});
