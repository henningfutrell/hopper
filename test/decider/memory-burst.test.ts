// Issue #2737: a burst of heavy jobs across machines, a WSL VM among them, run Decision after Decision against a model of
// each machine's memory. Each job takes its expected peak a few minutes after it starts, as a build does. The memory floor
// starts only what each machine holds, so no machine falls below its floor and none runs out of memory. When a job then
// takes more than its peak, the machine's memory pause parks the job of the lowest priority there, and that job resumes
// once the memory holds it again.
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import type { Decision, ExpectedCost, Job, Lane, MachineSnapshot } from '../../src/domain/types.ts';
import { NOW, busy, inputs, job, machine } from './support.ts';

const GIB = 1024 ** 3;
const MINUTE = 60_000;
const at = (minute: number): string => new Date(Date.parse(NOW) + minute * MINUTE).toISOString();

/** A job's memory: an agent's half GiB at its start, its expected peak from its third minute, and `extra` on top of it. */
const TAKES_PEAK_AFTER = 3;
const AGENT = 0.5 * GIB;

interface Model {
  totalBytes: number;
  /** What the machine holds with no job: its OS, the hopper. */
  baseBytes: number;
  /** WSL: what Windows itself holds of the host's memory, so its free memory is the VM's available less this. */
  windowsBytes?: number;
}

interface Run { job: Job; machineId: string; laneId: string; startedAt: number; peakBytes: number; extraBytes: number; endsAt: number }

const usedOf = (r: Run, minute: number): number => (minute - r.startedAt >= TAKES_PEAK_AFTER ? r.peakBytes + r.extraBytes : AGENT);

class Burst {
  minute = 0;
  waiting: Job[] = [];
  runs: Run[] = [];
  finished: string[] = [];
  paused: { jobId: string; minute: number; priority: number }[] = [];
  memoryPausedAt: Record<string, string> = {};
  lowest: Record<string, number> = {};

  constructor(readonly machines: Record<string, Model & { lanes: number }>, readonly costs: Record<string, ExpectedCost>, readonly runMinutes: number) {}

  available(id: string): number {
    const m = this.machines[id]!;
    return m.totalBytes - m.baseBytes - this.runs.filter((r) => r.machineId === id).reduce((n, r) => n + usedOf(r, this.minute), 0);
  }

  snapshot(id: string): MachineSnapshot {
    const m = this.machines[id]!;
    const available = this.available(id);
    return machine({
      id, label: id, maxLanes: m.lanes,
      resources: {
        cores: 8, memTotalBytes: m.totalBytes, memAvailableBytes: available,
        ...(m.windowsBytes !== undefined ? { wsl: true as const, hostMemFreeBytes: available - m.windowsBytes, hostMemTotalBytes: m.totalBytes + m.windowsBytes } : {}),
      },
    });
  }

  lanes(): Lane[] {
    return this.runs.map((r) => busy(Number(r.laneId.split('lane-')[1]), r.job.id, { machineId: r.machineId }));
  }

  /** One Decision at this minute, its starts and pauses applied, then the memory read again and checked. */
  step(): Decision {
    const d = decide(inputs({
      at: at(this.minute), machines: Object.keys(this.machines).map((id) => this.snapshot(id)), lanes: this.lanes(),
      waiting: this.waiting, running: this.runs.map((r) => r.job), expectedCosts: this.costs, parkingExecutors: ['test'], memoryPausedAt: this.memoryPausedAt,
    }), `d${this.minute}`);
    for (const p of d.memoryPause ?? []) {
      const r = this.runs.find((x) => x.job.id === p.jobId)!;
      this.runs = this.runs.filter((x) => x !== r);
      this.paused.push({ jobId: p.jobId, minute: this.minute, priority: r.job.priority });
      this.memoryPausedAt[p.machineId] = at(this.minute);
      // Its leak ends with its run: it resumes from its checkpoint with its expected peak.
      this.waiting.push(job(r.job.id, { priority: r.job.priority, resumeOn: p.machineId, memoryPaused: { at: at(this.minute), machineId: p.machineId, availableBytes: p.availableBytes, floorBytes: p.floorBytes } }));
    }
    for (const s of d.start) {
      const j = this.waiting.find((w) => w.id === s.jobId)!;
      this.waiting = this.waiting.filter((w) => w !== j);
      const used = new Set(this.runs.filter((r) => r.machineId === s.machineId).map((r) => r.laneId));
      const laneId = s.laneId ?? s.opens ?? Array.from({ length: 99 }, (_, n) => `${s.machineId}/lane-${n + 1}`).find((l) => !used.has(l))!;
      this.runs.push({
        job: { ...j, status: 'running', laneId, startedAt: at(this.minute), agentSession: `session-${j.id}`, memoryPaused: undefined },
        machineId: s.machineId, laneId, startedAt: this.minute, peakBytes: this.costs[j.id]!.memoryBytes!.peak, extraBytes: 0, endsAt: this.minute + this.runMinutes,
      });
    }
    this.minute += 1;
    for (const r of this.runs.filter((x) => x.endsAt <= this.minute)) this.finished.push(r.job.id);
    this.runs = this.runs.filter((x) => x.endsAt > this.minute);
    for (const id of Object.keys(this.machines)) this.lowest[id] = Math.min(this.lowest[id] ?? Infinity, this.available(id));
    return d;
  }
}

const peak = (gib: number): ExpectedCost => ({ group: 'repo', key: 'heavy', jobs: 8, memoryBytes: { avg: gib * GIB * 0.8, peak: gib * GIB } });

describe('a burst of heavy jobs across machines (issue #2737)', () => {
  // A WSL VM of 14 GiB whose Windows holds 1 GiB more than the VM's own reading says, and a box of 16 GiB: 6 lanes each.
  const machines = { wsl: { totalBytes: 14 * GIB, baseBytes: 2 * GIB, windowsBytes: 1 * GIB, lanes: 6 }, box: { totalBytes: 16 * GIB, baseBytes: 2 * GIB, lanes: 6 } };
  const FLOOR = { wsl: 1.4 * GIB, box: 1.6 * GIB };

  it('16 jobs that each peak at 3 GiB never take a machine below its floor, WSL included, and every job runs', () => {
    const ids = Array.from({ length: 16 }, (_, n) => `j${n + 1}`);
    const burst = new Burst(machines, Object.fromEntries(ids.map((id) => [id, peak(3)])), 12);
    burst.waiting = ids.map((id, n) => job(id, { priority: n % 2 ? 60 : 20 }));
    for (let n = 0; n < 120 && burst.finished.length < ids.length; n++) {
      burst.step();
      for (const id of Object.keys(machines)) {
        expect(burst.available(id), `${id} at minute ${burst.minute}`).toBeGreaterThanOrEqual(FLOOR[id as keyof typeof FLOOR]);
        if (id === 'wsl') expect(burst.available(id) - machines.wsl.windowsBytes).toBeGreaterThan(0);
      }
    }
    expect(burst.finished.sort()).toEqual([...ids].sort());
    expect(burst.paused).toEqual([]);
    // Both machines took jobs: the burst went where the memory was, not all to one machine.
    expect(burst.lowest.wsl).toBeLessThan(8 * GIB);
    expect(burst.lowest.box).toBeLessThan(8 * GIB);
  });

  it('a job that takes more than its peak makes its machine pause the job of the lowest priority there first, which resumes when the memory holds it', () => {
    const box = { box: { totalBytes: 16 * GIB, baseBytes: 2 * GIB, lanes: 6 } };
    const burst = new Burst(box, { hi: peak(3), lo: peak(3), mid: peak(3) }, 30);
    burst.waiting = [job('hi', { priority: 75 }), job('lo', { priority: 10 }), job('mid', { priority: 50 })];
    for (let n = 0; n < 5; n++) burst.step();
    expect(burst.runs.map((r) => r.job.id).sort()).toEqual(['hi', 'lo', 'mid']);
    // The job of the highest priority, started first, leaks 4 GiB more than its peak: the box falls below its floor.
    burst.runs.find((r) => r.job.id === 'hi')!.extraBytes = 4 * GIB;
    const d = burst.step();
    expect(d.memoryPause?.map((p) => [p.jobId, p.priority])).toEqual([['lo', 10]]);
    expect(d.memoryPause?.[0]?.reason).toMatch(/^pauses lo on box\/lane-\d: box has [\d.]+ GiB available, below its floor of 1\.6 GiB; lo has the lowest priority there \(10\)$/);
    expect(burst.runs.map((r) => r.job.id).sort()).toEqual(['hi', 'mid']);
    // While the leak lasts, it does not start again.
    for (let n = 0; n < 5; n++) {
      const w = burst.step();
      expect(w.start.map((s) => s.jobId)).not.toContain('lo');
    }
    expect(burst.available('box')).toBeGreaterThanOrEqual(1.6 * GIB);
    // The leak ends: the paused job resumes on its machine.
    burst.runs.find((r) => r.job.id === 'hi')!.extraBytes = 0;
    let resumed: string | undefined;
    for (let n = 0; n < 5 && !resumed; n++) resumed = burst.step().start.find((s) => s.jobId === 'lo')?.machineId;
    expect(resumed).toBe('box');
    expect(burst.paused.map((p) => p.jobId)).toEqual(['lo']);
  });
});
