// Yolo mode in the UI (issue #579), pure: one row per job repository and per repository set apart, each saying
// whether its jobs may merge and why; the summary; and the change a save sends — only what differs.
import { describe, expect, it } from 'vitest';
import { YOLO_WARNING, yoloPatch, yoloRows, yoloSummary } from '../../ui/src/model/yolo-mode.ts';

const view = (on: boolean, repos: Record<string, boolean> = {}, choices = ['owner/a', 'owner/b']) => ({ on, repos, choices: { repos: choices } });

describe('yolo mode model', () => {
  it('rows: every job repository, then any other repository set apart, each with its setting and whether its jobs merge', () => {
    expect(yoloRows(view(false, { 'owner/b': true, 'owner/gone': false }))).toEqual([
      { repo: 'owner/a', setting: 'default', merges: false },
      { repo: 'owner/b', setting: 'on', merges: true },
      { repo: 'owner/gone', setting: 'off', merges: false },
    ]);
    expect(yoloRows(view(true, { 'owner/a': false }, ['Owner/A', 'owner/b']))).toEqual([
      { repo: 'Owner/A', setting: 'off', merges: false },
      { repo: 'owner/b', setting: 'default', merges: true },
    ]);
  });

  it('summary: off, on, or on for some', () => {
    expect(yoloSummary(view(false))).toBe('Off: no job merges its own pull request.');
    expect(yoloSummary(view(true))).toBe('On: jobs merge their own pull requests once the checks pass, in every job repository.');
    expect(yoloSummary(view(false, { 'owner/b': true }))).toBe('On in 1 repository: jobs there merge their own pull requests once the checks pass.');
    expect(yoloSummary(view(true, { 'owner/a': false, 'owner/b': false }))).toBe('Off: no job merges its own pull request.');
  });

  it('patch: only what changed; a repository back to the default is null', () => {
    const v = view(false, { 'owner/b': true });
    expect(yoloPatch(v, { on: false, repos: { 'owner/b': 'on' } })).toBeUndefined();
    expect(yoloPatch(v, { on: true, repos: { 'owner/b': 'on' } })).toEqual({ on: true });
    expect(yoloPatch(v, { on: false, repos: { 'owner/a': 'off', 'owner/b': 'default' } })).toEqual({ repos: { 'owner/a': false, 'owner/b': null } });
  });

  it('the warning says what it allows', () => {
    expect(YOLO_WARNING).toContain('no person reviews');
    expect(YOLO_WARNING).toContain('branch protection');
  });
});
