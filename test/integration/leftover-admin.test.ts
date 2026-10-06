// The leftover default admin account (issue #265), through the real daemon: a hopper from before whose
// first GitHub admin signs in as a user of their own starts with that one user, holding admin's work.
import { afterEach, describe, expect, it } from 'vitest';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

describe('the leftover default admin account at start (issue #265)', () => {
  it('is folded into the first GitHub admin\'s user: one user, holding both users\' jobs', async () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    t = await startTestApp({ dbPath: db.dbPath });
    const adminJob = await t.pull({ op: 'sleep', ms: 1 }, { title: 'admin work' });
    const octo = await t.addUser('octo');
    const octoJob = await t.pull({ op: 'sleep', ms: 1 }, { title: 'octo work' }, octo.id);
    const instance = t.app.instance;
    instance.identities.link('github', '42', octo.id);
    instance.signInConfig.write({ ...instance.signInConfig.read(), githubAdmin: { realm: 'github', subject: '42' } }, instance.signInConfig.version());
    await t.stop();

    t = await startTestApp({ dbPath: db.dbPath });
    expect(t.app.users().map((u) => [u.id, u.name])).toEqual([['octo', 'octo']]);
    const jobs = (await t.api<{ jobs: { id: string }[] }>('GET', '/api/jobs')).body.jobs.map((j) => j.id);
    expect(jobs).toEqual(expect.arrayContaining([adminJob.id, octoJob.id]));
  });
});
