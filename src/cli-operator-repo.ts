// Repositories with no checks from the command line (issue #677, design.md "Repositories with no checks"): `hopper repo
// checks <repo>` prints that job repository's checks and the recommended "Add PR checks" job, as GET /api/repo-checks
// answers it, read from GitHub now.
import { usage, type Call } from './cli-operator-call.ts';

export const REPO_USAGE = `  hopper repo checks <owner/repo>                    the job repository's checks for pull requests, and the job that adds them when it has none`;

export function repoCall(args: string[]): Call {
  const [verb, repo, ...extra] = args;
  if (verb !== 'checks' || !repo || !/^[^/\s]+\/[^/\s]+$/.test(repo) || extra.length > 0) throw usage('repo checks <owner/repo>');
  return { role: 'viewer', path: `/api/repo-checks?repo=${encodeURIComponent(repo)}` };
}
