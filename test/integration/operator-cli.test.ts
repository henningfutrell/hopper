// Issue #374: a script acts as the operator through the CLI, not by pretending to be a browser and not by
// writing rows behind the daemon's back. `hopper job|queue|question …` makes the same POST /ui/api/* call the
// UI makes, on the running daemon, under a UI session the CLI mints in the database for that one call (the
// CLI holds the database's credentials: the daemon's own trust) and drops after it. Real daemon, real CLI.
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import type { Job, Question } from '../../src/domain/types.ts';
import { openInstanceStore } from '../../src/store/index.ts';
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

async function boot(o: Omit<Parameters<typeof startTestApp>[0], 'dbPath'> = {}): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  t = await startTestApp({ dbPath: db.dbPath, plugins: { machines: lanes(1) }, ...o });
  return t;
}

async function hopper(a: TestApp, argv: string[], url = a.url) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { env: { HOPPER_DATABASE_URL: databaseUrlFor(a.dbPath) }, stdin: () => '', out: (x) => out.push(x), err: (x) => err.push(x) };
  const code = await runCli([...argv, '--url', url], io);
  return { code, out: out.join(''), err: err.join('') };
}

function sessionsIn(a: TestApp): number {
  const s = openInstanceStore({ url: databaseUrlFor(a.dbPath), clock: { now: () => new Date() } });
  try { return s.uiSessions.all().length; } finally { s.close(); }
}

const queue = async (a: TestApp) => (await a.api('GET', '/api/queue')).body;

describe('operator actions from the CLI (issue #374)', () => {
  it('queue gate, accept and order go through the daemon, with its events; no session is left behind', async () => {
    const a = await boot();
    const before = sessionsIn(a);
    const gate = await hopper(a, ['queue', 'gate', 'review']);
    expect(gate).toMatchObject({ code: 0 });
    expect(JSON.parse(gate.out)).toEqual({ gate: { mode: 'review', autoAcceptPerHour: null } });
    expect((await queue(a)).gate).toEqual({ mode: 'review', autoAcceptPerHour: null });
    expect((await a.events('types=queue.gate_changed')).at(-1)?.data).toMatchObject({ to: { mode: 'review', autoAcceptPerHour: null } });

    const blocker = await a.pull({ op: 'sleep', ms: 30000 });
    await a.waitForStatus(blocker.id, 'held');
    expect((await hopper(a, ['job', 'accept', blocker.id])).code).toBe(0);
    await a.waitForStatus(blocker.id, 'running');
    expect((await a.events('types=job.accepted')).find((e) => e.jobId === blocker.id)?.data).toEqual({ by: 'user' });

    const one = await a.pull({ op: 'echo' });
    const two = await a.pull({ op: 'echo' });
    await a.waitForStatus(two.id, 'held');
    expect((await hopper(a, ['queue', 'order', two.id, one.id])).code).toBe(0);
    expect((await queue(a)).waiting.map((j: Job) => j.id)).toEqual([two.id, one.id]);
    expect((await a.events('types=queue.ordered')).at(-1)?.data).toEqual({ jobIds: [two.id, one.id] });

    const limited = await hopper(a, ['queue', 'gate', 'auto-accept', '--per-hour', '5']);
    expect(JSON.parse(limited.out)).toEqual({ gate: { mode: 'auto-accept', autoAcceptPerHour: 5 } });
    expect(sessionsIn(a)).toBe(before);
  });

  it('accept joins the end of the user order, as the Queue view\'s Accept does', async () => {
    const a = await boot();
    await hopper(a, ['queue', 'gate', 'review']);
    const blocker = await a.pull({ op: 'sleep', ms: 30000 });
    await a.waitForStatus(blocker.id, 'held');
    await hopper(a, ['job', 'accept', blocker.id]);
    await a.waitForStatus(blocker.id, 'running');
    const first = await a.pull({ op: 'echo' });
    const second = await a.pull({ op: 'echo' });
    await a.waitForStatus(second.id, 'held');
    await hopper(a, ['job', 'accept', first.id]);
    await hopper(a, ['job', 'accept', second.id]);
    expect((await queue(a)).waiting.map((j: Job) => j.id)).toEqual([first.id, second.id]);
  });

  it('reject with a reason, then run it again: the job ends rejected, a new one is queued for it', async () => {
    const a = await boot();
    await hopper(a, ['queue', 'gate', 'review']);
    const job = await a.pull({ op: 'echo' });
    await a.waitForStatus(job.id, 'held');
    const r = await hopper(a, ['job', 'reject', job.id, '--reason', 'not now']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ id: job.id, status: 'rejected' });
    expect((await a.events('types=job.rejected')).find((e) => e.jobId === job.id)?.data).toEqual({ by: 'user', reason: 'not now' });
    await waitFor(async () => (await a.job(job.id)).sourceState?.sync?.finalReported === true, { what: 'the rejection reported' });
    const again = await hopper(a, ['job', 'rerun', job.id]);
    expect(again.code).toBe(0);
    expect(JSON.parse(again.out)).toMatchObject({ rerunOf: job.id });
  });

  it('answer, close and dismiss a question waiting on the human', async () => {
    const a = await boot({ seams: { levels: [] } });
    const job = await a.pull({ op: 'ask', message: 'Which colour?' });
    const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human');
    const r = await hopper(a, ['question', 'answer', q.id, 'blue']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out) as Question).toMatchObject({ status: 'answered', answeredBy: 'human', answer: 'blue' });
    expect((await a.waitForStatus(job.id, 'finished')).result).toEqual({ answer: 'blue' });

    const closing = await a.pull({ op: 'ask', message: 'Which size?' });
    const c = await a.waitForQuestion(closing.id, (x) => x.tier === 'human');
    expect(JSON.parse((await hopper(a, ['question', 'close', c.id])).out)).toMatchObject({ id: c.id, status: 'closed' });

    const dropping = await a.pull({ op: 'ask', message: 'Which shape?' });
    const d = await a.waitForQuestion(dropping.id, (x) => x.tier === 'human');
    expect(JSON.parse((await hopper(a, ['question', 'dismiss', d.id])).out)).toMatchObject({ id: d.id, status: 'dismissed' });
  });

  it('the daemon\'s refusal is the CLI\'s: its message, exit 2; nothing written', async () => {
    const a = await boot();
    const r = await hopper(a, ['question', 'answer', 'nope', 'x']);
    expect(r).toMatchObject({ code: 2, out: '' });
    expect(r.err).toMatch(/question nope not found/);
    expect((await hopper(a, ['job', 'reject', 'nope'])).err).toMatch(/job nope not found/);
    expect((await hopper(a, ['queue', 'gate', 'sometimes'])).err).toMatch(/auto-accept, review/);
    expect((await hopper(a, ['question', 'answer', 'nope'])).err).toMatch(/usage: hopper question answer <id> <text>/);
  });

  it('no daemon at the URL: says so, exit 1, and leaves no session behind', async () => {
    const a = await boot();
    const before = sessionsIn(a);
    const r = await hopper(a, ['queue', 'gate', 'review'], 'http://127.0.0.1:9');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/no hopper answers at http:\/\/127\.0\.0\.1:9/);
    expect(sessionsIn(a)).toBe(before);
  });
});
