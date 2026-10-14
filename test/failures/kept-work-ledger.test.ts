// Work not pushed reads the work-item ledger (issue #1067, part 2): a job's kept work is listed while nothing finished its
// item and no newer job works it; an item done — its pull request merged, its issue closed — lists none, however old.
import { describe, expect, it } from 'vitest';
import type { JobSourceRef } from '../../src/domain/types.ts';
import { keptWorkLeft } from '../../src/failures/kept-work.ts';
import { spec, useTempStore } from '../store/helpers.ts';

const t = useTempStore();
const KEY = 'https://github.com/o/r/issues/1';
const KEY2 = 'https://github.com/o/r/issues/2';
const PR = 'https://github.com/o/r/pull/3';
const ref = (key: string, number: number): JobSourceRef => ({ source: 'github', kind: 'github', key, repo: 'o/r', number });

describe('work not pushed, from the ledger', () => {
  it('lists the kept work of an item left failed, with its paths; none of an item whose pull request merged', () => {
    const store = t.open(t.url());
    const a = store.jobs.create(spec, 50, ref(KEY, 1));
    store.events.append({ type: 'job.queued', jobId: a.id, data: { spec, priority: 50 } });
    store.events.append({ type: 'job.failed', jobId: a.id, data: { error: 'boom' } });
    store.events.append({ type: 'job.work_kept', jobId: a.id, data: { paths: ['/w/a'] } });
    const b = store.jobs.create(spec, 50, ref(KEY2, 2));
    store.events.append({ type: 'job.queued', jobId: b.id, data: { spec, priority: 50 } });
    store.events.append({ type: 'job.finished', jobId: b.id, data: { result: 'pull request ready for review' } });
    store.events.append({ type: 'job.work_kept', jobId: b.id, data: { paths: ['/w/b'] } });
    store.events.append({ type: 'job.pull_request_merged', jobId: b.id, data: { pullRequest: PR, part: false } });

    expect(keptWorkLeft(store)).toEqual([expect.objectContaining({ jobId: a.id, paths: ['/w/a'] })]);

    // A newer job of the item works it: the older job's kept work is history.
    const c = store.jobs.create(spec, 50, ref(KEY, 1));
    store.events.append({ type: 'job.queued', jobId: c.id, data: { spec, priority: 50 } });
    expect(keptWorkLeft(store)).toEqual([]);
    store.close();
  });
});
