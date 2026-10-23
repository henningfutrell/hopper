// The header's disk alert (issue #2494): on every screen, how many machines have a low disk, a link to Machines; critical
// when one of them takes no job at all.
import { describe, expect, it } from 'vitest';
import { diskAlert } from '../../ui/src/model/disk-alert.ts';

const GB = 1e9;
const m = (id: string, freeGB: number, o: { low?: boolean; critical?: boolean; online?: boolean } = {}) => ({
  id, label: `seat ${id}`, online: o.online ?? true,
  disk: { freeBytes: freeGB * GB, totalBytes: 100 * GB, low: o.low ?? false, ...(o.critical ? { critical: true as const } : {}) },
});

describe('the header\'s disk alert (issue #2494)', () => {
  it('is none while no online machine has a low disk', () => {
    expect(diskAlert([m('l1', 50), m('l2', 3, { low: true, online: false }), { id: 'c', label: 'c', online: true }])).toBeNull();
  });

  it('counts the machines with a low disk, naming each with its free space', () => {
    expect(diskAlert([m('l1', 3, { low: true }), m('l2', 50), m('l4', 4, { low: true })])).toEqual({
      n: 2, critical: false, words: 'disks low', title: 'Disk low: seat l1 (3.0 GB free), seat l4 (4.0 GB free). A machine with a low disk takes no new job.',
    });
  });

  it('is critical when one is, which takes no job at all', () => {
    expect(diskAlert([m('l1', 0.5, { low: true, critical: true })])).toEqual({
      n: 1, critical: true, words: 'disk critical', title: 'Disk low: seat l1 (0.5 GB free, critical). A machine with a low disk takes no new job; a critical one takes no job at all.',
    });
  });
});
