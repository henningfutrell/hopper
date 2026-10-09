// Yolo mode in the UI (issue #579), pure: the rows the panel lists, its summary, and the change a save sends.
import type { YoloModeView } from './wire.ts';

/** A repository's own setting: follow the default (`on`), or on or off for it alone. */
export type YoloSetting = 'default' | 'on' | 'off';
export interface YoloRow { repo: string; setting: YoloSetting; merges: boolean }
export interface YoloDraft { on: boolean; repos: Record<string, YoloSetting> }
export type YoloPatch = { on?: boolean; repos?: Record<string, boolean | null> };

export const YOLO_WARNING = 'With yolo mode on, a job merges its own pull request once the repo\'s checks pass: no person reviews the change first. '
  + 'If the repo has no branch protection, nothing else stops the merge, and a merge to the default branch runs whatever it triggers there — '
  + 'a release, an image build, a deploy. Turn it on only for repos where you accept that. A job is done either way: done is its pull request, ready for review.';

const settingOf = (v: Pick<YoloModeView, 'repos'>, repo: string): YoloSetting => {
  const own = v.repos[repo.toLowerCase()];
  return own === undefined ? 'default' : own ? 'on' : 'off';
};

/** Every job repository, then each other repository set apart (a job repository no more), with whether its jobs merge. */
export function yoloRows(v: YoloModeView): YoloRow[] {
  const listed = new Set(v.choices.repos.map((r) => r.toLowerCase()));
  const repos = [...v.choices.repos, ...Object.keys(v.repos).filter((r) => !listed.has(r)).sort()];
  return repos.map((repo) => {
    const setting = settingOf(v, repo);
    return { repo, setting, merges: setting === 'default' ? v.on : setting === 'on' };
  });
}

export function yoloSummary(v: YoloModeView): string {
  const merging = yoloRows(v).filter((r) => r.merges).length;
  if (v.on && yoloRows(v).every((r) => r.setting !== 'off')) return 'On: jobs merge their own pull requests once the checks pass, in every job repository.';
  if (merging === 0) return 'Off: no job merges its own pull request.';
  return `On in ${merging} ${merging === 1 ? 'repository' : 'repositories'}: jobs there merge their own pull requests once the checks pass.`;
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
