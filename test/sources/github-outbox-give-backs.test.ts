// Issue #1238 part 4: Run again and Rework are rows of the GitHub outbox. The act is one row per job; a second act on the
// same job while its row is on its way answers that one. The row is its own call, after the labels of its issue, and no
// intake marker. Over the sync loop: the row is sent at once, the new job follows, a row sent again after its new job was
// made (a restart between the two) makes no second job, a refusal for now waits its backoff, and one GitHub refuses for
// good records `job.give_back_failed` once; the act sent again sends its failed row again.
import { afterEach, describe, expect, it } from 'vitest';
import { SourceError } from '../../src/domain/ports.ts';
import type { OutboxChange, OutboxRow } from '../../src/domain/github-outbox.ts';
import { createGitHubOutbox, memoryGitHubOutbox } from '../../src/sources/github/outbox.ts';
import { createSourceSync } from '../../src/sources/sync.ts';
import { createFakeSource, createWorld, item, settle } from './sync-support.ts';

const REPO = 'owner/hopper-sandbox';
const url = (n: number) => `https://github.com/${REPO}/issues/${n}`;
const PAT = { person: 'Pat', via: 'ui' as const };

describe('Run again and Rework in the GitHub outbox (issue #1238 part 4)', () => {
  function counting() {
    const calls: [string, string, OutboxChange][] = [];
    const outbox = createGitHubOutbox({ source: 'github', rows: memoryGitHubOutbox(), clock: { now: () => new Date('2026-10-15T10:00:00.000Z') } });
    const send = async (repo: string, key: string, change: OutboxChange) => { calls.push([repo, key, change]); };
    return { calls, outbox, flush: () => outbox.flush(send) };
  }

  it('the act is one row; a second act on the same job answers the one on its way; one call is sent', async () => {
    const { calls, outbox, flush } = counting();
    expect(outbox.giveBackAct(url(1), REPO, 'rerun', 'j1', PAT)).toBe('rerun');
    expect(outbox.giveBackAct(url(1), REPO, 'rerun', 'j1', PAT)).toBe('rerun');
    expect(outbox.giveBackAct(url(1), REPO, 'rework', 'j1', PAT, 'Rename the flag.')).toBe('rerun');
    expect(outbox.detail()).toMatchObject({ writeBehindPending: 1 });
    // The act shows on the job, not as an intake item's write.
    expect(outbox.of(url(1))).toBeUndefined();
    expect(await flush()).toEqual({ due: 1, wrote: [REPO] });
    expect(calls).toEqual([[REPO, url(1), { op: 'give_back', act: 'rerun', jobId: 'j1', acting: PAT }]]);
    // Sent: a new act on the job is a new row, with its notes.
    expect(outbox.giveBackAct(url(1), REPO, 'rework', 'j1', PAT, 'Rename the flag.')).toBe('rework');
    await flush();
    expect(calls[1]![2]).toEqual({ op: 'give_back', act: 'rework', jobId: 'j1', acting: PAT, notes: 'Rename the flag.' });
  });

  it('the act is its own call, after the labels of its issue', async () => {
    const { calls, outbox, flush } = counting();
    outbox.giveBackAct(url(1), REPO, 'rerun', 'j1', PAT);
    outbox.queue('release', url(1), REPO, [{ change: { op: 'remove_labels', labels: ['hopper:claimed'] } }]);
    await flush();
    expect(calls.map(([, , c]) => c.op)).toEqual(['remove_labels', 'give_back']);
  });
});

describe('a give-back row sent by the sync loop (issue #1238 part 4)', () => {
  let stop: (() => Promise<void>) | undefined;
  afterEach(async () => { await stop?.(); stop = undefined; });

  /** A source whose give-backs are outbox rows; `rerunError`: what its next give-backs throw, in order. */
  async function setup() {
    const world = createWorld();
    const rows = memoryGitHubOutbox();
    const outbox = createGitHubOutbox({ source: 'fake', rows, clock: world.clock });
    const rerunError: Error[] = [];
    let reruns = 0;
    const source = createFakeSource();
    Object.assign(source, {
      async rerun() { reruns++; const e = rerunError.shift(); if (e) throw e; return item('k1'); },
      giveBackAct: (job: { id: string; source?: { key: string } }, act: 'rerun' | 'rework', acting?: typeof PAT, notes?: string) =>
        outbox.giveBackAct(job.source!.key, REPO, act, job.id, acting, notes),
      flushOutbox: (acts?: Parameters<NonNullable<typeof source.flushOutbox>>[0]) => outbox.flush(async (_repo, _key, change) => {
        if (change.op === 'give_back') await acts!.giveBack(change);
      }, (r: OutboxRow, error: string) => { if (r.change.op === 'give_back') acts!.giveBackFailed(r.change, error); }),
    });
    const started = () => { const s = createSourceSync({ sources: [source], host: world.host, clock: world.clock, pollMs: () => 60_000 }); stop = () => s.stop(); s.start(); return s; };
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
    /** The sync loop stopped and started again: its outbox sends the rows due at the start. */
    const restart = async () => { await stop?.(); return started(); };
    return { world, rows, outbox, sync, restart, rerunError, reruns: () => reruns, failures, sent };
  }

  it('Run again: answered at once, sent at once, and the new job follows; the same act again answers the one on its way', async () => {
    const { world, sync, reruns, sent } = await setup();
    expect(sync.giveBack('job-1', { kind: 'rerun' }, PAT)).toEqual({ ok: true, jobId: 'job-1', giveBack: 'rerun' });
    expect(sync.giveBack('job-1', { kind: 'rerun' }, PAT)).toEqual({ ok: true, jobId: 'job-1', giveBack: 'rerun' });
    await sent();
    expect(reruns()).toBe(1);
    expect([...world.jobs.values()].filter((j) => j.rerunOf === 'job-1').map((j) => j.id)).toEqual(['job-2']);
  });

  it('a row sent again after its new job was made (a restart between the two) makes no second job and fails nothing', async () => {
    const { world, rows, sync, restart, reruns, failures, sent } = await setup();
    sync.giveBack('job-1', { kind: 'rerun' }, PAT);
    await sent();
    expect(world.jobs.size).toBe(2);
    // The process stopped before the row was marked sent: it is sent again after the start.
    const [row] = rows.of('fake', 'k1');
    rows.update([row!.id], { state: 'pending', sentAt: undefined });
    await restart();
    await sent();
    expect(world.jobs.size).toBe(2);
    expect(reruns()).toBe(1);
    expect(failures).toEqual([]);
    expect(rows.of('fake', 'k1').map((r) => r.state)).toEqual(['sent']);
  });

  it('a refusal for now waits its backoff; one for good records job.give_back_failed once; Run again sends it again', async () => {
    const { world, rows, sync, rerunError, reruns, failures, sent } = await setup();
    rerunError.push(new SourceError('GitHub is out of reach', false), new SourceError('issue locked', true, 403));
    sync.giveBack('job-1', { kind: 'rerun' }, PAT);
    await sent();
    expect(reruns()).toBe(1);
    expect(failures).toEqual([]);
    expect(rows.of('fake', 'k1')).toMatchObject([{ state: 'pending', attempts: 1, lastError: 'GitHub is out of reach' }]);
    // On its way: the same act answers it, and sends it once its backoff ended.
    world.clock.advance(5_000);
    expect(sync.giveBack('job-1', { kind: 'rerun' }, PAT)).toEqual({ ok: true, jobId: 'job-1', giveBack: 'rerun' });
    await sent();
    expect(reruns()).toBe(2);
    expect(failures).toEqual([{ act: 'rerun', error: 'issue locked', ...PAT }]);
    expect(world.jobs.size).toBe(1);
    expect(sync.giveBack('job-1', { kind: 'rerun' }, PAT)).toEqual({ ok: true, jobId: 'job-1', giveBack: 'rerun' });
    await sent();
    expect(reruns()).toBe(3);
    expect(world.jobs.size).toBe(2);
    expect(failures).toHaveLength(1);
  });
});
