// The sync loop's rule for a failed job whose work landed (issues #350, #1067): the work-item ledger decides. A read of the
// source is asked only when the ledger does not hold the item's issue closed, and is recorded as ledger input first.
import { afterEach, describe, expect, it } from 'vitest';
import { SourceError } from '../../src/domain/ports.ts';
import { applyEvent, type WorkItem } from '../../src/domain/work-items.ts';
import type { DomainEvent, EventType } from '../../src/domain/types.ts';
import { createSourceSync } from '../../src/sources/sync.ts';
import { createFakeSource, createWorld, item, settle, type FakeSource, type World } from './sync-support.ts';

let sync: ReturnType<typeof createSourceSync> | undefined;
afterEach(async () => { await sync?.stop(); sync = undefined; });

async function setup() {
  const world: World = createWorld();
  const source = createFakeSource();
  sync = createSourceSync({ sources: [source], host: world.host, clock: world.clock, pollMs: () => 60_000 });
  sync.start();
  await sync.syncNow();
  return { world, source, sync };
}

const kinds = (s: FakeSource) => s.reports.map((r) => r.kind);

describe('a failed job whose issue closed as complete: the ledger decides (issues #350, #1067)', () => {
  /** A ledger for the world: the real reducer over its events, the job `job-1` working `k1`. */
  function ledger(world: World): Map<string, WorkItem> {
    const items = new Map<string, WorkItem>();
    const job = { id: 'job-1', key: 'k1', kind: 'fake' };
    const fold = (type: EventType, data: Record<string, unknown> = {}) => {
      const next = applyEvent(items.get('k1'), { type, at: new Date().toISOString(), data }, 'k1', job);
      if (next) items.set('k1', next);
    };
    fold('job.queued');
    (world.store as unknown as { workItems: unknown }).workItems = { get: (key: string) => items.get(key) };
    world.store.events.subscribe((e: DomainEvent) => { if (e.type.startsWith('work_item.') || e.jobId === 'job-1') fold(e.type, e.data); });
    return items;
  }

  async function failed(read: Awaited<ReturnType<NonNullable<FakeSource['issueState']>>> | Error) {
    const ctx = await setup();
    const asked: string[] = [];
    ctx.source.issueState = async (job) => { asked.push(job.id); if (read instanceof Error) throw read; return read; };
    ctx.source.items = [item('k1')];
    await ctx.sync.syncNow();
    // Its issue is offered no more: the source no longer lists it once its job ended.
    ctx.source.items = [];
    const items = ledger(ctx.world);
    return { ...ctx, asked, items, fail: async () => { ctx.world.patchJob('job-1', { status: 'failed' }); ctx.world.emit('job.failed', 'job-1', { error: 'pane ended' }); await settle(); await ctx.sync.syncNow(); } };
  }

  it('the ledger holds its issue closed as complete already: finished, and GitHub is not asked', async () => {
    const { world, source, asked, items, fail } = await failed({ state: 'open' });
    world.store.events.append({ type: 'work_item.issue_closed', data: { key: 'k1', reason: 'completed', via: 'delivery' } });
    await fail();
    expect(asked).toEqual([]);
    expect(world.jobs.get('job-1')!.status).toBe('finished');
    expect(kinds(source)).toEqual(['claimed', 'finished']);
    expect(items.get('k1')?.state).toBe('done');
  });

  it('the ledger does not know: the source reads the issue, the read is a ledger event, and the ledger\'s answer finishes the job', async () => {
    const { world, source, asked, items, fail } = await failed({ state: 'closed', reason: 'completed' });
    const recorded: string[] = [];
    world.store.events.subscribe((e: DomainEvent) => { if (e.type.startsWith('work_item.')) recorded.push(`${e.type} ${String(e.data.via)}`); });
    await fail();
    expect(asked).toEqual(['job-1']);
    expect(recorded).toEqual(['work_item.issue_closed read']);
    expect(world.jobs.get('job-1')!.status).toBe('finished');
    expect(kinds(source)).toEqual(['claimed', 'finished']);
    expect(items.get('k1')?.state).toBe('done');
  });

  it('open, or closed as not planned: the failure is reported', async () => {
    for (const read of [{ state: 'open' as const }, { state: 'closed' as const, reason: 'not_planned' }]) {
      const { world, source, fail } = await failed(read);
      await fail();
      expect(world.jobs.get('job-1')!.status).toBe('failed');
      expect(kinds(source)).toEqual(['claimed', 'failed']);
      await sync?.stop();
    }
  });

  it('a read that fails is asked again at the next sync; the failure waits', async () => {
    const { world, source, asked, fail } = await failed(new SourceError('boom', false, 502));
    await fail();
    expect(kinds(source)).toEqual(['claimed']);
    const before = asked.length;
    await sync!.syncNow();
    expect(asked).toHaveLength(before + 1);
    expect(world.jobs.get('job-1')!.status).toBe('failed');
  });
});
