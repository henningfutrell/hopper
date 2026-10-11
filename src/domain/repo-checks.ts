// Repositories with no checks (issue #677): in a job repository with no checks, yolo mode merges a ready pull request
// that nothing verified. A repository has checks when its default branch requires a status check (branch protection or a
// ruleset), a workflow file runs on pull requests, or a recent pull request had checks; with none of the three it has
// no checks, and the hopper recommends the job that adds them, "Add PR checks to <repo>", until checks run or the person
// dismisses it for that repository. Pure.
import { parse } from 'yaml';

/** `unknown`: GitHub could not be read (or was not read yet); never taken as no checks. */
export type RepoChecksState = 'checks' | 'no checks' | 'unknown';

/** What GitHub showed of a repository's checks. */
export interface RepoChecksFound {
  /** The status checks its default branch requires: its branch protection and its rulesets, each name once. */
  required: string[];
  /** The workflow files (names in `.github/workflows`) that run on pull requests. */
  workflows: string[];
  /** Its newest pull requests read, and how many of them had checks (check runs or commit statuses). */
  pullRequests: { read: number; withChecks: number };
}

/** The recommended job, while a repository has no checks and the person did not dismiss it. */
export interface RepoChecksRecommendation {
  title: string;
  /** Its open issue, when one is queued already (by this button or by hand): the button is not offered again. */
  queued?: { number: number; url: string };
}

/** One job repository, as GET /api/repo-checks answers it. */
export interface RepoChecks {
  repo: string;
  state: RepoChecksState;
  found?: RepoChecksFound;
  /** When GitHub was read for it last; absent: not read yet. */
  checkedAt?: string;
  /** Why the state is unknown. */
  error?: string;
  /** Its yolo mode: with no checks, yolo mode merges unverified code. */
  yolo: boolean;
  /** The person dismissed the recommendation for this repository. */
  dismissed: boolean;
  recommendation?: RepoChecksRecommendation;
}

export interface RepoChecksView { repos: RepoChecks[] }

/** What queuing the job answers: the issue filed now, or the open one queued before. */
export interface RepoChecksQueued { kind: 'filed' | 'exists'; number: number; url: string }

/** `checks` when any of the three is found; else `no checks`. */
export function repoChecksState(f: RepoChecksFound): Exclude<RepoChecksState, 'unknown'> {
  return f.required.length > 0 || f.workflows.length > 0 || f.pullRequests.withChecks > 0 ? 'checks' : 'no checks';
}

const PR_EVENTS = new Set(['pull_request', 'pull_request_target']);

/** Whether a workflow file's `on:` names a pull request event; a file that does not parse runs on nothing. */
export function runsOnPullRequests(text: string): boolean {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch {
    return false;
  }
  const on = (doc as { on?: unknown } | null)?.on;
  if (typeof on === 'string') return PR_EVENTS.has(on);
  if (Array.isArray(on)) return on.some((e) => typeof e === 'string' && PR_EVENTS.has(e));
  if (on && typeof on === 'object') return Object.keys(on).some((e) => PR_EVENTS.has(e));
  return false;
}

/** The recommended job's issue: a normal hopper job; the job finds the stack and adds the checks. */
export function addChecksJob(repo: string): { title: string; body: string } {
  return {
    title: `Add PR checks to ${repo}`,
    body: [
      'This repository has no checks for pull requests: no required status checks, no workflow that runs on pull requests, and no checks on its recent pull requests. With yolo mode on, the hopper merges a ready pull request here that no check verified.',
      '',
      '## Requirements',
      '1. Find the stack of the repository: its languages, its package manager, and the commands it has for the typecheck, the lint, the tests and the build.',
      '2. Add a GitHub Actions workflow that runs on pull requests. It runs the typecheck, the lint, the tests and the build that apply to this stack.',
      '3. Make the checks pass on the default branch. Do not turn off a test or a lint rule to make them pass.',
      '4. Make the new checks required status checks of the default branch, where the token allows it. If the token cannot set them, say in the pull request how a person sets them: the repository\'s Settings, then Rules or Branches, the default branch, and the names of the checks.',
      '',
      '## Done when',
      'A pull request in this repository runs the new checks, and they pass.',
    ].join('\n'),
  };
}
