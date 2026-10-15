// A pull request's diff as a person reads it on the Pull requests page (issue #1169, design.md "Pull request diffs"):
// what POST /ui/api/pull-requests/diff answers, from the same read a job's `pr diff` makes (issue #1074).

/** One changed file: its path, how it changed, its lines added and removed, and its old path when it moved. */
export interface PullRequestDiffFile { file: string; status: string; additions: number; deletions: number; from?: string }

export interface PullRequestDiff {
  number: number;
  url: string;
  files: PullRequestDiffFile[];
  /** Each file's patch as `git diff` writes it; a binary or too large file says it has none. */
  diff: string;
  /** The diff is its start only: it was longer than the hopper answers. */
  truncated?: boolean;
}
