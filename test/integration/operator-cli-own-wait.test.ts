// Issue #1780: the operator CLI says why a job on its own wait waits. `hopper job show` gives what it waits on, its
// `wait` and the machine it resumes on, and takes the short id the views show; `hopper queue list` lists it after the
// jobs that wait to run; and a job that asked a question before it waited keeps no `questionId`, so `hopper question
// list` and the job agree. Real daemon over the fake herdr, real CLI.
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import type { Job } from '../../src/domain/types.ts';
import { createFakeHerdrClient } from '../../src/executors/herdr/index.ts';
import { databaseUrlFor } from '../support/database.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;
afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

const ASK = { output: ['● Which colour should the shed be?', '  HOPPER_QUESTION'] };
const WAIT = { output: ['● The paint is on order.', '  HOPPER_WAITING', '  for: the paint to come', '  on: outside: the paint shop'], background: { work: '1 shell', polls: 1_000_000 } };
const EXECUTORS = [{ name: 'test', plugin: 'test' }, { name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleNudgeMs: 300, promptSteadyMs: 100 } }];
const item = { executor: 'herdr-claude', prompt: 'Paint the shed', cwd: '/tmp', env: {} };

async function hopper(a: TestApp, argv: string[]) {
  const out: string[] = [];
  const io: CliIo = { env: { HOPPER_DATABASE_URL: databaseUrlFor(a.dbPath) }, stdin: () => '', out: (x) => out.push(x), err: () => {} };
  const code = await runCli([...argv, '--url', a.url], io);
  return { code, json: code === 0 ? JSON.parse(out.join('')) as unknown : undefined };
}

/** A job that asked a question, was answered in its pane, then went on its own wait. */
async function onItsOwnWait(): Promise<{ a: TestApp; job: Job }> {
  const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [ASK, WAIT] });
  const db = tempDbPath();
  cleanup = db.cleanup;
  const a = t = await startTestApp({ dbPath: db.dbPath, plugins: { executors: EXECUTORS, machines: lanes(1) }, seams: { herdr, levels: [] } });
  const pulled = await a.pull({}, item);
  await a.waitForQuestion(pulled.id, (q) => q.tier === 'human');
  const { agentName } = (await a.job(pulled.id)).executorState as { agentName: string };
  await herdr.prompt(agentName, 'Blue.');
  return { a, job: await a.waitForStatus(pulled.id, 'waiting_on', 8000) };
}

describe('the CLI says why a job on its own wait waits (issue #1780)', () => {
  it('job show gives what it waits on, by its full or its short id; it keeps no question', async () => {
    const { a, job } = await onItsOwnWait();
    expect(job.questionId).toBeUndefined();
    const shown = { id: job.id, status: 'waiting_on', waitsOn: 'outside (reason not given): the paint shop', waitsFor: 'the paint to come', resumeOn: 'local', wait: { for: 'the paint to come', since: job.wait!.since } };
    expect((await hopper(a, ['job', 'show', job.id])).json).toMatchObject(shown);
    expect((await hopper(a, ['job', 'show', job.id.slice(0, 8)])).json).toMatchObject(shown);
    expect((await hopper(a, ['question', 'list'])).json).toEqual([]);
  });

  it('queue list lists it, with what it waits on and since when', async () => {
    const { a, job } = await onItsOwnWait();
    expect((await hopper(a, ['queue', 'list'])).json).toEqual([expect.objectContaining({
      id: job.id, status: 'waiting_on', waitsOn: 'outside (reason not given): the paint shop', waitsFor: 'the paint to come', waitingSince: job.wait!.since,
    })]);
  });

  it('a short id no job has is a refusal', async () => {
    const { a } = await onItsOwnWait();
    expect((await hopper(a, ['job', 'show', 'ffffffff'])).code).toBe(2);
  });
});
