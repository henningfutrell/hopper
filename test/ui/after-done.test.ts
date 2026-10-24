// A finished job's pull request in the UI (issue #579), pure: what the job's title says after done — partly done, its
// pull request ready for review, merged, closed without a merge, or abandoned (issue #428) — and the pull request it links to.
import { describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import type { YoloModeView } from '../../src/domain/types.ts';
import { afterDone, partsOf } from '../../ui/src/model/job.ts';

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

  it('its issue closed as not planned while its pull request waited (issue #428): abandoned, whole or a part', () => {
    const abandoned = { label: 'abandoned', tone: 'warn', url: PR, title: 'its issue was closed as not planned; its pull request is not merged' };
    expect(afterDone(followed({ pullRequest: PR, follow: 'abandoned' }))).toEqual(abandoned);
    expect(afterDone(followed({ pullRequest: PR, follow: 'abandoned', part: true }, { partlyDone: PR }))).toEqual(abandoned);
  });
});

describe('a pull request in a repository the hopper does not merge in (issue #2752)', () => {
  const OTHER = 'https://github.com/zed/tool/pull/24';
  const yolo = (o: Partial<YoloModeView> = {}): YoloModeView => ({ on: true, repos: {}, choices: { repos: ['owner/repo'] }, ...o });
  const issue = { source: 'github', kind: 'github', key: 'k', repo: 'owner/repo', number: 3 };
  const open = (pullRequest: string) => followed({ pullRequest, follow: 'open' }, { source: issue });
  const needs = { label: 'needs merge in zed/tool', tone: 'warn', url: OTHER, title: 'the hopper does not merge pull requests in zed/tool: a person merges it there, or names zed/tool on in Settings → Yolo mode' };

  it('needs merge in that repository, not PR ready, when no person named it on', () => {
    expect(afterDone(open(OTHER), yolo())).toEqual(needs);
    expect(afterDone(open(OTHER), yolo({ repos: { 'zed/tool': false } }))).toEqual(needs);
  });

  it('PR ready when a person named it on, or the pull request is in a job repository, or yolo mode is not known', () => {
    expect(afterDone(open(OTHER), yolo({ repos: { 'zed/tool': true } }))).toMatchObject({ label: 'PR ready' });
    expect(afterDone(open(PR), yolo({ on: false }))).toMatchObject({ label: 'PR ready' });
    expect(afterDone(open(OTHER))).toMatchObject({ label: 'PR ready' });
  });

  it('a part in that repository: needs merge too, so the next part waits on a person', () => {
    expect(afterDone(followed({ pullRequest: OTHER, follow: 'open', part: true }, { source: issue, partlyDone: OTHER }), yolo())).toEqual(needs);
  });
});

describe('parts (issue #729)', () => {
  const source = { source: 'github', kind: 'github', key: 'k' };
  it('the parts done of the issue: as followed after a merge, else as offered; none without declared parts', () => {
    expect(partsOf(job())).toBeUndefined();
    expect(partsOf(job({ status: 'queued', source: { ...source, parts: { done: 1, total: 3 } } }))).toEqual({ done: 1, total: 3, label: 'parts 1/3' });
    expect(partsOf(followed({ follow: 'merged', part: true, parts: { done: 2, total: 3 } }, { source: { ...source, parts: { done: 1, total: 3 } } })))
      .toEqual({ done: 2, total: 3, label: 'parts 2/3' });
  });
});
