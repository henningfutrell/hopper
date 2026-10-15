// Yolo mode (issue #579): whether a job may merge its own pull request once the repo's checks pass. Done never
// depends on it — done is always the job's pull request open and ready for review —; yolo mode only adds the merge.
// Off unless a person turns it on: for the user's job repositories as a whole (`on`), and per repository
// (`repos`, `owner/repo` lowercased → on or off), which wins. Kept in the user's settings, read each time a job's
// prompt is built, so a change applies to the next job without a restart. Pure.
// Change kinds (issue #1076, change-kinds.ts) are set with it: the rules that classify a pull request, and the merge gate
// of each kind — yolo mode is the `yolo` gate. Absent: the built-in rule.

import { DEFAULT_CHANGE_RULE, type ChangeKindSettings, type ChangeRule } from './change-kinds.ts';

export interface YoloModeSettings {
  /** Every repository's yolo mode unless `repos` names it. */
  on: boolean;
  /** Per repository, `owner/repo` lowercased: on or off, over `on`. */
  repos: Record<string, boolean>;
  /** The change-kind rules over the built-in rule (issue #1076); absent: the built-in rule. */
  changeKinds?: ChangeKindSettings;
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
}

const key = (repo: string): string => repo.toLowerCase();

/** Whether a job on `repo` may merge its own pull request. */
export function yoloModeFor(s: YoloModeSettings, repo: string): boolean {
  return s.repos[key(repo)] ?? s.on;
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
  return { on: p.on ?? s.on, repos: Object.fromEntries(Object.entries(repos).sort(([a], [b]) => a.localeCompare(b))), ...(lowered ? { changeKinds: lowered } : {}) };
}
