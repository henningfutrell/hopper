// Issue #1284: a machine that says it leaves is leaving from then on. A lane pod with no job left on it is retired —
// removed as a person removes a machine —; one with jobs on it waits for them; any other machine is never removed.
import { describe, expect, it } from 'vitest';
import type { PluginsEdit } from '../../src/domain/plugins.ts';
import type { AttachedMachine } from '../../src/domain/types.ts';
import { machineLeave } from '../../src/users/machine-leave.ts';

const KEY = 'k'.repeat(43);
const target = (pool: boolean): AttachedMachine => ({ name: 'hopper-lanes-0', lanes: 2, executors: ['test'], client: { key: KEY, ...(pool ? { pool: true as const } : {}) } } as AttachedMachine);

function setUp(o: { pool: boolean; jobs: string[] }) {
  const left: string[] = [];
  const edits: PluginsEdit[] = [];
  const leave = machineLeave({
    userId: 'admin', links: { leave: (user, key) => { left.push(`${user}/${key}`); } }, targets: () => [target(o.pool)],
    jobsOn: () => o.jobs, config: { version: () => 'v1' },
    edit: async (e) => { edits.push(e); return { ok: true, report: {} } as never; },
  });
  return { leave, left, edits };
}

describe('a machine leaving', () => {
  it('a lane pod with no job left is retired: removed from the plugins config', async () => {
    const s = setUp({ pool: true, jobs: [] });
    expect(await s.leave(KEY)).toEqual({ jobs: 0, retired: true });
    expect(s.left).toEqual([`admin/${KEY}`]);
    expect(s.edits).toEqual([{ action: 'remove', role: 'machine-source', name: 'hopper-lanes-0', version: 'v1' }]);
  });

  it('a lane pod with jobs on it is leaving, not retired: it says how many', async () => {
    const s = setUp({ pool: true, jobs: ['j1', 'j2'] });
    expect(await s.leave(KEY)).toEqual({ jobs: 2, retired: false });
    expect(s.left).toEqual([`admin/${KEY}`]);
    expect(s.edits).toEqual([]);
  });

  it('a machine that is no lane pod is never removed', async () => {
    const s = setUp({ pool: false, jobs: [] });
    expect(await s.leave(KEY)).toEqual({ jobs: 0, retired: false });
    expect(s.edits).toEqual([]);
  });
});
