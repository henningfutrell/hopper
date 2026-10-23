// Issue #2622 part 4: demand from history. The heavy-step gate reserves what a repository's recent jobs took at their
// peak (`job.resources_used`, each job's scope's `memory.peak` at its reap), read off the event loop.
import { describe, expect, it } from 'vitest';
import { useTempStore, spec } from './helpers.ts';

const t = useTempStore();
const GIB = 1024 ** 3;
const ref = (key: string, repo: string) => ({ source: 'github', kind: 'issue', key, repo });

describe('the memory peaks of a repository\'s jobs (issue #2622 part 4)', () => {
  it('answers the newest first, only its repository\'s, in any case, only peaks since the day named, at most the limit', async () => {
    const s = t.open(t.url());
    const used = (jobId: string, memoryPeakBytes?: number, at?: string) =>
      s.events.append({ type: 'job.resources_used', jobId, ...(at ? { at } : {}), data: { cpuSeconds: 1, ...(memoryPeakBytes !== undefined ? { memoryPeakBytes } : {}) } });
    const a = s.jobs.create(spec, 50, ref('k1', 'o/app'));
    const b = s.jobs.create(spec, 50, ref('k2', 'O/App'));
    const c = s.jobs.create(spec, 50, ref('k3', 'o/other'));
    const d = s.jobs.create(spec, 50, ref('k4', 'o/app'));
    const e = s.jobs.create(spec, 50, ref('k5', 'o/app'));
    used(a.id, 1 * GIB, '2026-08-01T00:00:00.000Z');
    used(a.id, 2 * GIB);
    used(b.id, 3 * GIB);
    used(c.id, 9 * GIB);
    used(d.id);
    used(e.id, 4 * GIB);
    expect(await s.reads.memoryPeaks('o/app', '2026-09-01T00:00:00.000Z', 10)).toEqual([4 * GIB, 3 * GIB, 2 * GIB]);
    expect(await s.reads.memoryPeaks('o/app', '2026-09-01T00:00:00.000Z', 2)).toEqual([4 * GIB, 3 * GIB]);
    expect(await s.reads.memoryPeaks('o/none', '2026-09-01T00:00:00.000Z', 10)).toEqual([]);
    s.close();
  });
});
