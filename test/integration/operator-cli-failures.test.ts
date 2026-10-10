// Issue #623: the Failures actions from the operator CLI. A problem that holds jobs, a hand-off in Needs a person and
// a surfaced failure are settled from the host with no UI session signed in: `hopper problem|handoff|failure …` makes
// the UI's own POST /ui/api/failures/* call on the running daemon (cli-operator.ts), so the events, the write-back to
// the source and the runs again are the click's. Each event says who acted: the person and the way (`via`: `cli`
// or `ui`). Real daemon, real CLI, real database; the manual source at its seam.
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import type { FailuresView, HandoffView, Job, Problem } from '../../src/domain/types.ts';
import { databaseUrlFor } from '../support/database.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;
afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

async function boot(): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  t = await startTestApp({ dbPath: db.dbPath, plugins: { machines: lanes(2) } });
  return t;
}

async function hopper(a: TestApp, argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { env: { HOPPER_DATABASE_URL: databaseUrlFor(a.dbPath) }, stdin: () => '', out: (x) => out.push(x), err: (x) => err.push(x) };
  const code = await runCli([...argv, '--url', a.url], io);
  return { code, out: out.join(''), err: err.join('') };
}

const CLI = { person: 'operator CLI', via: 'cli' };
const failuresOf = async (a: TestApp): Promise<FailuresView> => (await a.api<FailuresView>('GET', '/api/failures')).body;
const handoffOf = async (a: TestApp, jobId: string) =>
  waitFor(async () => (await failuresOf(a)).handoffs.find((h) => h.jobId === jobId && h.status === 'open'), { what: `job ${jobId} handed off` });
const failed = async (a: TestApp, message: string) => {
  const job = await a.pull({ op: 'fail', message, ms: 0 });
  return { job, handoff: await handoffOf(a, job.id) };
};

describe('problems from the CLI (issue #623)', () => {
  it('list, release and settle a problem that holds jobs: the held jobs start; the events name the CLI', async () => {
    const a = await boot();
    const job = await a.pull({ op: 'fail', message: 'claude: Not logged in · Please run /login', ms: 0 });
    const problem = await waitFor(async () => (await failuresOf(a)).problems.find((p) => p.jobIds.includes(job.id)), { what: 'a problem' });
    const queued = await a.pull({ op: 'echo' });
    await a.waitForStatus(queued.id, 'held');

    const list = await hopper(a, ['problem', 'list']);
    expect(list.code).toBe(0);
    expect((JSON.parse(list.out) as Problem[]).map((p) => p.id)).toContain(problem.id);

    const released = await hopper(a, ['problem', 'release', problem.id]);
    expect(released.code).toBe(0);
    expect(JSON.parse(released.out)).toMatchObject({ id: problem.id });
    const ev = await waitFor(async () => (await a.events('types=failure.released')).find((e) => e.data.problemId === problem.id), { what: 'failure.released' });
    expect(ev.data).toMatchObject({ released: 1, actor: CLI });

    const settled = await hopper(a, ['problem', 'settle', problem.id, '--note', 'Signed in again on the machine.']);
    expect(settled.code).toBe(0);
    expect(JSON.parse(settled.out)).toMatchObject({ id: problem.id, status: 'resolved' });
    const resolved = await waitFor(async () => (await a.events('types=failure.resolved')).find((e) => e.data.problemId === problem.id), { what: 'failure.resolved' });
    expect(resolved.data).toMatchObject({ by: 'user', actor: CLI, note: 'Signed in again on the machine.' });
    await a.waitForStatus(queued.id, 'finished');

    const again = await hopper(a, ['problem', 'settle', problem.id]);
    expect(again.code).toBe(2);
    expect(again.err).toMatch(/already resolved/);
  });

  it('the UI\'s action names the UI as the way', async () => {
    const a = await boot();
    const token = await a.login();
    const job = await a.pull({ op: 'fail', message: 'claude: Not logged in · Please run /login', ms: 0 });
    const problem = await waitFor(async () => (await failuresOf(a)).problems.find((p) => p.jobIds.includes(job.id)), { what: 'a problem' });
    expect((await a.ui(`/ui/api/failures/problems/${problem.id}/resolve`, {}, { token })).status).toBe(200);
    const resolved = await waitFor(async () => (await a.events('types=failure.resolved')).find((e) => e.data.problemId === problem.id));
    expect(resolved.data).toMatchObject({ by: 'user', actor: { via: 'ui', person: expect.any(String) } });
  });
});

describe('hand-offs from the CLI (issue #623)', () => {
  it('done with a note and a pull request: the job ends finished, the source is told, the event names the CLI', async () => {
    const a = await boot();
    const { job, handoff } = await failed(a, 'HOPPER_FAILED the tests do not pass');
    const list = await hopper(a, ['handoff', 'list']);
    expect((JSON.parse(list.out) as HandoffView[]).map((h) => h.id)).toEqual([handoff.id]);

    const r = await hopper(a, ['handoff', 'done', handoff.id, '--note', 'Fixed by hand.', '--pr', 'https://example.invalid/pull/7']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).handoff).toMatchObject({
      status: 'closed', end: 'done_by_hand',
      resolution: { action: 'done_by_hand', note: 'Fixed by hand.', link: 'https://example.invalid/pull/7', by: 'operator CLI', via: 'cli' },
    });
    expect((await a.job(job.id)).status).toBe('finished');
    await waitFor(() => a.source.resolutions.some((x) => x.jobId === job.id), { what: 'the source told' });
    const closed = (await a.events('types=handoff.closed')).find((e) => e.data.handoffId === handoff.id);
    expect(closed?.data).toMatchObject({ end: 'done_by_hand', resolution: 'done_by_hand', actor: CLI });
    expect(JSON.parse((await hopper(a, ['handoff', 'list'])).out)).toEqual([]);
  });

  it('continue, run-again and clear: the same resolutions as the UI\'s', async () => {
    const a = await boot();
    const one = await failed(a, 'HOPPER_FAILED the tests do not pass');
    const cont = await hopper(a, ['handoff', 'continue', one.handoff.id, '--note', 'Skip the flaky test.']);
    expect(cont.code).toBe(0);
    const next = JSON.parse(cont.out).job as Job;
    expect(String(next.spec.payload.prompt)).toContain('Skip the flaky test.');

    const two = await failed(a, 'HOPPER_FAILED no credentials for the registry');
    const again = await hopper(a, ['handoff', 'run-again', two.handoff.id, '--note', 'Added the token.']);
    expect(JSON.parse(again.out).handoff).toMatchObject({ end: 'run_again', resolution: { action: 'fixed', note: 'Added the token.' } });
    const rerun = (await a.events('types=job.rerun')).find((e) => e.jobId === two.job.id);
    expect(rerun?.data).toEqual({ by: 'user', actor: CLI });

    const three = await failed(a, 'HOPPER_FAILED the issue is a duplicate');
    const noNote = await hopper(a, ['handoff', 'clear', three.handoff.id]);
    expect(noNote.code).toBe(2);
    expect(noNote.err).toMatch(/--note/);
    const cleared = await hopper(a, ['handoff', 'clear', three.handoff.id, '--note', 'A duplicate.']);
    expect(JSON.parse(cleared.out).handoff).toMatchObject({ end: 'wont_do', resolution: { action: 'wont_do', note: 'A duplicate.' } });
  });

  it('usage and refusals: exit 2 with the reason', async () => {
    const a = await boot();
    expect((await hopper(a, ['handoff', 'done', 'nope', '--note', 'x'])).err).toMatch(/hand-off nope not found/);
    expect((await hopper(a, ['handoff', 'done', 'nope', '--pr', 'not a link'])).err).toMatch(/http or https/);
    expect((await hopper(a, ['handoff', 'shrug', 'nope'])).err).toMatch(/usage: hopper handoff/);
    expect((await hopper(a, ['problem', 'release', 'nope'])).err).toMatch(/problem nope not found/);
  });
});

describe('failures from the CLI (issue #623)', () => {
  it('list the open failures and run one again: job.rerun names the CLI', async () => {
    const a = await boot();
    const job = await a.pull({ op: 'fail', message: 'HOPPER_FAILED the tests do not pass', ms: 0 });
    const record = await waitFor(async () => (await failuresOf(a)).recent.find((r) => r.jobId === job.id && r.outcome === 'surfaced'), { what: 'surfaced' });
    const list = await hopper(a, ['failure', 'list']);
    expect((JSON.parse(list.out) as { id: string }[]).map((r) => r.id)).toContain(record.id);
    const r = await hopper(a, ['failure', 'retry', record.id]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ rerunOf: job.id });
    const rerun = (await a.events('types=job.rerun')).find((e) => e.jobId === job.id);
    expect(rerun?.data).toEqual({ by: 'user', actor: CLI });
  });
});
