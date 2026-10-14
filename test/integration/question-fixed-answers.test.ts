// Fixed answers over the real HTTP server and database (issue #629): a permission dialog inside the job's work tree is
// answered yes by the fixed answers, and the job resumes with it; the levels are never asked. A dialog outside the work
// tree still goes to the levels. The executor double reports its work tree and raises the dialog as herdr-claude does.
import { afterEach, describe, expect, it } from 'vitest';
import type { Executor } from '../../src/domain/ports.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

const TREE = '/work/jobs/fixed';
const dialogOn = (path: string) => ['Read file', `Read(${path})`, 'Do you want to proceed?', '1. Yes', '2. No'].join('\n');

/** Reports its work tree, raises a Read dialog on `path`, finishes with the answer it was given. */
function dialogExecutor(path: string): Executor {
  return {
    name: 'dialog',
    validate: () => null,
    async run(ctx) {
      ctx.workTree(TREE);
      return { kind: 'question', question: { text: dialogOn(path), recentOutput: '', detectedBy: 'blocked' } };
    },
    async resume(_ctx, answer) {
      return { kind: 'finished', result: { answer } };
    },
  };
}

async function start(path: string): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  t = await startTestApp({ dbPath: db.dbPath, env: {}, seams: { executors: [dialogExecutor(path)] } });
  return t;
}

describe('a permission dialog the allowed dialogs allow', () => {
  it('inside the work tree: answered yes without a level, and the job finishes with it', async () => {
    const a = await start(`${TREE}/README.md`);
    const job = await a.pull({}, { executor: 'dialog' });
    expect((await a.waitForStatus(job.id, 'finished')).result).toEqual({ answer: '1' });
    const [q] = await a.questionsOf(job.id);
    expect(q).toMatchObject({ status: 'answered', answeredBy: 'fixed', answer: '1' });
    expect(q!.attempts.map((x) => [x.tier, x.role, x.outcome])).toEqual([['fixed', 'fixed', 'accepted']]);
    const events = (await a.events()).filter((e) => e.jobId === job.id);
    expect(events.find((e) => e.type === 'question.answered')!.data).toMatchObject({ by: 'fixed', answer: '1' });
    expect(events.filter((e) => e.type === 'question.escalated')).toEqual([]);
  });

  it('outside the work tree: the levels answer it', async () => {
    const a = await start('/etc/hosts');
    const job = await a.pull({}, { executor: 'dialog' });
    await a.waitForStatus(job.id, 'finished');
    const [q] = await a.questionsOf(job.id);
    expect(q).toMatchObject({ status: 'answered', answeredBy: 'opus' });
  });
});
