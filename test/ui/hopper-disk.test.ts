// The hopper's own disk use on a Machines card, and the disk budget an admin sets (issue #1120): the model, pure.
import { describe, expect, it } from 'vitest';
import { budgetBody, budgetDraft, cachesText, cleanupLeftoversText, hopperDiskText, jobsDiskText, storageText } from '../../ui/src/model/hopper-disk.ts';
import { diskDefaultsBody, diskDefaultsDraft } from '../../ui/src/model/disk-defaults.ts';

const GB = 1e9;
const at = '2026-10-14T10:00:00.000Z';

describe('hopperDiskText', () => {
  it('says the use, and the budget when there is one', () => {
    expect(hopperDiskText({ bytes: 12.4 * GB, at, paths: [], over: false })).toBe('12 GB, no budget');
    expect(hopperDiskText({ bytes: 12.4 * GB, at, paths: [], budgetBytes: 50 * GB, over: false })).toBe('12 GB of its 50 GB budget');
    expect(hopperDiskText({ bytes: 62 * GB, at, paths: [], budgetBytes: 50 * GB, over: true })).toBe('62 GB: over its 50 GB budget');
  });

  it('says a use under a gigabyte in megabytes', () => {
    expect(hopperDiskText({ bytes: 340e6, at, paths: [], over: false })).toBe('340 MB, no budget');
  });
});

describe('the disk budget form', () => {
  it('sends the budget in bytes from gigabytes; empty turns it off', () => {
    expect(budgetBody('50')).toEqual({ budget: { bytes: 50 * GB } });
    expect(budgetBody(' 2.5 ')).toEqual({ budget: { bytes: 2.5 * GB } });
    expect(budgetBody('')).toEqual({ budget: null });
  });

  it('refuses a budget that is not a number above 0', () => {
    expect(budgetBody('0')).toBe('The budget must be a number of GB above 0, or empty for none');
    expect(budgetBody('lots')).toBe('The budget must be a number of GB above 0, or empty for none');
  });

  it('starts from the budget set, in gigabytes', () => {
    expect(budgetDraft({ bytes: 50 * GB })).toBe('50');
    expect(budgetDraft(null)).toBe('');
  });
});

describe('the caches and container storage on a card (issue #2494)', () => {
  it('names each cache kind with its size, biggest first; none when there is none', () => {
    expect(cachesText([{ kind: 'gradle', bytes: 12.4 * GB, paths: [] }, { kind: 'cache', bytes: 340e6, paths: [] }])).toBe('Gradle 12 GB · other ~/.cache 340 MB');
    expect(cachesText([])).toBeUndefined();
  });

  it('names each runtime\'s storage with what it could reclaim', () => {
    expect(storageText([
      { runtime: 'podman', kind: 'images', bytes: 20 * GB, reclaimableBytes: 8 * GB },
      { runtime: 'podman', kind: 'volumes', bytes: 3 * GB, reclaimableBytes: 0 },
      { runtime: 'podman', kind: 'containers', bytes: 0, reclaimableBytes: 0 },
    ])).toBe('podman: images 20 GB (8.0 GB reclaimable), volumes 3.0 GB');
    expect(storageText([])).toBeUndefined();
  });
});

describe('cleanupLeftoversText (issue #2504 part 3)', () => {
  it('says how many things ended jobs left, of how many jobs, and how many removals failed', () => {
    expect(cleanupLeftoversText({ jobs: 1, entries: 1, failed: 0 })).toBe('1 thing of 1 ended job, not removed yet');
    expect(cleanupLeftoversText({ jobs: 2, entries: 3, failed: 2 })).toBe('3 things of 2 ended jobs, 2 removals failed: see Failures');
  });

  it('says what the leftovers hold on disk, and how many jobs the measure did not name (part 10)', () => {
    expect(cleanupLeftoversText({ jobs: 2, entries: 3, failed: 0, bytes: 4.2 * GB })).toBe('3 things of 2 ended jobs, not removed yet; 4.2 GB on disk');
    expect(cleanupLeftoversText({ jobs: 3, entries: 3, failed: 0, bytes: 300e6, unmeasured: 1 })).toBe('3 things of 3 ended jobs, not removed yet; 300 MB on disk, 1 job not measured');
    expect(cleanupLeftoversText({ jobs: 2, entries: 2, failed: 0, unmeasured: 2 })).toBe('2 things of 2 ended jobs, not removed yet; 2 jobs not measured');
  });
});

describe('jobsDiskText (issue #2494)', () => {
  const job = (jobId: string, bytes: number) => ({ jobId, bytes, worktreeBytes: bytes, scratchBytes: 0 });

  it('names the jobs that take the most, biggest first, and how many more there are', () => {
    expect(jobsDiskText([job('job-b', 1 * GB), job('job-a', 4.2 * GB), job('job-c', 500e6), job('job-d', 1e6), job('job-e', 2e6)]))
      .toBe('job-a 4.2 GB · job-b 1.0 GB · job-c 500 MB, and 2 more');
    expect(jobsDiskText([job('job-a', 4.2 * GB)])).toBe('job-a 4.2 GB');
  });

  it('says nothing when no job was measured', () => {
    expect(jobsDiskText(undefined)).toBeUndefined();
    expect(jobsDiskText([])).toBeUndefined();
  });
});

describe('the disk defaults form', () => {
  it('sends only the fields filled, in the API\'s shape; none filled clears them', () => {
    expect(diskDefaultsBody({})).toEqual({ defaults: null });
    expect(diskDefaultsBody({ diskLowBelowPercent: ' 15 ', retainFailedHours: '48', pruneAfterDays: '7', cacheCapNpmGiB: '5', trimAboveGiB: '' })).toEqual({
      defaults: { diskLow: { belowPercent: 15 }, sweep: { retainHours: { failed: 48 }, pruneAfterDays: 7, cacheCapsGiB: { npm: 5 } } },
    });
  });

  it('refuses a field that is not a number', () => {
    expect(diskDefaultsBody({ pruneAfterDays: 'weekly' })).toBe('Days before the storage prune must be a number, or empty for no default');
  });

  it('fills the form from the defaults set, each field empty that has none', () => {
    const d = { diskLow: { criticalBelowGiB: 2 }, sweep: { everyMinutes: 30, retainHours: { cancelled: 0 }, cacheCapsGiB: { go: 10 } } };
    expect(diskDefaultsDraft(d)).toEqual({ diskCriticalBelowGiB: '2', reapEveryMinutes: '30', retainCancelledHours: '0', cacheCapGoGiB: '10' });
    expect(diskDefaultsDraft(null)).toEqual({});
    expect(diskDefaultsBody(diskDefaultsDraft(d))).toEqual({ defaults: d });
  });
});
