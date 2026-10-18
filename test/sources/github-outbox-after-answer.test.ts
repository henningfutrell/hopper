// Issue #1238 part 5: the other give-backs — Failures' Retry, a hand-off's Continue and I fixed it, Push it, Tend again —
// are rows of the GitHub outbox too. The row names the run (`target`, the record, hand-off or job the act names, and the
// person's `input`), so the sync loop checks it again and runs it at the send, after a restart too. One row per job; the
// same act again answers the one on its way. A row sent again once its run moved the job on makes nothing more; a run
// that fails records `job.give_back_failed` once and fails the row, and the act again sends it again.
import { afterEach, describe, expect, it } from 'vitest';
import type { GiveBackChecked, GiveBackRun } from '../../src/domain/give-back.ts';
import type { OutboxRow } from '../../src/domain/github-outbox.ts';
import { createGitHubOutbox, memoryGitHubOutbox } from '../../src/sources/github/outbox.ts';
import { createSourceSync } from '../../src/sources/sync.ts';
import { createFakeSource, createWorld, item, settle } from './sync-support.ts';

const REPO = 'owner/hopper-sandbox';
const PAT = { person: 'Pat', via: 'ui' as const };

describe('the give-backs after the answer in the GitHub outbox (issue #1238 part 5)', () => {
  let stop: (() => Promise<void>) | undefined;
  afterEach(async () => { await stop?.(); stop = undefined; });

  async function setup() {
    const world = createWorld();
    const rows = memoryGitHubOutbox();
    const outbox = createGitHubOutbox({ source: 'fake', rows, clock: world.clock });
    const source = createFakeSource();
    Object.assign(source, {
      async rerun() { return item('k1'); },
      giveBackAct: (job: { id: string; source?: { key: string } }, act: 'retry', acting?: typeof PAT, more?: Record<string, unknown>) =>
        outbox.giveBackAct(job.source!.key, REPO, act, job.id, acting, more),
      flushOutbox: (acts?: Parameters<NonNullable<typeof source.flushOutbox>>[0]) => outbox.flush(async (_repo, _key, change) => {
        if (change.op === 'give_back') await acts!.giveBack(change);
      }, (r: OutboxRow, error: string) => { if (r.change.op === 'give_back') acts!.giveBackFailed(r.change, error); }),
    });
    /** What each check saw, what its runs answer next, and the ids a check refuses now. */
    const seen: { act: string; id: string; input: unknown; acting: unknown }[] = [];
    const runAnswers: GiveBackRun[] = [];
    const refused = new Map<string, string>();
    let runs = 0;
    const started = () => {
      const s = createSourceSync({ sources: [source], host: world.host, clock: world.clock, pollMs: () => 60_000 });
      s.giveBackChecks((act, id, acting, input): GiveBackChecked => {
        if (refused.has(id)) return { ok: false, reason: 'conflict', message: refused.get(id)! };
        return {
          ok: true, jobId: 'job-1',
          run: async () => {
            runs++;
            seen.push({ act, id, input, acting });
            const next = runAnswers.shift();
            if (next) return next;
            const r = await s.rerun('job-1', 'user', undefined, acting);
            return r.ok ? { ok: true } : r;
          },
        };
      });
      stop = () => s.stop();
      s.start();
      return s;
    };
    const sync = started();
    source.items = [item('k1')];
    await sync.syncNow();
    source.items = [];
    world.patchJob('job-1', { status: 'failed' });
    world.emit('job.failed', 'job-1', {});
    await settle();
    const failures: Record<string, unknown>[] = [];
    world.store.events.subscribe((e) => { if (e.type === 'job.give_back_failed') failures.push(e.data); });
    const sent = async () => { for (let i = 0; i < 20; i++) await settle(); };
    const restart = async () => { await stop?.(); return started(); };
    return { world, rows, sync, restart, sent, seen, runAnswers, refused, runs: () => runs, failures };
  }

  it('Retry: one row naming the record; sent at once; the same act again answers the one on its way; the run follows once', async () => {
    const { world, rows, sync, sent, seen, runs } = await setup();
    expect(sync.afterAnswer('retry', 'rec-1', PAT)).toEqual({ ok: true, jobId: 'job-1', giveBack: 'retry' });
    expect(sync.afterAnswer('retry', 'rec-1', PAT)).toEqual({ ok: true, jobId: 'job-1', giveBack: 'retry' });
    expect(rows.of('fake', 'k1').map((r) => r.change)).toEqual([
      { op: 'give_back', act: 'retry', jobId: 'job-1', acting: PAT, target: 'rec-1', at: world.clock.now().toISOString() },
    ]);
    await sent();
    expect(runs()).toBe(1);
    expect(seen).toEqual([{ act: 'retry', id: 'rec-1', input: {}, acting: PAT }]);
    expect([...world.jobs.values()].filter((j) => j.rerunOf === 'job-1').map((j) => j.id)).toEqual(['job-2']);
    expect(rows.of('fake', 'k1').map((r) => r.state)).toEqual(['sent']);
  });

  it('I fixed it: the note and the link travel with the row to the run', async () => {
    const { rows, sync, sent, seen } = await setup();
    sync.afterAnswer('fixed', 'h-1', PAT, { note: 'Fixed the fixture.', link: 'https://example.com/fix' });
    expect(rows.of('fake', 'k1')[0]!.change).toMatchObject({ act: 'fixed', target: 'h-1', input: { note: 'Fixed the fixture.', link: 'https://example.com/fix' } });
    await sent();
    expect(seen).toEqual([{ act: 'fixed', id: 'h-1', input: { note: 'Fixed the fixture.', link: 'https://example.com/fix' }, acting: PAT }]);
  });

  it('a check that refuses now is answered with why, and keeps no row', async () => {
    const { rows, sync, refused } = await setup();
    refused.set('rec-1', 'failure rec-1 cannot run again: it already ran again');
    expect(sync.afterAnswer('retry', 'rec-1', PAT)).toEqual({ ok: false, reason: 'conflict', message: 'failure rec-1 cannot run again: it already ran again' });
    expect(rows.of('fake', 'k1')).toEqual([]);
  });

  it('a row a stopped hopper left is sent after the start: checked again and run', async () => {
    const { world, rows, restart, sent, runs, seen } = await setup();
    rows.add([{ source: 'fake', repo: REPO, key: 'k1', act: 'push', tag: 'job-1', createdBy: 'Pat',
      change: { op: 'give_back', act: 'push', jobId: 'job-1', acting: PAT, target: 'job-1', input: { note: 'The branch is shed-blue.' }, at: world.clock.now().toISOString() } }], world.clock.now().toISOString());
    await restart();
    await sent();
    expect(runs()).toBe(1);
    expect(seen).toEqual([{ act: 'push', id: 'job-1', input: { note: 'The branch is shed-blue.' }, acting: PAT }]);
    expect(rows.of('fake', 'k1').map((r) => r.state)).toEqual(['sent']);
  });

  it('a row sent again once its run moved the job on (a restart between the two) makes nothing more and fails nothing', async () => {
    const { world, rows, sync, restart, sent, runs, refused, failures } = await setup();
    sync.afterAnswer('retry', 'rec-1', PAT);
    await sent();
    expect(world.jobs.size).toBe(2);
    const [row] = rows.of('fake', 'k1');
    rows.update([row!.id], { state: 'sending', sentAt: undefined, nextAt: row!.createdAt }); // left sending, its claim ended (issue #1959)
    // Its check now refuses: the record already ran again.
    refused.set('rec-1', 'failure rec-1 cannot run again: it already ran again');
    await restart();
    await sent();
    expect(runs()).toBe(1);
    expect(world.jobs.size).toBe(2);
    expect(failures).toEqual([]);
    expect(rows.of('fake', 'k1').map((r) => r.state)).toEqual(['sent']);
  });

  it('a check that refuses at the send, the job not moved on, fails the row and says it once', async () => {
    const { world, rows, restart, sent, refused, failures, runs } = await setup();
    rows.add([{ source: 'fake', repo: REPO, key: 'k1', act: 'continue', tag: 'job-1',
      change: { op: 'give_back', act: 'continue', jobId: 'job-1', acting: PAT, target: 'h-1', at: world.clock.now().toISOString() } }], world.clock.now().toISOString());
    refused.set('h-1', 'hand-off h-1 is closed');
    await restart();
    await sent();
    expect(runs()).toBe(0);
    expect(failures).toEqual([{ act: 'continue', error: 'hand-off h-1 is closed', ...PAT }]);
    expect(rows.of('fake', 'k1').map((r) => r.state)).toEqual(['failed']);
  });

  it('a run that fails records job.give_back_failed once and fails the row; the act again sends it again', async () => {
    const { world, rows, sync, sent, runAnswers, runs, failures } = await setup();
    runAnswers.push({ ok: false, message: 'its source could not give the item back: issue locked' });
    expect(sync.afterAnswer('retry', 'rec-1', PAT)).toMatchObject({ ok: true });
    await sent();
    expect(runs()).toBe(1);
    expect(failures).toEqual([{ act: 'retry', error: 'its source could not give the item back: issue locked', ...PAT }]);
    expect(rows.of('fake', 'k1')).toMatchObject([{ state: 'failed', attempts: 1 }]);
    expect(sync.afterAnswer('retry', 'rec-1', PAT)).toEqual({ ok: true, jobId: 'job-1', giveBack: 'retry' });
    await sent();
    expect(runs()).toBe(2);
    expect(world.jobs.size).toBe(2);
    expect(failures).toHaveLength(1);
    expect(rows.of('fake', 'k1').map((r) => r.state)).toEqual(['sent']);
  });
});
