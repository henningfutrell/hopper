// The drain watch (issue #2499): a drained machine that is online, has free lanes and could take a queued job is told once
// after DRAINED_IDLE_AFTER_MS (machine.drained_idle); a drain past its expiry is ended. Pure: no store, no clock.
import { describe, expect, it } from 'vitest';
import { DRAINED_IDLE_AFTER_MS, type MachineDrain, type MachineDrains } from '../../src/domain/machines.ts';
import type { Job, Lane, MachineSnapshot } from '../../src/domain/types.ts';
import { createDrainWatch, type DrainWatchEvent } from '../../src/machines/drain-watch.ts';

const t0 = Date.parse('2026-10-22T10:00:00.000Z');
const at = (min: number) => new Date(t0 + min * 60_000).toISOString();
const machine = (id: string, o: Partial<MachineSnapshot> = {}): MachineSnapshot =>
  ({ id, label: `seat ${id}`, online: true, maxLanes: 2, executors: ['claude'], ...o }) as unknown as MachineSnapshot;
const drain = (o: Partial<MachineDrain> = {}): MachineDrain => ({ person: 'Pat', via: 'ui', at: at(-60), reason: 'rebuild', until: at(24 * 60), ...o });
const queued = (id: string, executor = 'claude'): Job => ({ id, status: 'queued', spec: { executor } }) as unknown as Job;

function watch(o: { drains?: MachineDrains; queued?: Job[]; lanes?: Lane[] } = {}) {
  const told: DrainWatchEvent[] = [];
  const expired: string[][] = [];
  let reads = 0;
  const w = createDrainWatch({
    drains: () => o.drains ?? { l3: drain() },
    queued: () => { reads += 1; return o.queued ?? [queued('a'), queued('b')]; },
    lanes: () => o.lanes ?? [],
    expire: (ids) => { expired.push([...ids]); },
    tell: (e) => told.push(e),
  });
  return { told, expired, reads: () => reads, see: (ms: MachineSnapshot[], min: number) => w.observe(ms, at(min)) };
}

describe('the drain watch', () => {
  it('a drained, idle machine with a queued backlog is told once, after the time set', () => {
    const w = watch();
    const minutes = DRAINED_IDLE_AFTER_MS / 60_000;
    w.see([machine('l3')], 0);
    w.see([machine('l3')], minutes - 1);
    expect(w.told).toEqual([]);
    w.see([machine('l3')], minutes);
    w.see([machine('l3')], minutes + 1);
    expect(w.told).toEqual([{
      type: 'machine.drained_idle', machineId: 'l3',
      data: { machineId: 'l3', label: 'seat l3', since: at(0), drainedAt: at(-60), until: at(24 * 60), reason: 'rebuild', freeLanes: 2, queued: 2 },
    }]);
  });

  it('a stretch ends when the backlog clears, the machine is undrained, offline or full; a new stretch is told again', () => {
    const backlog = { list: [queued('a')] };
    const told: DrainWatchEvent[] = [];
    const w = createDrainWatch({ drains: () => ({ l3: drain() }), queued: () => backlog.list, lanes: () => [], expire: () => {}, tell: (e) => told.push(e) });
    w.observe([machine('l3')], at(0));
    w.observe([machine('l3')], at(10));
    expect(told).toHaveLength(1);
    backlog.list = [];
    w.observe([machine('l3')], at(11));
    backlog.list = [queued('c')];
    w.observe([machine('l3')], at(12));
    w.observe([machine('l3')], at(21));
    expect(told).toHaveLength(1);
    w.observe([machine('l3')], at(22));
    expect(told).toHaveLength(2);
    expect(told[1]!.data.since).toBe(at(12));
  });

  it('is not told for a machine that is offline, full, not drained, or runs none of the queued jobs\' executors', () => {
    const busy = (n: number): Lane => ({ id: `l3:${n}`, machineId: 'l3', state: 'busy', jobId: `r${n}` }) as unknown as Lane;
    for (const [ms, o] of [
      [[machine('l3', { online: false })], {}],
      [[machine('l3')], { lanes: [busy(1), busy(2)] }],
      [[machine('l2')], {}],
      [[machine('l3', { executors: ['codex'] })], {}],
    ] as const) {
      const w = watch(o);
      w.see([...ms], 0);
      w.see([...ms], 30);
      expect(w.told).toEqual([]);
    }
  });

  it('reads the queued jobs only while some drained machine could take one', () => {
    const w = watch({ drains: {} });
    w.see([machine('l3')], 0);
    w.see([machine('l3')], 30);
    expect(w.reads()).toBe(0);
  });

  it('ends a drain past its expiry, and a drain kept with no expiry a day after it began', () => {
    const w = watch({ drains: { l3: drain({ until: at(5) }), l2: drain({ until: undefined, reason: undefined, at: at(-24 * 60) }), l1: drain() } });
    w.see([machine('l1'), machine('l2'), machine('l3')], 0);
    expect(w.expired).toEqual([['l2']]);
    w.see([machine('l1'), machine('l2'), machine('l3')], 5);
    expect(w.expired).toEqual([['l2'], ['l2', 'l3']]);
  });
});
