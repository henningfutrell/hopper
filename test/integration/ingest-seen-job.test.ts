// Issue #2820: two hoppers on one database read an item's newest job, and each offers the item. The first makes the Run
// again's job; it fails at once and its end is reported before the second takes the item's lock. That job is re-runnable,
// but the second hopper did not read it: it makes no third job. The next pass reads it and judges the item again.
import { afterEach, describe, expect, it } from 'vitest';
import type { SourceItem } from '../../src/domain/source-item.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

const KEY = 'https://github.com/owner/repo/issues/9';
const SOURCE = { name: 'github', kind: 'github-account' };
let a: TestApp | undefined;
let cleanup: (() => void) | undefined;

afterEach(async () => {
  await a?.stop(); a = undefined;
  cleanup?.(); cleanup = undefined;
});

// An executor no lane runs: the job is made and failed in one transaction, as on a crash host.
const item: SourceItem = {
  key: KEY, url: KEY, title: 'Run again', body: 'x', prompt: 'x', env: {}, author: 'owner', priority: 50, priorityReason: 'default',
  labels: ['hopper'], repo: 'owner/repo', number: 9, executor: 'no-such-executor',
};

describe('an item offered with the newest job its offerer read (issue #2820)', () => {
  it('makes no job when the item has a newer job than the one read; makes one when the read job is the newest', async () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    a = await startTestApp({ dbPath: db.dbPath, env: {} });
    const host = a.user().engine.sourceHost;
    const reported = (id: string): void => host.setSourceState(id, { sync: { claimReported: true, finalReported: true } });
    const first = host.ingest(item, SOURCE, { jobId: undefined })!;
    expect(first.status).toBe('failed');
    reported(first.id);
    // The other hopper's job, made and reported after this one read the item with no job.
    expect(host.ingest(item, SOURCE, { jobId: undefined })).toBeNull();
    const second = host.ingest(item, SOURCE, { jobId: first.id })!;
    expect(second).toMatchObject({ rerunOf: first.id });
    reported(second.id);
    expect(host.ingest(item, SOURCE, { jobId: first.id })).toBeNull();
    expect(a.user().store.jobs.idsOfItem(KEY)).toEqual([second.id, first.id]);
  });
});
