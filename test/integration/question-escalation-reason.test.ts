// Issue #679: why a question came to a person is a typed field on it — over the real HTTP server, the real database and
// the real operator CLI. The API filters the open questions by it, and `hopper question list` prints them as JSON.
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import type { Question } from '../../src/domain/types.ts';
import { databaseUrlFor } from '../support/database.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

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
  t = await startTestApp({ dbPath: db.dbPath });
  return t;
}

async function hopper(a: TestApp, argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { env: { HOPPER_DATABASE_URL: databaseUrlFor(a.dbPath) }, stdin: () => '', out: (x) => out.push(x), err: (x) => err.push(x) };
  const code = await runCli([...argv, '--url', a.url], io);
  return { code, out: out.join(''), err: err.join('') };
}

const ask = (message: string) => ({ op: 'ask', message });
const ids = async (a: TestApp, path: string) => (await a.api<{ questions: Question[] }>('GET', path)).body.questions.map((x) => x.id);

describe('the escalation reason (issue #679)', () => {
  it('on the question in the API; the open list filters by it; the CLI lists it as JSON', async () => {
    const a = await boot();
    // The fake opus answers it; the delete risk rule holds the answer back: a guard.
    const guarded = await a.pull(ask('Should I delete the old branch?'));
    const g = await a.waitForQuestion(guarded.id, (x) => x.tier === 'human');
    // Every level escalates what is risky: the top level sent it up.
    const up = await a.pull(ask('Is this risky?'));
    const u = await a.waitForQuestion(up.id, (x) => x.tier === 'human');

    const one = (await a.api<Question>('GET', `/api/questions/${g.id}`)).body;
    expect(one.escalation).toMatchObject({ reason: 'guard', guards: [{ name: 'delete', describe: expect.any(String) }], recommendation: { by: 'opus', answer: 'fake opus answer' } });
    expect(u.escalation).toMatchObject({ reason: 'frontier_escalated', recommendation: { by: 'fable' } });

    expect(await ids(a, '/api/questions?reason=guard')).toEqual([g.id]);
    expect(await ids(a, '/api/questions?reason=frontier_escalated')).toEqual([u.id]);
    expect(await ids(a, '/api/questions?reason=low_confidence')).toEqual([]);
    expect((await a.api('GET', '/api/questions?reason=bogus')).status).toBe(400);

    const all = await hopper(a, ['question', 'list']);
    expect(all.code).toBe(0);
    expect((JSON.parse(all.out) as Question[]).map((q) => [q.id, q.escalation?.reason])).toEqual([[g.id, 'guard'], [u.id, 'frontier_escalated']]);
    const guards = await hopper(a, ['question', 'list', '--reason', 'guard']);
    expect((JSON.parse(guards.out) as Question[]).map((q) => q.id)).toEqual([g.id]);
    const bad = await hopper(a, ['question', 'list', '--reason', 'bogus']);
    expect(bad.code).toBe(2);
  });
});
