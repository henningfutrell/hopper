// Yolo mode in the UI (issue #579), pure: the rows the panel lists, its summary, and the change a save sends. The
// change-kind rules (issue #1076) are edited with it as JSON: the admin's own rules, over the built-in rule. Direct push
// (issue #1806) too: the repositories where a job may push straight to the target branch, one a line. A repository the
// hopper does not work on (issue #1806 part 3) merges only when named on: the default covers the job repositories only.
import type { ChangeKindSettings, MergeGate, YoloModeView } from './wire.ts';

/** A repository's own setting: follow the default (`on`), or on or off for it alone. */
export type YoloSetting = 'default' | 'on' | 'off';
/** `outside`: none of the job repositories (issue #1806), so the default does not merge there. */
export interface YoloRow { repo: string; setting: YoloSetting; merges: boolean; outside?: true }
export interface YoloDraft { on: boolean; repos: Record<string, YoloSetting> }
export type YoloPatch = { on?: boolean; repos?: Record<string, boolean | null>; push?: string[] };

export const YOLO_WARNING = 'With yolo mode on, the hopper merges a job\'s pull request once the repo\'s checks pass, or two minutes after its last push when the repo has no checks: no person reviews the change first. '
  + 'If the repo has no branch protection, nothing else stops the merge, and a merge to the default branch runs whatever it triggers there — '
  + 'a release, an image build, a deploy. Turn it on only for repos where you accept that. A job is done either way: done is its pull request, ready for review.';

/** Yolo mode on a repository the hopper does not work on (issue #1806): what naming it on allows. */
export const OUTSIDE_YOLO_WARNING = 'A repository below that is not one of your job repositories merges only when you set it on: the switch above does not reach it. '
  + 'On, the hopper merges a pull request a job opened there once it is ready, with your GitHub account, and no person reviews it first.';

const isOutside = (v: Pick<YoloModeView, 'choices'>, repo: string): boolean => !v.choices.repos.some((r) => r.toLowerCase() === repo.toLowerCase());

const settingOf = (v: Pick<YoloModeView, 'repos'>, repo: string): YoloSetting => {
  const own = v.repos[repo.toLowerCase()];
  return own === undefined ? 'default' : own ? 'on' : 'off';
};

/** Whether a repository's jobs merge (issue #737): its own setting, else the default, which covers the job repositories only (issue #1806). */
export const repoMerges = (v: Pick<YoloModeView, 'on' | 'repos' | 'choices'>, repo: string): boolean => {
  const setting = settingOf(v, repo);
  return setting === 'default' ? v.on && !isOutside(v, repo) : setting === 'on';
};

/** Every job repository, then each other repository set apart (a job repository no more), with whether its jobs merge. */
export function yoloRows(v: YoloModeView): YoloRow[] {
  const listed = new Set(v.choices.repos.map((r) => r.toLowerCase()));
  const repos = [...v.choices.repos, ...Object.keys(v.repos).filter((r) => !listed.has(r)).sort()];
  return repos.map((repo) => {
    const setting = settingOf(v, repo);
    return { repo, setting, merges: repoMerges(v, repo), ...(isOutside(v, repo) ? { outside: true as const } : {}) };
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

/** The draft with repository `text` added, on (issue #1806): `owner/repo`, lowercased, not listed yet; else why not. */
export function addYoloRepo(d: YoloDraft, text: string): { ok: true; draft: YoloDraft } | { ok: false; error: string } {
  const repo = text.trim().toLowerCase();
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) return { ok: false, error: 'name a repository as owner/repo' };
  if (Object.keys(d.repos).some((r) => r.toLowerCase() === repo)) return { ok: false, error: `${repo} is listed already` };
  return { ok: true, draft: { ...d, repos: { ...d.repos, [repo]: 'on' } } };
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


export const DIRECT_PUSH_WARNING = 'With direct push on for a repository, a job may push its commits straight to the repository\'s target branch — its landing branch, else its default branch — with no pull request: no person reviews the change first. '
  + 'The hopper takes only a push that adds commits on top of the branch, never one that rewrites it, and only where your GitHub connection can push. A push to the default branch runs whatever it triggers there. '
  + 'It is off unless you name the repository here, any repository your connection can push to. Each push is on the job\'s timeline.';

/** Direct push's repositories as the editor shows them (issue #1806): one a line. */
export const directPushText = (v: YoloModeView): string => (v.push ?? []).join('\n');

/** The editor's text as the change a save sends (issue #1806): the whole list, or undefined when it is the same; or why not. */
export function directPushPatch(v: YoloModeView, text: string): { ok: true; value: YoloPatch | undefined } | { ok: false; error: string } {
  const repos: string[] = [];
  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    if (!/^[^/\s]+\/[^/\s]+$/.test(line)) return { ok: false, error: `not owner/repo: ${line}` };
    repos.push(line.toLowerCase());
  }
  const push = [...new Set(repos)].sort();
  return { ok: true, value: push.join('\n') === (v.push ?? []).join('\n') ? undefined : { push } };
}
