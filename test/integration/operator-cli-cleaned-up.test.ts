// Issue #2427: an ended job's cleanup waited for a seat that was removed on purpose, and every later job of its item was
// held. The Mark closed button is only on the jobs that ended in the last day; the operator CLI gives the same act from
// the host, `hopper job cleaned-up <id>`, which makes the UI's own POST /ui/api/jobs/:id/cleaned-up call on the running
// daemon. Real daemon, real CLI, real database.
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import { databaseUrlFor } from '../support/database.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;
afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

async function hopper(a: TestApp, argv: string[]) {
  const err: string[] = [];
  const io: CliIo = { env: { HOPPER_DATABASE_URL: databaseUrlFor(a.dbPath) }, stdin: () => '', out: () => {}, err: (x) => err.push(x) };
  const code = await runCli([...argv, '--url', a.url], io);
  return { code, err: err.join('') };
}

describe('hopper job cleaned-up (issue #2427)', () => {
  it('marks a deferred cleanup done, as Mark closed does; a job with none is refused', async () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    const a = t = await startTestApp({ dbPath: db.dbPath, plugins: { machines: lanes(1) } });
    const job = await a.pull({ op: 'echo' });
    await a.waitForStatus(job.id, 'finished');
    a.user().store.jobs.update(job.id, { cleanupDeferred: { at: new Date().toISOString(), error: 'ssh: Could not resolve hostname' } });

    expect(await hopper(a, ['job', 'cleaned-up', job.id])).toMatchObject({ code: 0 });
    expect((await a.job(job.id)).cleanupDeferred).toBeUndefined();
    const marked = (await a.events()).filter((e) => e.type === 'job.cleaned_up' && e.jobId === job.id);
    expect(marked.map((e) => (e.data as { by?: string }).by)).toEqual(['user']);

    const again = await hopper(a, ['job', 'cleaned-up', job.id]);
    expect(again.code).not.toBe(0);
    expect(again.err).toContain('has no deferred cleanup');
  });
});
