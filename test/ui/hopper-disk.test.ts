// The hopper's own disk use on a Machines card, and the disk budget an admin sets (issue #1120): the model, pure.
import { describe, expect, it } from 'vitest';
import { budgetBody, budgetDraft, cachesText, hopperDiskText, storageText } from '../../ui/src/model/hopper-disk.ts';

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
