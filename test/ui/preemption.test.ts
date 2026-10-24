// Preemption in the UI (ui/src/model/preemption.ts, issue #1525), pure: the summary of the setting, the change a save
// sends — only what differs, refused when the minimum run time is not a number of minutes —, and the line a queued or
// parked job shows: which job took its lane, and that it resumes from where it stopped.
import { describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { memoryPausedLine, preemptedLine, preemptionPatch, preemptionSummary } from '../../ui/src/model/preemption.ts';

const preempted = { at: '2026-10-16T12:00:00Z', by: 'h', byPriority: 75, priority: 50, machineId: 'laptop' };

describe('preemption model', () => {
  it('the summary says what is on', () => {
    expect(preemptionSummary({ enabled: true, minRunMinutes: 10 })).toBe('On: a job of higher priority takes the lane of a job of lower priority that has run for 10 min.');
    expect(preemptionSummary({ enabled: true, minRunMinutes: 0 })).toBe('On: a job of higher priority takes the lane of a job of lower priority at once.');
    expect(preemptionSummary({ enabled: false, minRunMinutes: 10 })).toBe('Off: no job takes the lane of a running job.');
  });

  it('a save sends only what differs; a minimum run time that is not a number of minutes is refused', () => {
    const s = { enabled: true, minRunMinutes: 10 };
    expect(preemptionPatch(s, { enabled: true, minRunMinutes: '10' })).toEqual({ ok: true, patch: undefined });
    expect(preemptionPatch(s, { enabled: false, minRunMinutes: '10' })).toEqual({ ok: true, patch: { enabled: false } });
    expect(preemptionPatch(s, { enabled: true, minRunMinutes: ' 20 ' })).toEqual({ ok: true, patch: { minRunMinutes: 20 } });
    expect(preemptionPatch(s, { enabled: true, minRunMinutes: '' })).toEqual({ ok: false, error: 'Minimum run time: a number from 0 to 1440' });
    expect(preemptionPatch(s, { enabled: true, minRunMinutes: '-1' }).ok).toBe(false);
  });

  it('a queued or parked job preempted says which job took its lane; a running one says nothing', () => {
    const by = { id: 'h', spec: { goal: '' }, source: { number: 12, title: 'Fix the roof' } } as unknown as Job;
    expect(preemptedLine({ status: 'queued', preempted } as Job, by)).toBe('Preempted by #12 Fix the roof (priority 75; this job 50). It resumes from where it stopped when a lane is free.');
    expect(preemptedLine({ status: 'parked', preempted } as Job, undefined)).toBe('Preempted by job h (priority 75; this job 50). It resumes from where it stopped when a lane is free.');
    expect(preemptedLine({ status: 'running', preempted } as Job, by)).toBeUndefined();
    expect(preemptedLine({ status: 'queued' } as Job, by)).toBeUndefined();
  });

  it('a queued or parked job paused for memory says why, and that it resumes (issue #2737)', () => {
    const memoryPaused = { at: '2026-10-24T12:00:00Z', machineId: 'laptop', availableBytes: 1024 ** 3, floorBytes: 1.4 * 1024 ** 3, priority: 10, why: 'laptop has 1 GiB available, below its floor of 1.4 GiB' };
    expect(memoryPausedLine({ status: 'queued', memoryPaused } as Job)).toBe('Paused for memory: laptop has 1 GiB available, below its floor of 1.4 GiB. This job had the lowest priority there (10). It resumes from where it stopped when the memory holds it.');
    // A pause from a build before #2737 kept only the bytes.
    expect(memoryPausedLine({ status: 'parked', memoryPaused: { at: memoryPaused.at, machineId: 'laptop', availableBytes: 1024 ** 3, floorBytes: 1.4 * 1024 ** 3 } } as Job))
      .toBe('Paused for memory: laptop had 1 GiB available, its floor 1.4 GiB. It resumes from where it stopped when the memory holds it.');
    expect(memoryPausedLine({ status: 'running', memoryPaused } as Job)).toBeUndefined();
    expect(memoryPausedLine({ status: 'queued' } as Job)).toBeUndefined();
  });
});
