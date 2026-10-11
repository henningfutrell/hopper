// Specialty jobs (issue #762) over the real HTTP server and database: only an item labelled hopper:specialty makes a
// job designated specialty, the one kind of job that may elbow in past a machine's lane cap.
import { afterEach, describe, expect, it } from 'vitest';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

async function start(): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  t = await startTestApp({ dbPath: db.dbPath });
  return t;
}

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

describe('designating a specialty job', () => {
  it('a source item labelled hopper:specialty makes a specialty job', async () => {
    const a = await start();
    const job = await a.pull({ op: 'echo' }, { labels: ['hopper', 'hopper:specialty'] });
    expect(job.spec.specialty).toBe(true);
  });

  it('an item without the label makes an ordinary job, whatever its priority', async () => {
    const a = await start();
    const job = await a.pull({ op: 'echo' }, { labels: ['hopper'], priority: 100 });
    expect(job.spec.specialty).toBeUndefined();
  });
});
