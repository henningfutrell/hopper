// A herdr-claude job pulled from a source end to end, with the scriptable fake herdr at the
// executor's HerdrClient seam: question → opus answer typed into the pane → finished → pane closed.
import { afterEach, describe, expect, it } from 'vitest';
import type { SourceItem } from '../../src/domain/ports.ts';
import { createFakeHerdrClient, type FakeHerdrClient } from '../../src/executors/herdr/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

const ASK = { output: ['● Which colour should the shed be?', '  JOB_HOPPER_QUESTION'] };
const DONE = { steps: ['● Painting'], output: ['● Painted the shed.', '  JOB_HOPPER_DONE'] };
const EXECUTORS = [{ name: 'test', plugin: 'test' }, { name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleQuestionMs: 5000 } }];

async function start(herdr: FakeHerdrClient, env: Record<string, string> = {}): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  t = await startTestApp({ dbPath: db.dbPath, env, plugins: { executors: EXECUTORS }, seams: { herdr } });
  return t;
}

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

const item = (over: Partial<SourceItem> = {}) => ({ executor: 'herdr-claude', prompt: 'Paint the shed', cwd: '/tmp', env: { HOPPER_REPO: 'o/r' }, ...over });

describe('herdr-claude job through the daemon', () => {
  it('asks, gets the opus answer typed into its pane, finishes, and its pane is closed', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [ASK, DONE] });
    const a = await start(herdr);
    const job = await a.pull({}, item());
    const done = await a.waitForStatus(job.id, 'finished', 8000);
    const [q] = await a.questionsOf(job.id);
    expect(q).toMatchObject({ status: 'answered', answeredBy: 'opus', detectedBy: 'marker' });
    expect(herdr.prompts.map((p) => p.text)).toEqual([expect.stringContaining('Paint the shed'), 'fake opus answer']);
    expect(done.result).toMatchObject({ summary: expect.stringContaining('Painted the shed.') });
    const paneId = (done.executorState as { paneId: string }).paneId;
    await waitFor(() => herdr.closed.includes(paneId));
  });

  it("sets the item's env plus HOPPER_JOB_ID on the job's tab", async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [DONE] });
    const a = await start(herdr);
    const job = await a.pull({}, item());
    await a.waitForStatus(job.id, 'finished', 8000);
    expect(herdr.calls.find((c) => c.method === 'createTab')!.args[0]).toMatchObject({ env: { HOPPER_REPO: 'o/r', HOPPER_JOB_ID: job.id } });
  });

  it('JOB_HOPPER_KEEP_PANES=true leaves the finished pane open', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [DONE] });
    const a = await start(herdr, { JOB_HOPPER_KEEP_PANES: 'true' });
    const job = await a.pull({}, item());
    await a.waitForStatus(job.id, 'finished', 8000);
    await new Promise((r) => setTimeout(r, 100));
    expect(herdr.closed).toEqual([]);
  });

  it('an item with a payload herdr-claude rejects is created failed; health lists the executors', async () => {
    const a = await start(createFakeHerdrClient({ session: 'jh-test' }));
    expect((await a.pull({}, item({ prompt: '' }))).error).toContain('prompt');
    expect((await a.pull({}, item({ cwd: 'rel' }))).error).toContain('cwd');
    expect((await a.pull({}, item({ env: { 'bad-key': 'x' } }))).error).toContain('env key bad-key');
    expect((await a.api('GET', '/api/health')).body.executors).toEqual(['test', 'herdr-claude', 'scripted']);
  });
});
