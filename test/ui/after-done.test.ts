// A finished job's pull request in the UI (issue #579), pure: what the job's title says after done — partly done, its
// pull request ready for review, merged, or closed without a merge — and the pull request it links to.
import { describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { afterDone } from '../../ui/src/model/job.ts';

const PR = 'https://github.com/owner/repo/pull/12';
const job = (o: Partial<Job> = {}): Job => ({
  id: 'j1', spec: { executor: 'test', payload: {} }, priority: 50, status: 'finished', approved: false, attempts: 1,
  createdAt: '2026-10-09T08:00:00.000Z', updatedAt: '2026-10-09T08:00:00.000Z', ...o,
} as Job);
const followed = (source: Record<string, unknown>, o: Partial<Job> = {}) => job({ sourceState: { source }, ...o });

describe('after done', () => {
  it('nothing for a job that is not finished, or has no pull request followed', () => {
    expect(afterDone(job({ status: 'running' }))).toBeUndefined();
    expect(afterDone(job())).toBeUndefined();
  });

  it('its pull request waits for review, is merged, or was closed without a merge', () => {
    expect(afterDone(followed({ pullRequest: PR, follow: 'open' }))).toEqual({ label: 'PR ready', tone: 'ok', url: PR, title: 'its pull request waits for review' });
    expect(afterDone(followed({ pullRequest: PR, follow: 'merged' }))).toEqual({ label: 'merged', tone: 'ok', url: PR, title: 'its pull request was merged' });
    expect(afterDone(followed({ pullRequest: PR, follow: 'closed' }))).toEqual({ label: 'PR closed', tone: 'warn', url: PR, title: 'its pull request was closed without a merge' });
  });

  it('a part: partly done until its pull request merges, then the next part runs', () => {
    expect(afterDone(job({ partlyDone: PR }))).toEqual({ label: 'partly done', tone: 'ok', url: PR, title: 'it shipped part of its issue; the rest runs once this pull request merges' });
    expect(afterDone(followed({ pullRequest: PR, follow: 'merged', part: true }, { partlyDone: PR }))).toEqual({ label: 'part merged', tone: 'ok', url: PR, title: 'its part was merged; the next part runs' });
  });
});
