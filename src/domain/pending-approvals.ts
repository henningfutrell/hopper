// Pending approvals (issue #2088, design.md "Pending approvals"), pure: the **intake orgs** (the owners of the job
// repositories), a waiting GitHub Actions run's row from GitHub's answers — only the environments the connection can
// approve —, and the **stale** mark: an older waiting run when, for each environment it waits on, a newer run of the
// same repository waits on it too. Read-only: the hopper never approves or rejects a deployment.

/** One GitHub Actions run that waits for a deployment approval the user can give. */
export interface PendingApproval {
  /** `owner/name`, as GitHub names it. */
  repo: string;
  runId: number;
  /** The workflow's name. */
  workflow: string;
  /** The run's title (`display_title`), else the workflow's name. */
  title: string;
  /** The environments it waits on that the user can approve, sorted. */
  environments: string[];
  /** When it began to wait: the earliest wait of those environments, else when the run was made. */
  waitingSince: string;
  /** The run's page on GitHub. */
  url: string;
  /** A newer waiting run of the same repository waits on each of its environments. */
  stale: boolean;
}

/** What could not be read: a repository, or a connected account as a whole. */
export interface PendingApprovalsProblem { where: string; error: string }

/** `GET /api/pending-approvals`: what the last read found, never read from GitHub at request time. */
export interface PendingApprovalsView {
  approvals: PendingApproval[];
  /** The intake orgs read. */
  orgs: string[];
  problems: PendingApprovalsProblem[];
  /** When the last read ended; absent: not read yet. */
  checkedAt?: string;
  /** A read is under way. */
  reading?: true;
}

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === 'object' ? v as Raw : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The owners of the job repositories, once each, in lower case, sorted. */
export const intakeOrgs = (repos: readonly string[]): string[] =>
  [...new Set(repos.map((r) => r.split('/')[0]!.toLowerCase()).filter(Boolean))].sort();

/**
 * A waiting run's row: `run` as `GET …/actions/runs` lists it, `deployments` as `GET …/runs/{id}/pending_deployments`
 * answers. Undefined when it waits on no environment the connection can approve (`current_user_can_approve`).
 */
export function pendingApprovalOf(repo: string, run: Raw, deployments: readonly unknown[]): Omit<PendingApproval, 'stale'> | undefined {
  const mine = deployments.map(obj).filter((d) => d.current_user_can_approve === true && str(obj(d.environment).name));
  if (mine.length === 0) return undefined;
  const waits = mine.map((d) => str(d.wait_timer_started_at)).filter(Boolean).sort();
  return {
    repo, runId: Number(run.id), workflow: str(run.name), title: str(run.display_title) || str(run.name),
    environments: [...new Set(mine.map((d) => str(obj(d.environment).name)))].sort(),
    waitingSince: waits[0] ?? str(run.created_at), url: str(run.html_url),
  };
}

const envKey = (repo: string, environment: string): string => `${repo.toLowerCase()} ${environment}`;

/** Each row with its stale mark; fresh rows first, the longest waiting first, then the stale ones the same way. */
export function markStale(rows: readonly Omit<PendingApproval, 'stale'>[]): PendingApproval[] {
  // A run id grows with each run: the newest run waiting on a repository's environment has the highest.
  const newest = new Map<string, number>();
  for (const r of rows) for (const e of r.environments) newest.set(envKey(r.repo, e), Math.max(newest.get(envKey(r.repo, e)) ?? 0, r.runId));
  return rows
    .map((r) => ({ ...r, stale: r.environments.every((e) => newest.get(envKey(r.repo, e))! > r.runId) }))
    .sort((a, b) => Number(a.stale) - Number(b.stale) || a.waitingSince.localeCompare(b.waitingSince) || a.runId - b.runId);
}
