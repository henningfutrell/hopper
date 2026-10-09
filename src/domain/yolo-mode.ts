// Yolo mode (issue #579): whether a job may merge its own pull request once the repo's checks pass. Done never
// depends on it — done is always the job's pull request open and ready for review —; yolo mode only adds the merge.
// Off unless a person turns it on: for the user's job repositories as a whole (`on`), and per repository
// (`repos`, `owner/repo` lowercased → on or off), which wins. Kept in the user's settings, read each time a job's
// prompt is built, so a change applies to the next job without a restart. Pure.

export interface YoloModeSettings {
  /** Every repository's yolo mode unless `repos` names it. */
  on: boolean;
  /** Per repository, `owner/repo` lowercased: on or off, over `on`. */
  repos: Record<string, boolean>;
}

/** As GET /api/yolo-mode answers it: the settings, and the job repositories the UI offers per repository. */
export interface YoloModeView extends YoloModeSettings { choices: { repos: string[] } }

export const DEFAULT_YOLO_MODE: YoloModeSettings = { on: false, repos: {} };

/** A change: any part. `repos` names repositories to set, or `null` to follow `on` again. */
export interface YoloModePatch {
  on?: boolean;
  repos?: Record<string, boolean | null>;
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
  return { on: p.on ?? s.on, repos: Object.fromEntries(Object.entries(repos).sort(([a], [b]) => a.localeCompare(b))) };
}
