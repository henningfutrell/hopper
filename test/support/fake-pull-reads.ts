// The fake GitHub's reads of a pull request a job asks through the hopper (issue #1074, fake-forges.ts): its files with
// their patches, its commits, and the check runs and combined status of a commit. What a test did not set is empty.

/** One file of a pull request, as GitHub's REST answers it. */
export interface FakePullFile { filename: string; status: string; additions: number; deletions: number; patch?: string; previous_filename?: string }

/** The fake GitHub's option for it (a field of `FakeForge`). */
export interface PullReadsForge {
  /** GitHub: each pull request's files, by `owner/name#N`. */
  pullFiles?: Record<string, FakePullFile[]>;
  /** GitHub: each pull request's commits, by `owner/name#N`, as GitHub's REST answers them. */
  pullCommits?: Record<string, Record<string, unknown>[]>;
  /** GitHub: each commit's check runs and statuses, by `owner/name@sha`. */
  commitChecks?: Record<string, { runs?: Record<string, unknown>[]; statuses?: Record<string, unknown>[] }>;
}

type Answer = { status: number; body?: unknown };

/** The answer to a read of a pull request's files or commits, or of a commit's checks or status; undefined: `rest` is none. */
export function pullReadsRoute(forge: PullReadsForge | undefined, method: string, repo: string, rest: string): Answer | undefined {
  if (method !== 'GET') return undefined;
  const p = /^pulls\/(\d+)\/(files|commits)$/.exec(rest);
  if (p) {
    const key = `${repo}#${p[1]}`;
    return { status: 200, body: (p[2] === 'files' ? forge?.pullFiles?.[key] : forge?.pullCommits?.[key]) ?? [] };
  }
  const c = /^commits\/([^/]+)\/(check-runs|status)$/.exec(rest);
  if (!c) return undefined;
  const checks = forge?.commitChecks?.[`${repo}@${c[1]}`];
  if (c[2] === 'check-runs') return { status: 200, body: { total_count: checks?.runs?.length ?? 0, check_runs: checks?.runs ?? [] } };
  return { status: 200, body: { state: 'success', statuses: checks?.statuses ?? [] } };
}
