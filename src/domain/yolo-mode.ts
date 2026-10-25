// Yolo mode (issue #579): whether a job may merge its own pull request once the repo's checks pass. Done never
// depends on it — done is always the job's pull request open and ready for review —; yolo mode only adds the merge.
// Off unless a person turns it on: for the user's job repositories as a whole (`on`), and per repository
// (`repos`, `owner/repo` lowercased → on or off), which wins. Kept in the user's settings, read each time a job's
// prompt is built, so a change applies to the next job without a restart. Pure.
// Change kinds (issue #1076, change-kinds.ts) are set with it: the rules that classify a pull request, and the merge gate
// of each kind — yolo mode is the `yolo` gate. Absent: the built-in rule.
// Direct push (issue #1806) is set with it too: the repositories where a job may push straight to the target branch (its
// landing branch, else its default branch), as a fast-forward, within the user's own write access. Off unless a person
// names the repository, whatever `on` says: it is no part of the merge.
// A repository the hopper does not work on (issue #1806 part 3): a job may open a pull request on any repository its user
// can push to, and the hopper follows it there. `on` covers the job repositories only: the hopper merges on another
// repository only when a person named it on (`repos`), and only then by its change rule; else every kind waits for yolo mode.

import { CHANGE_KINDS, changeRuleFor, DEFAULT_CHANGE_RULE, type ChangeKindSettings, type ChangeRule } from './change-kinds.ts';

export interface YoloModeSettings {
  /** Every repository's yolo mode unless `repos` names it. */
  on: boolean;
  /** Per repository, `owner/repo` lowercased: on or off, over `on`. */
  repos: Record<string, boolean>;
  /** The change-kind rules over the built-in rule (issue #1076); absent: the built-in rule. */
  changeKinds?: ChangeKindSettings;
  /** Direct push (issue #1806): the repositories, `owner/repo` lowercased, where a job may push straight to the target branch; absent: none. */
  push?: string[];
}

/** As GET /api/yolo-mode answers it: the settings, the job repositories the UI offers per repository, and the built-in change rule. */
export interface YoloModeView extends YoloModeSettings { choices: { repos: string[]; changeRule?: ChangeRule } }

export const yoloChoices = (repos: string[]): YoloModeView['choices'] => ({ repos, changeRule: DEFAULT_CHANGE_RULE });

export const DEFAULT_YOLO_MODE: YoloModeSettings = { on: false, repos: {} };

/** A change: any part. `repos` names repositories to set, or `null` to follow `on` again. */
export interface YoloModePatch {
  on?: boolean;
  repos?: Record<string, boolean | null>;
  /** The change-kind rules, whole (issue #1076); `null`: the built-in rule again. */
  changeKinds?: ChangeKindSettings | null;
  /** Direct push's repositories, whole (issue #1806); empty: none. */
  push?: string[];
}

const key = (repo: string): string => repo.toLowerCase();

/**
 * Whether `repo` is one the hopper does not work on (issue #1806): a GitHub repository (`owner/repo`) that is none of the
 * user's job repositories. A GitLab project, asked by its URL, never is: a GitLab job works on its own project only.
 */
const outside = (repo: string, jobRepos: readonly string[]): boolean =>
  /^[^/\s]+\/[^/\s]+$/.test(repo) && !jobRepos.some((r) => key(r) === key(repo));

/** Whether a job on `repo` may merge its own pull request: its own setting, else `on`, which covers the job repositories `jobRepos` only (issue #1806). */
export function yoloModeFor(s: YoloModeSettings, repo: string, jobRepos: readonly string[]): boolean {
  return s.repos[key(repo)] ?? (s.on && !outside(repo, jobRepos));
}

/**
 * Whether the hopper merges nothing in `repo` (issue #2752): one it does not work on (issue #1806) that yolo mode does not merge
 * in. A pull request there waits on a person's merge there: `needs merge`, `hopper:needs-merge`.
 */
export const needsMergeIn = (s: YoloModeSettings, repo: string, jobRepos: readonly string[]): boolean => outside(repo, jobRepos) && !yoloModeFor(s, repo, jobRepos);

/**
 * The change rule the hopper merges a pull request of `repo` by (issue #1076): the user's. On a repository the hopper does
 * not work on that a person did not name on (issue #1806), every kind's gate is `yolo`: nothing is merged with no person.
 */
export function mergeRuleFor(s: YoloModeSettings, repo: string, jobRepos: readonly string[]): ChangeRule {
  const rule = changeRuleFor(s.changeKinds, repo);
  if (!outside(repo, jobRepos) || s.repos[key(repo)] === true) return rule;
  return { ...rule, merge: Object.fromEntries(CHANGE_KINDS.map((k) => [k, 'yolo'])) as ChangeRule['merge'] };
}

/** Whether a job on `repo` may push straight to its target branch (issue #1806): only when a person named the repository. */
export function directPushFor(s: YoloModeSettings, repo: string): boolean {
  return (s.push ?? []).includes(key(repo));
}

/** The settings after a change: a repository set to what `on` already says is kept, so it stays put when `on` changes. */
export function patchYoloMode(s: YoloModeSettings, p: YoloModePatch): YoloModeSettings {
  const repos = { ...s.repos };
  for (const [repo, v] of Object.entries(p.repos ?? {})) {
    if (v === null) delete repos[key(repo)];
    else repos[key(repo)] = v;
  }
  const changeKinds = p.changeKinds === undefined ? s.changeKinds : p.changeKinds ?? undefined;
  const lowered = changeKinds && { ...changeKinds, ...(changeKinds.repos ? { repos: Object.fromEntries(Object.entries(changeKinds.repos).map(([r, v]) => [key(r), v])) } : {}) };
  const push = p.push === undefined ? s.push : [...new Set(p.push.map(key))].sort();
  return {
    on: p.on ?? s.on, repos: Object.fromEntries(Object.entries(repos).sort(([a], [b]) => a.localeCompare(b))), ...(lowered ? { changeKinds: lowered } : {}),
    ...(push && push.length > 0 ? { push } : {}),
  };
}
