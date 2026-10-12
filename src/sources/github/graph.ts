// The issue graph from a GitHub source (issue #437, design.md "The issue graph"): after each discover, the place of each
// issue it listed is read and kept, when its last read is older than the source's `graphRefreshMinutes` or GitHub says
// the issue changed since. Nothing depends on it: a read or a write that fails is only said, per issue, in the source's
// status (`graphErrors`), and the discover goes on as if there were no graph.
import { placeGraph, type IssueGraphRepository } from '../../domain/issue-graph.ts';
import type { Clock } from '../../domain/ports.ts';
import type { GitHubApi, GitHubIssue } from './api.ts';

/** What a source writes and reads of the issue graph. */
export type IssueGraphRecorder = Pick<IssueGraphRepository, 'record' | 'lastRead'>;

export interface GraphRecording {
  api: Pick<GitHubApi, 'issuePlace'>;
  graph: IssueGraphRecorder;
  clock: Clock;
  /** How old a read may get before the issue is read again, unchanged; 0: at every discover. */
  refreshMinutes: number;
}

/** Read and keep the place of each issue whose read is due; the errors by issue URL (none: {}). */
export async function recordIssueGraph(o: GraphRecording, issues: GitHubIssue[]): Promise<Record<string, string>> {
  const errors: Record<string, string> = {};
  if (!o.api.issuePlace) return errors;
  const now = o.clock.now();
  for (const issue of issues) {
    try {
      const last = o.graph.lastRead(issue.url);
      if (last && last.updatedAt === issue.updatedAt && now.getTime() - Date.parse(last.readAt) < o.refreshMinutes * 60_000) continue;
      o.graph.record(issue.url, placeGraph(await o.api.issuePlace(issue.repo, issue.number)), now.toISOString());
    } catch (err) {
      errors[issue.url] = (err as Error).message;
    }
  }
  return errors;
}
