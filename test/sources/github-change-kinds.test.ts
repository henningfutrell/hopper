// Change kinds (issue #1076): the follow classifies an open pull request by the files and lines it changes, and its kind's
// merge gate says whether the hopper merges it once ready. Docs only merge with only their checks, yolo mode off; a
// sensitive path keeps the full gates: yolo mode on and its checks passed.
//
// Feature: lighter gates for docs, stricter for sensitive changes
//   Scenario: a docs-only pull request, yolo mode off, its checks passed
//     Then the hopper merges it, and keeps its kind
//   Scenario: a sensitive pull request, yolo mode off
//     Then it waits for a person; with yolo mode on, it waits for its checks
//   Scenario: a code file whose changed lines are all comments
//     Then only that file's lines are read, and it merges as docs
//   Scenario: a person gate
//     Then yolo mode on does not merge it
import { describe, expect, it } from 'vitest';
import { DEFAULT_CHANGE_RULE, type ChangeRule, type ChecksState } from '../../src/domain/types.ts';
import { REPO, jobForIssue, setup } from './fixtures/github-support.ts';

const OPENED = '2026-10-02T09:50:00.000Z';

async function ended(pr: { files: string[]; diff?: Record<string, string[] | 'binary'>; checks?: ChecksState }, o: { yolo?: boolean; rule?: ChangeRule } = {}) {
  const s = setup({}, { yoloMode: () => o.yolo ?? false, ...(o.rule ? { changeRule: () => o.rule! } : {}) });
  s.gh.createIssue({ repo: REPO, labels: ['hopper'] });
  const opened = s.gh.openPullRequest(REPO, 1, { createdAt: OPENED, checks: pr.checks ?? 'passing', files: pr.files, ...(pr.diff ? { diff: pr.diff } : {}) });
  const base = jobForIssue(1, { status: 'finished', createdAt: '2026-10-02T09:00:00.000Z' });
  const state = await s.source.report({ kind: 'finished', job: base });
  return { ...s, pr: opened, job: { ...base, sourceState: { source: state } } };
}

const merged = (gh: { calls: { method: string }[] }) => gh.calls.filter((c) => c.method === 'merge').length;

describe('change kinds and the merge gate (issue #1076)', () => {
  it('a docs-only pull request merges with yolo mode off once its checks passed; its kind is kept', async () => {
    const { gh, source, job, pr } = await ended({ files: ['README.md', 'docs/design.md'] });
    const r = await source.follow!(job);
    expect(r).toMatchObject({ outcome: 'merged', pullRequest: pr.url, byHopper: true, state: { seen: { change: { kind: 'docs' } } } });
    expect(merged(gh)).toBe(1);
  });

  it('a docs-only pull request still waits for its checks', async () => {
    const { gh, source, job } = await ended({ files: ['README.md'], checks: 'pending' });
    expect(await source.follow!(job)).toMatchObject({ outcome: 'open', state: { seen: { change: { kind: 'docs' }, checks: 'pending' } } });
    expect(merged(gh)).toBe(0);
  });

  it('a sensitive path waits for a person with yolo mode off, and reads no lines', async () => {
    const { gh, source, job } = await ended({ files: ['README.md', 'src/auth/realm.ts'] });
    const r = await source.follow!(job);
    expect(r).toMatchObject({ outcome: 'open', state: { seen: { change: { kind: 'sensitive' } } } });
    expect((r?.state as { seen: { change: { why: string[] } } }).seen.change.why[0]).toContain('src/auth/realm.ts');
    expect(merged(gh)).toBe(0);
    expect(gh.calls.some((c) => c.method === 'changedLines')).toBe(false);
  });

  it('a sensitive path keeps the full gates with yolo mode on: its checks must pass', async () => {
    const pending = await ended({ files: ['.github/workflows/pr.yml'], checks: 'pending' }, { yolo: true });
    expect(await pending.source.follow!(pending.job)).toMatchObject({ outcome: 'open' });
    expect(merged(pending.gh)).toBe(0);
    const passed = await ended({ files: ['.github/workflows/pr.yml'] }, { yolo: true });
    expect(await passed.source.follow!(passed.job)).toMatchObject({ outcome: 'merged', byHopper: true });
  });

  it('a code file whose changed lines are all comments: only its lines are read, and it merges as docs', async () => {
    const { gh, source, job } = await ended({ files: ['README.md', 'src/c.ts'], diff: { 'src/c.ts': ['// say it plainly', ''] } });
    expect(await source.follow!(job)).toMatchObject({ outcome: 'merged', state: { seen: { change: { kind: 'docs' } } } });
    expect(gh.calls.filter((c) => c.method === 'changedLines').map((c) => c.args[2])).toEqual([['src/c.ts']]);
  });

  it('code whose lines git cannot say is code: yolo mode decides', async () => {
    const { gh, source, job } = await ended({ files: ['src/c.ts'] });
    expect(await source.follow!(job)).toMatchObject({ outcome: 'open', state: { seen: { change: { kind: 'code' } } } });
    expect(merged(gh)).toBe(0);
  });

  it('a person gate: yolo mode on does not merge it', async () => {
    const rule: ChangeRule = { ...DEFAULT_CHANGE_RULE, merge: { ...DEFAULT_CHANGE_RULE.merge, sensitive: 'person' } };
    const { gh, source, job } = await ended({ files: ['src/auth/realm.ts'] }, { yolo: true, rule });
    expect(await source.follow!(job)).toMatchObject({ outcome: 'open', state: { seen: { change: { kind: 'sensitive' } } } });
    expect(merged(gh)).toBe(0);
  });

  it('the same files under the same rule are not read again', async () => {
    const { gh, source, job } = await ended({ files: ['src/c.ts'], diff: { 'src/c.ts': ['const a = 1;'] } });
    const first = await source.follow!(job);
    expect(first).toMatchObject({ outcome: 'open', state: { seen: { change: { kind: 'code' } } } });
    await source.follow!({ ...job, sourceState: { source: first!.state } });
    expect(gh.calls.filter((c) => c.method === 'changedLines')).toHaveLength(1);
  });
});
