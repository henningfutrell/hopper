// Low disk holds new claims (issue #410): a machine whose disk is low takes no new job; a job resuming
// on it returns to its pane. The reason names the machine and its free space.
import { describe, expect, it } from 'vitest';
import { decide } from '../../src/decider/index.ts';
import { inputs, job, machine } from './support.ts';

const GIB = 1024 ** 3;
const low = { freeBytes: 3 * GIB, totalBytes: 100 * GIB, low: true };
const roomy = { freeBytes: 60 * GIB, totalBytes: 100 * GIB, low: false };

describe('a machine whose disk is low (issue #410)', () => {
  it('takes no new job: another machine does', () => {
    const d = decide(inputs({
      machines: [machine({ id: 'a', disk: low }), machine({ id: 'b', maxLanes: 1, disk: roomy })],
      waiting: [job('j')],
    }), 'd1');
    expect(d.start.map((s) => s.machineId)).toEqual(['b']);
  });

  it('holds a new job when every machine for its executor is low, naming them and their free space', () => {
    const d = decide(inputs({
      machines: [machine({ id: 'a', disk: low }), machine({ id: 'b', disk: { ...low, freeBytes: 1.5 * GIB } })],
      waiting: [job('j')],
    }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.hold).toEqual([{ jobId: 'j', reason: 'disk low on a (3 GiB free), b (1.5 GiB free): no new job is claimed there' }]);
  });

  it('holds a job pinned to a low machine', () => {
    const d = decide(inputs({
      machines: [machine({ id: 'a', disk: low }), machine({ id: 'b', disk: roomy })],
      waiting: [job('j', { machineId: 'a' })],
    }), 'd1');
    expect(d.start).toEqual([]);
    expect(d.hold).toEqual([{ jobId: 'j', reason: 'pinned machine a disk low (3 GiB free): no new job is claimed there' }]);
  });

  it('lets a job resuming on it return to its pane', () => {
    const d = decide(inputs({
      machines: [machine({ id: 'a', disk: low })],
      waiting: [job('r', { pendingAnswer: 'yes', resumeOn: 'a' })],
    }), 'd1');
    expect(d.start.map((s) => s.machineId)).toEqual(['a']);
    expect(d.hold).toEqual([]);
  });

  it('a machine with no reading, or one not low, takes jobs as before', () => {
    const d = decide(inputs({ machines: [machine({ id: 'a' }), machine({ id: 'b', disk: roomy })], waiting: [job('j1'), job('j2')] }), 'd1');
    expect(d.start).toHaveLength(2);
  });

  it('an offline roomy machine and a low online one: held for the disk, not as waiting for a lane', () => {
    const d = decide(inputs({
      machines: [machine({ id: 'a', disk: low }), machine({ id: 'b', online: false, disk: roomy })],
      waiting: [job('j')],
    }), 'd1');
    expect(d.wait).toEqual([]);
    expect(d.hold[0]!.reason).toMatch(/^disk low on a /);
  });
});
