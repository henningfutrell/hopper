// Yolo mode in the UI (issue #579), pure: the rows the panel lists, its summary, and the change a save sends. The
// change-kind rules (issue #1076) are edited with it as JSON: the admin's own rules, over the built-in rule.
import type { ChangeKindSettings, MergeGate, YoloModeView } from './wire.ts';

/** A repository's own setting: follow the default (`on`), or on or off for it alone. */
export type YoloSetting = 'default' | 'on' | 'off';
export interface YoloRow { repo: string; setting: YoloSetting; merges: boolean }
export interface YoloDraft { on: boolean; repos: Record<string, YoloSetting> }
export type YoloPatch = { on?: boolean; repos?: Record<string, boolean | null> };

export const YOLO_WARNING = 'With yolo mode on, the hopper merges a job\'s pull request once the repo\'s checks pass, or two minutes after its last push when the repo has no checks: no person reviews the change first. '
  + 'If the repo has no branch protection, nothing else stops the merge, and a merge to the default branch runs whatever it triggers there — '
  + 'a release, an image build, a deploy. Turn it on only for repos where you accept that. A job is done either way: done is its pull request, ready for review.';

const settingOf = (v: Pick<YoloModeView, 'repos'>, repo: string): YoloSetting => {
  const own = v.repos[repo.toLowerCase()];
  return own === undefined ? 'default' : own ? 'on' : 'off';
};

/** Whether a repository's jobs merge (issue #737): its own setting, else the default. */
export const repoMerges = (v: Pick<YoloModeView, 'on' | 'repos'>, repo: string): boolean => {
  const setting = settingOf(v, repo);
  return setting === 'default' ? v.on : setting === 'on';
};

/** Every job repository, then each other repository set apart (a job repository no more), with whether its jobs merge. */
export function yoloRows(v: YoloModeView): YoloRow[] {
  const listed = new Set(v.choices.repos.map((r) => r.toLowerCase()));
  const repos = [...v.choices.repos, ...Object.keys(v.repos).filter((r) => !listed.has(r)).sort()];
  return repos.map((repo) => {
    const setting = settingOf(v, repo);
    return { repo, setting, merges: repoMerges(v, repo) };
  });
}

export function yoloSummary(v: YoloModeView): string {
  const merging = yoloRows(v).filter((r) => r.merges).length;
  if (v.on && yoloRows(v).every((r) => r.setting !== 'off')) return 'On: jobs and the hopper merge ready pull requests once the checks pass, in every job repository.';
  if (merging === 0) return 'Off: no job merges its own pull request.';
  return `On in ${merging} ${merging === 1 ? 'repository' : 'repositories'}: jobs and the hopper merge ready pull requests there once the checks pass.`;
}

/** The change a save sends: only what differs from `v`; undefined when nothing does. */
export function yoloPatch(v: YoloModeView, d: YoloDraft): YoloPatch | undefined {
  const repos: Record<string, boolean | null> = {};
  for (const [repo, s] of Object.entries(d.repos)) {
    if (s === settingOf(v, repo)) continue;
    repos[repo.toLowerCase()] = s === 'default' ? null : s === 'on';
  }
  const p: YoloPatch = { ...(d.on !== v.on ? { on: d.on } : {}), ...(Object.keys(repos).length ? { repos } : {}) };
  return Object.keys(p).length ? p : undefined;
}

/**
 * The header's yolo mode (issue #897), on every screen: off, on in every repository, or on in some, with the summary as its
 * title. Undefined for an answer without the settings: it is never read as off.
 */
export function yoloIndicator(v: YoloModeView | undefined): { on: boolean; words: string; title: string } | undefined {
  if (typeof v?.on !== 'boolean' || !Array.isArray(v.choices?.repos)) return undefined;
  const rows = yoloRows(v);
  const merging = rows.filter((r) => r.merges).length;
  const on = rows.length ? merging > 0 : v.on;
  const words = !on ? 'yolo off' : merging === rows.length ? 'yolo on' : `yolo on: ${merging} of ${rows.length} repos`;
  return { on, words, title: yoloSummary(v) };
}

/** The admin's change-kind rules as the editor shows them (issue #1076); '' for the built-in rule. */
export const changeKindsText = (v: YoloModeView): string => (v.changeKinds ? JSON.stringify(v.changeKinds, null, 2) : '');

/** The editor's text as the rules a save sends: `null` for empty text (the built-in rule again); else an object, or why not. */
export function parseChangeKinds(text: string): { ok: true; value: ChangeKindSettings | null } | { ok: false; error: string } {
  if (text.trim() === '') return { ok: true, value: null };
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'the rules are a JSON object: { "default": {…}, "repos": { "owner/repo": {…} } }' };
    return { ok: true, value: value as ChangeKindSettings };
  } catch (e) {
    return { ok: false, error: `not JSON: ${(e as Error).message}` };
  }
}

const GATE_TEXT: Record<MergeGate, string> = { ready: 'merged when ready, no person asked', yolo: 'merged when ready only with yolo mode on', person: 'only a person merges' };
/** What a kind's merge gate does, in plain words. */
export const gateText = (g: MergeGate): string => GATE_TEXT[g];

