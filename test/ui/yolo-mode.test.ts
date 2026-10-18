// Yolo mode in the UI (issue #579), pure: one row per job repository and per repository set apart, each saying
// whether its jobs may merge and why; the summary; and the change a save sends — only what differs.
import { describe, expect, it } from 'vitest';
import { DIRECT_PUSH_WARNING, OUTSIDE_YOLO_WARNING, YOLO_WARNING, addYoloRepo, changeKindsText, directPushPatch, directPushText, gateText, parseChangeKinds, repoMerges, yoloPatch, yoloRows, yoloSummary } from '../../ui/src/model/yolo-mode.ts';

const view = (on: boolean, repos: Record<string, boolean> = {}, choices = ['owner/a', 'owner/b']) => ({ on, repos, choices: { repos: choices } });

describe('yolo mode model', () => {
  it('rows: every job repository, then any other repository set apart, each with its setting and whether its jobs merge', () => {
    expect(yoloRows(view(false, { 'owner/b': true, 'owner/gone': false }))).toEqual([
      { repo: 'owner/a', setting: 'default', merges: false },
      { repo: 'owner/b', setting: 'on', merges: true },
      { repo: 'owner/gone', setting: 'off', merges: false, outside: true },
    ]);
    expect(yoloRows(view(true, { 'owner/a': false }, ['Owner/A', 'owner/b']))).toEqual([
      { repo: 'Owner/A', setting: 'off', merges: false },
      { repo: 'owner/b', setting: 'default', merges: true },
    ]);
  });

  it('summary: off, on, or on for some', () => {
    expect(yoloSummary(view(false))).toBe('Off: no job merges its own pull request.');
    expect(yoloSummary(view(true))).toBe('On: jobs and the hopper merge ready pull requests once the checks pass, in every job repository.');
    expect(yoloSummary(view(false, { 'owner/b': true }))).toBe('On in 1 repository: jobs and the hopper merge ready pull requests there once the checks pass.');
    expect(yoloSummary(view(true, { 'owner/a': false, 'owner/b': false }))).toBe('Off: no job merges its own pull request.');
  });

  it('patch: only what changed; a repository back to the default is null', () => {
    const v = view(false, { 'owner/b': true });
    expect(yoloPatch(v, { on: false, repos: { 'owner/b': 'on' } })).toBeUndefined();
    expect(yoloPatch(v, { on: true, repos: { 'owner/b': 'on' } })).toEqual({ on: true });
    expect(yoloPatch(v, { on: false, repos: { 'owner/a': 'off', 'owner/b': 'default' } })).toEqual({ repos: { 'owner/a': false, 'owner/b': null } });
  });

  it('repoMerges: the own setting of a repository wins, else the default; case does not matter (issue #737)', () => {
    const v = view(false, { 'owner/b': true });
    expect(repoMerges(v, 'Owner/B')).toBe(true);
    expect(repoMerges(v, 'owner/a')).toBe(false);
    expect(repoMerges(view(true, { 'owner/a': false }), 'owner/a')).toBe(false);
    expect(repoMerges(view(true), 'owner/c')).toBe(false);
  });

  it('a repository the hopper does not work on (issue #1806): merges only when named on, never by the default', () => {
    expect(yoloRows(view(true, { 'zed/tool': true, 'zed/web': false }))).toEqual([
      { repo: 'owner/a', setting: 'default', merges: true },
      { repo: 'owner/b', setting: 'default', merges: true },
      { repo: 'zed/tool', setting: 'on', merges: true, outside: true },
      { repo: 'zed/web', setting: 'off', merges: false, outside: true },
    ]);
    expect(repoMerges(view(true, { 'zed/tool': true }), 'Zed/Tool')).toBe(true);
    expect(OUTSIDE_YOLO_WARNING).toContain('not one of your job repositories');
  });

  it('adds a repository by name, on, to the draft: owner/repo only, lowercased, once', () => {
    const d = { on: false, repos: { 'owner/a': 'default' as const } };
    expect(addYoloRepo(d, ' Zed/Tool ')).toEqual({ ok: true, draft: { on: false, repos: { 'owner/a': 'default', 'zed/tool': 'on' } } });
    expect(addYoloRepo(d, 'Owner/A')).toEqual({ ok: false, error: 'owner/a is listed already' });
    expect(addYoloRepo(d, 'tool')).toEqual({ ok: false, error: 'name a repository as owner/repo' });
  });

  it('the warning says what it allows', () => {
    expect(YOLO_WARNING).toContain('no person reviews');
    expect(YOLO_WARNING).toContain('branch protection');
  });
});

describe('change kinds in the yolo mode panel (issue #1076)', () => {
  it('the rules as text: the admin\'s own, or none for the built-in rule', () => {
    expect(changeKindsText({ ...view(false), changeKinds: { default: { lowRisk: ['ui/**'] } } })).toBe(JSON.stringify({ default: { lowRisk: ['ui/**'] } }, null, 2));
    expect(changeKindsText(view(false))).toBe('');
  });

  it('a save: the rules parsed; empty text is the built-in rule again; text that is no object is refused', () => {
    expect(parseChangeKinds('{"repos":{"o/r":{"merge":{"sensitive":"person"}}}}')).toEqual({ ok: true, value: { repos: { 'o/r': { merge: { sensitive: 'person' } } } } });
    expect(parseChangeKinds('  ')).toEqual({ ok: true, value: null });
    expect(parseChangeKinds('[1]')).toMatchObject({ ok: false });
    expect(parseChangeKinds('{')).toMatchObject({ ok: false });
  });

  it('says what each kind\'s gate does', () => {
    expect(gateText('ready')).toBe('merged when ready, no person asked');
    expect(gateText('yolo')).toBe('merged when ready only with yolo mode on');
    expect(gateText('person')).toBe('only a person merges');
  });

  it('direct push (issue #1806): the list as text, one repository a line, and the change a save sends', () => {
    expect(directPushText({ ...view(false), push: ['acme/api', 'zed/tool'] })).toBe('acme/api\nzed/tool');
    expect(directPushText(view(false))).toBe('');
    expect(directPushPatch(view(false), ' Acme/API \n\nzed/tool\n')).toEqual({ ok: true, value: { push: ['acme/api', 'zed/tool'] } });
    expect(directPushPatch({ ...view(false), push: ['acme/api'] }, 'acme/api')).toEqual({ ok: true, value: undefined });
    expect(directPushPatch({ ...view(false), push: ['acme/api'] }, '')).toEqual({ ok: true, value: { push: [] } });
    expect(directPushPatch(view(false), 'not a repo')).toEqual({ ok: false, error: 'not owner/repo: not a repo' });
    expect(DIRECT_PUSH_WARNING).toContain('no person reviews');
  });
});

