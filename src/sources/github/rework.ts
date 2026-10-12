// Rework on GitHub (issue #724, design.md "Rework"): a person sends a done job's open pull request back. The pull request
// the job follows becomes a draft — it stays open on its branch, so the new job pushes to it and opens no other —, then
// the issue is taken back as for Run again (`takeBack`: the end labels go, `hopper:pr-ready` with them). The ended job's
// source state stops following it (`follow: reworked`): the new job follows it once it ends done. A job with no open
// pull request to rework is refused (RerunRefused), and nothing is changed.
import type { Job } from '../../domain/types.ts';
import { RerunRefused } from '../../domain/rerun-refused.ts';
import type { GitHubIssue } from './api.ts';
import { sourceError, takeBack, type ReportContext } from './report.ts';

const pullOf = (url: string): { repo: string; number: number } | undefined => {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
  return m ? { repo: m[1]!, number: Number(m[2]) } : undefined;
};

export async function sendBack(ctx: ReportContext, label: string, job: Job, assignee: string | undefined): Promise<{ issue: GitHubIssue; pullRequest: string; state: Record<string, unknown> }> {
  const s = (job.sourceState?.source ?? {}) as Record<string, unknown> & { follow?: unknown; pullRequest?: unknown };
  const url = typeof s.pullRequest === 'string' ? s.pullRequest : undefined;
  const at = url === undefined ? undefined : pullOf(url);
  if (s.follow !== 'open' || url === undefined || at === undefined) throw new RerunRefused('it names no open pull request to rework yet');
  try {
    const pr = await ctx.api.pullRequest(at.repo, at.number);
    if (pr?.state !== 'open') throw new RerunRefused(`its pull request ${url} is ${pr?.state ?? 'gone'}: there is no open pull request to rework`);
    await ctx.api.toDraft(at.repo, at.number);
  } catch (err) {
    throw err instanceof RerunRefused ? err : sourceError(err);
  }
  const issue = await takeBack(ctx, label, job, assignee);
  return { issue, pullRequest: url, state: { ...s, follow: 'reworked' } };
}
