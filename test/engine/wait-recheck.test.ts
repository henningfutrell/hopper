// Issue #2459: a wait on an outside event the hopper cannot see, with a long check-in the job named (`check: in 12h`), is
// woken at that time and not before, by any hopper on the same database. Against the real database.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecutorRegistry, UserStore } from '../../src/domain/ports.ts';
import type { Job, JobWait } from '../../src/domain/types.ts';
import { MAX_EVERY_MS } from '../../src/domain/wait-checks.ts';
import { createWaitChecks } from '../../src/engine/wait-checks.ts';
import { openUserStore } from '../../src/store/user-store.ts';
import { testDatabaseUrl } from '../support/database.ts';

const T0 = Date.parse('2026-10-22T03:00:00.000Z');
const H = 3600_000;
let now = T0;
const clock = { now: () => new Date(now) };
const opened: UserStore[] = [];
const noExecutors = { get: () => undefined, names: () => [] } as unknown as ExecutorRegistry;
const noReads = { async endedWatched() { return []; } };

afterEach(() => {
  for (const s of opened.splice(0)) s.close();
  now = T0;
});

function hopper(url: string) {
  const store = openUserStore({ url, clock, idGen: randomUUID });
  opened.push(store);
  const checks = createWaitChecks({ store, clock, executors: noExecutors, stopping: () => false, trigger: () => {}, ownCommandGraceMs: 300_000, waitReads: noReads }, { owner: randomUUID() });
  return { store, checks };
}

function waitingJob(store: UserStore, wait: Partial<JobWait>): Job {
  const job = store.jobs.create({ executor: 'x', payload: {} }, 50, { source: 's', kind: 'github', key: 'https://github.com/octo/tools/issues/7', repo: 'octo/tools', number: 7 });
  return store.jobs.update(job.id, { status: 'waiting_on', wait: { for: 'the gitops apply', since: new Date(now).toISOString(), ...wait } });
}

const ended = (s: UserStore, id: string) => s.events.recent(50, ['job.wait_ended'], id);

describe('a recheck at a long check-in (issue #2459)', () => {
  it('no hopper wakes a gated outside wait before the time its check-in names; at it, the wait ends once', async () => {
    const url = testDatabaseUrl(), a = hopper(url), b = hopper(url);
    const job = waitingJob(a.store, { on: { kind: 'outside', what: 'the gitops apply', why: 'gated' }, checkLine: 'in 12h' });
    const at = new Date(T0 + 12 * H).toISOString();
    for (now = T0; now < T0 + 12 * H; now += MAX_EVERY_MS / 2) {
      await a.checks.run();
      await b.checks.run();
      expect(a.store.jobs.get(job.id)!.status).toBe('waiting_on');
    }
    expect(ended(a.store, job.id)).toHaveLength(0);
    expect(a.store.jobs.get(job.id)!.wait!.check).toMatchObject({ condition: { kind: 'recheck', at }, nextCheckAt: at });

    now = T0 + 12 * H;
    await b.checks.run();
    await a.checks.run();
    expect(b.store.jobs.get(job.id)).toMatchObject({ status: 'queued', pendingAnswer: expect.stringContaining('cannot see what you wait on (the gitops apply)') });
    expect(ended(b.store, job.id)).toHaveLength(1);
    expect(ended(b.store, job.id)[0]!.data).toMatchObject({ by: 'hopper', check: `recheck:${at}` });
  });
});
