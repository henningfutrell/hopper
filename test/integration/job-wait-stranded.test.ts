// Issue #1779: a job on a wait the hopper watches (a vault grant, a template approval) whose agent session ended — its pane
// shows a bare shell — is stranded: nothing in its pane can go on, and only a person can wake it. The hopper marks the wait
// (`strandedAt`), the Failures view counts it as stuck work (`stranded`, Wake all), and the operator CLI lists it and wakes
// it. Woken, the job resumes its session in a new pane. Real daemon over the fake herdr, as job-wait.test.ts.
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import type { FailuresView, Job, StuckActResult, StuckCause } from '../../src/domain/types.ts';
import { createFakeHerdrClient, type FakeHerdrClient } from '../../src/executors/herdr/index.ts';
import { LOST_NOTE } from '../../src/executors/herdr/restored.ts';
import { databaseUrlFor } from '../support/database.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

const WAIT = { output: ['● The step needs a credential.', '  HOPPER_WAITING', '  for: a vault grant for the deploy key', '  on: vault grant'] };
const DONE = { output: ['● Deployed.', '  HOPPER_DONE'] };
const EXECUTORS = [{ name: 'test', plugin: 'test' }, { name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleNudgeMs: 300, promptSteadyMs: 100 } }];
const item = { executor: 'herdr-claude', prompt: 'Deploy it', cwd: '/tmp', env: {} };

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

async function strandedJob(): Promise<{ a: TestApp; herdr: FakeHerdrClient; job: Job }> {
  const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [WAIT, DONE] });
  const db = tempDbPath();
  cleanup = db.cleanup;
  const a = t = await startTestApp({ dbPath: db.dbPath, plugins: { executors: EXECUTORS, machines: lanes(1) }, seams: { herdr, levels: [] } });
  const pulled = await a.pull({}, item);
  const waiting = await a.waitForStatus(pulled.id, 'waiting_on', 8000);
  expect(waiting.wait?.on).toEqual({ kind: 'grant' });
  expect(waiting.wait?.strandedAt).toBeUndefined();
  // Claude exits: the pane shows a bare shell prompt, and herdr knows no live agent of that name.
  herdr.killAgent((waiting.executorState as { agentName: string }).agentName);
  const job = await waitFor(async () => {
    const j = await a.job(pulled.id);
    return j.wait?.strandedAt ? j : undefined;
  }, { what: 'the wait marked stranded' });
  return { a, herdr, job };
}

async function hopper(a: TestApp, argv: string[]) {
  const out: string[] = [];
  const io: CliIo = { env: { HOPPER_DATABASE_URL: databaseUrlFor(a.dbPath) }, stdin: () => '', out: (x) => out.push(x), err: () => undefined };
  const code = await runCli([...argv, '--url', a.url], io);
  return { code, out: out.join('') };
}

describe('a stranded wait (issue #1779)', () => {
  it('is marked, not ended: the job stays on its wait, and the Failures view counts it with Wake all', async () => {
    const { a, herdr, job } = await strandedJob();
    expect(job.status).toBe('waiting_on');
    expect((await a.events()).filter((e) => e.jobId === job.id && e.type === 'job.wait_ended')).toEqual([]);
    expect(herdr.agentStarts).toHaveLength(1);
    const view = (await a.api<FailuresView>('GET', '/api/failures')).body;
    expect(view.stuck.find((c) => c.cause === 'stranded')).toMatchObject({ ids: [job.id], act: 'Wake all' });
  });

  it('Wake all ends the wait: the job resumes its session in a new pane, told its session ended, and finishes', async () => {
    const { a, herdr, job } = await strandedJob();
    const token = await a.login();
    const r = await a.ui<StuckActResult>('/ui/api/failures/stuck/stranded', {}, { token });
    expect(r.body).toEqual({ cause: 'stranded', done: [job.id], refused: [] });

    await a.waitForStatus(job.id, 'finished', 8000);
    expect(herdr.agentStarts).toHaveLength(2);
    expect(herdr.agentStarts[1]!.args).toEqual(expect.arrayContaining(['--resume']));
    expect(herdr.prompts[1]!.text).toContain(LOST_NOTE);
    expect(herdr.prompts[1]!.text).toContain('Your agent session ended while you waited');
  });

  it('the operator CLI lists it as stuck work and wakes it with end-wait', async () => {
    const { a, job } = await strandedJob();
    const stuck = await hopper(a, ['failure', 'stuck']);
    expect(stuck.code).toBe(0);
    expect((JSON.parse(stuck.out) as StuckCause[]).find((c) => c.cause === 'stranded')!.ids).toEqual([job.id]);

    const ended = await hopper(a, ['job', 'end-wait', job.id]);
    expect(ended.code).toBe(0);
    expect(JSON.parse(ended.out)).toMatchObject({ id: job.id, status: 'queued' });
    await a.waitForStatus(job.id, 'finished', 8000);
  });

  it('the CLI runs a cause\'s bulk action: failure stuck stranded', async () => {
    const { a, job } = await strandedJob();
    const r = await hopper(a, ['failure', 'stuck', 'stranded']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ cause: 'stranded', done: [job.id], refused: [] });
    await a.waitForStatus(job.id, 'finished', 8000);
  });
});
