// The failure profile (issue #509), pure: counts and a daily trend per signature, and breakdowns by machine,
// repo and executor, over the assessed failures of the last days. A signature on enough jobs is flagged general.
import { describe, expect, it } from 'vitest';
import type { FailureRecord } from '../../src/domain/types.ts';
import { profileOf } from '../../src/failures/profile.ts';

const NOW = '2026-10-08T12:00:00.000Z';
let n = 0;
function record(over: Partial<FailureRecord> & { machineId?: string; repo?: string; executor?: string } = {}): FailureRecord {
  const { machineId, repo, executor, ...rest } = over;
  n += 1;
  return {
    id: `f${n}`, jobId: `j${n}`, at: '2026-10-08T10:00:00.000Z', signature: 'aaa', normalised: 'disk full', cls: 'shared', decision: 'hold',
    reasons: [], summary: '', auto: true,
    evidence: { error: 'disk full', executor: executor ?? 'herdr-claude', attempt: 1, sameSignature: 0, ...(machineId ? { machineId } : {}), ...(repo ? { repo } : {}) },
    ...rest,
  };
}

describe('profileOf', () => {
  const records = [
    record({ machineId: 'desk', repo: 'o/a', causeName: 'Disk full' }),
    record({ machineId: 'desk', repo: 'o/b', at: '2026-10-07T09:00:00.000Z' }),
    record({ machineId: 'box', repo: 'o/a', jobId: 'j1' }),
    record({ signature: 'bbb', normalised: 'tests fail', cls: 'job', decision: 'person', machineId: 'desk', repo: 'o/a', executor: 'codex', at: '2026-10-06T23:59:00.000Z' }),
    record({ signature: 'old', at: '2026-09-01T00:00:00.000Z' }),
  ];
  const p = profileOf(records, NOW, { days: 3, generalThreshold: 3 });

  it('counts each signature over the window, newest-hit first among equals, with its jobs and machines', () => {
    expect(p.signatures.map((s) => [s.signature, s.count, s.jobs, s.machines])).toEqual([['aaa', 3, 2, 2], ['bbb', 1, 1, 1]]);
    expect(p.signatures[0]).toMatchObject({ name: 'Disk full', cls: 'shared', lastAt: '2026-10-08T10:00:00.000Z', general: false });
  });

  it('a daily trend per signature and overall, oldest day first', () => {
    expect(p.days).toEqual([{ day: '2026-10-06', count: 1 }, { day: '2026-10-07', count: 1 }, { day: '2026-10-08', count: 2 }]);
    expect(p.signatures[0]!.trend).toEqual([0, 1, 2]);
  });

  it('breakdowns by machine, repo and executor, most first', () => {
    expect(p.byMachine).toEqual([{ key: 'desk', count: 3 }, { key: 'box', count: 1 }]);
    expect(p.byRepo).toEqual([{ key: 'o/a', count: 3 }, { key: 'o/b', count: 1 }]);
    expect(p.byExecutor).toEqual([{ key: 'herdr-claude', count: 3 }, { key: 'codex', count: 1 }]);
  });

  it('flags a signature on at least the threshold of jobs as general', () => {
    const many = [record({ signature: 'ccc' }), record({ signature: 'ccc' }), record({ signature: 'ccc' })];
    expect(profileOf(many, NOW, { days: 3, generalThreshold: 3 }).signatures[0]).toMatchObject({ signature: 'ccc', general: true });
  });

  it('nothing failed: an empty profile with every day at zero', () => {
    expect(profileOf([], NOW, { days: 2, generalThreshold: 3 })).toEqual({
      days: [{ day: '2026-10-07', count: 0 }, { day: '2026-10-08', count: 0 }], signatures: [], byMachine: [], byRepo: [], byExecutor: [],
    });
  });
});
