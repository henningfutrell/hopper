// Repository setup (issue #652 requirement 8): a job pushes only to a branch of its own work, and yolo mode merges only
// after a check passed; GitHub is what keeps everyone else off a release branch. So the hopper checks that each guarded
// branch — the default branch and each release branch the repository has — needs a pull request and a status check and
// takes no force push, and that secret scanning and push protection are on. What GitHub does not show to the person's
// connection (branch protection and the security settings are shown only to a repository admin) is unread, never taken
// as missing. Pure.

/** What GitHub showed of one guarded branch's protection. */
export interface BranchProtectionRead {
  branch: string;
  /** `GET /repos/{r}/branches/{b}` `protected`. */
  protected: boolean;
  /** The status checks it requires: its branch protection and its rulesets, each name once. */
  checks: string[];
  /** The rule types of the rulesets on it (`GET /repos/{r}/rules/branches/{b}`). */
  rules: string[];
  /** Its branch protection (`GET /repos/{r}/branches/{b}/protection`); `none`: it has none; absent: GitHub did not show it. */
  protection?: { pullRequest: boolean; forcePushes: boolean } | 'none';
}

/** One guarded branch's setup; `null`: GitHub did not show it. */
export interface BranchSetup {
  branch: string;
  pullRequest: boolean | null;
  statusCheck: boolean;
  forcePushBlocked: boolean | null;
}

/** What GitHub showed of a repository's setup; `null`: GitHub did not show it. */
export interface RepoSetupFound {
  branches: BranchSetup[];
  secretScanning: boolean | null;
  pushProtection: boolean | null;
}

/** `unknown`: no problem found, but part of it was not shown, or GitHub was not read. */
export type RepoSetupState = 'set up' | 'not set up' | 'unknown';

/** A repository's setup, as GET /api/repo-checks answers it. */
export interface RepoSetup {
  state: RepoSetupState;
  /** What is missing, in words. */
  problems: string[];
  /** What GitHub did not show, in words. */
  unread: string[];
}

/** A ruleset's rule gives it, or the branch protection says so; with neither shown, unread. */
export function branchSetup(r: BranchProtectionRead): BranchSetup {
  const p = r.protection ?? (r.protected ? undefined : 'none');
  const shown = (rule: string, fromProtection: (q: { pullRequest: boolean; forcePushes: boolean }) => boolean): boolean | null => {
    if (r.rules.includes(rule)) return true;
    if (p === undefined) return null;
    return p === 'none' ? false : fromProtection(p);
  };
  return {
    branch: r.branch,
    pullRequest: shown('pull_request', (q) => q.pullRequest),
    statusCheck: r.checks.length > 0,
    forcePushBlocked: shown('non_fast_forward', (q) => !q.forcePushes),
  };
}

/** The problems and the unread points of a repository's setup; not read yet: unknown. */
export function repoSetup(f: RepoSetupFound | undefined): RepoSetup {
  if (!f) return { state: 'unknown', problems: [], unread: [] };
  const problems: string[] = [];
  const unread: string[] = [];
  const check = (v: boolean | null, problem: string, question: string): void => {
    if (v === false) problems.push(problem);
    if (v === null) unread.push(question);
  };
  for (const b of f.branches) {
    check(b.pullRequest, `${b.branch} takes a push with no pull request`, `whether ${b.branch} needs a pull request`);
    check(b.statusCheck, `${b.branch} requires no status check`, '');
    check(b.forcePushBlocked, `${b.branch} allows force pushes`, `whether ${b.branch} allows force pushes`);
  }
  check(f.secretScanning, 'secret scanning is off', 'whether secret scanning is on');
  check(f.pushProtection, 'push protection is off', 'whether push protection is on');
  return { state: problems.length > 0 ? 'not set up' : unread.length > 0 ? 'unknown' : 'set up', problems, unread };
}
