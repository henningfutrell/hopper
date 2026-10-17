// A test daemon starts no held-loop thread (issue #1717). The thread (issue #1383, src/http/event-loop-held.ts) pauses the
// main thread through the inspector while the event loop is held, and is ended with the daemon. A test process starts and
// stops many daemons, and a worker of it then stopped with SIGABRT in the full suite. The thread's own tests are
// test/http/event-loop.test.ts.
import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { startTestApp, tempDbPath, TEST_PLUGINS, writePlugins, type TestApp } from '../support/app.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

/** The worker threads of this process: Node names each one `WorkerThread`. */
const workerThreads = (): number =>
  readdirSync('/proc/self/task').filter((id) => {
    try { return readFileSync(`/proc/self/task/${id}/comm`, 'utf8').trim() === 'WorkerThread'; } catch { return false; }
  }).length;

describe('a test daemon (issue #1717)', () => {
  it('starts no thread that reads a held event loop', async () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    // The store's own thread (src/store/db.ts) starts with the first database call: before the count.
    writePlugins(db.dbPath, TEST_PLUGINS);
    const before = workerThreads();
    t = await startTestApp({ dbPath: db.dbPath });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(workerThreads()).toBe(before);
  });
});
