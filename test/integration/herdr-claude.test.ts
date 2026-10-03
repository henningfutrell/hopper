// A herdr-claude job end to end through HTTP, with the scriptable fake herdr at the
// executor's HerdrClient seam: question → opus answer typed into the pane → finished → pane closed.
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeHerdrClient, type FakeHerdrClient } from '../../src/executors/herdr/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

const ASK = { output: ['● Which colour should the shed be?', '  JOB_HOPPER_QUESTION'] };
const DONE = { steps: ['● Painting'], output: ['● Painted the shed.', '  JOB_HOPPER_DONE'] };
const ENV = { JOB_HOPPER_EXECUTORS: 'test,herdr-claude', JOB_HOPPER_HERDR_POLL_MS: '10', JOB_HOPPER_IDLE_QUESTION_MS: '5000' };

async function start(herdr: FakeHerdrClient, env: Record<string, string> = {}): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  t = await startTestApp({ dbPath: db.dbPath, env: { ...ENV, ...env }, seams: { herdr } });
  return t;
}

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

describe('herdr-claude job through the daemon', () => {
  it('asks, gets the opus answer typed into its pane, finishes, and its pane is closed', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [ASK, DONE] });
    const a = await start(herdr);
    const job = await a.push({ executor: 'herdr-claude', payload: { prompt: 'Paint the shed', cwd: '/tmp' } });
    const done = await a.waitForStatus(job.id, 'finished', 8000);
    const [q] = await a.questionsOf(job.id);
    expect(q).toMatchObject({ status: 'answered', answeredBy: 'opus', detectedBy: 'marker' });
    expect(q!.text).toContain('Which colour should the shed be?');
    expect(herdr.prompts.map((p) => p.text)).toEqual([expect.stringContaining('Paint the shed'), 'fake opus answer']);
    expect(done.result).toMatchObject({ summary: expect.stringContaining('Painted the shed.') });
    const paneId = (done.executorState as { paneId: string }).paneId;
    await waitFor(() => herdr.closed.includes(paneId));
  });

  it('JOB_HOPPER_KEEP_PANES=true leaves the finished pane open', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [DONE] });
    const a = await start(herdr, { JOB_HOPPER_KEEP_PANES: 'true' });
    const job = await a.push({ executor: 'herdr-claude', payload: { prompt: 'Paint the shed', cwd: '/tmp' } });
    await a.waitForStatus(job.id, 'finished', 8000);
    await new Promise((r) => setTimeout(r, 100));
    expect(herdr.closed).toEqual([]);
  });

  it('validates herdr-claude payloads at push and lists its executors in health', async () => {
    const a = await start(createFakeHerdrClient({ session: 'jh-test' }));
    const bad = await a.api('POST', '/api/jobs', { executor: 'herdr-claude', payload: { prompt: '' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('prompt');
    expect((await a.api('POST', '/api/jobs', { executor: 'herdr-claude', payload: { prompt: 'x', cwd: 'rel' } })).status).toBe(400);
    expect((await a.api('GET', '/api/health')).body.executors).toEqual(['test', 'herdr-claude']);
  });
});
