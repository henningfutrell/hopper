// The issue graph from a GitHub source (issue #437, design.md "The issue graph"): after each discover, the place of each
// issue it listed is read and kept, when its last read is older than the source's `graphRefreshMinutes` or GitHub says
// the issue changed since. Nothing depends on it: a read or a write that fails is only said, per issue, in the source's
// status (`graphErrors`), and the discover goes on as if there were no graph.
// The graph refresh (issue #1036): an item the graph shows not done — an issue no job works, or a pull request no job
// follows — learns that it closed or merged only from a later read of an issue that links it. So each refresh interval the
// source reads the state of every such item in one batched read (`graphStates`), never one read for each item.
import { placeGraph, type GraphNode, type IssueGraphRepository } from '../../domain/issue-graph.ts';
import type { Clock } from '../../domain/ports.ts';
import { itemKey, type GitHubApi, type GitHubIssue } from './api.ts';

/** What a source writes and reads of the issue graph. */
export type IssueGraphRecorder = Pick<IssueGraphRepository, 'record' | 'lastRead' | 'unsettled' | 'keepStates'>;

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

/** What the last graph refresh did, for the source's status: when, how many items it read, how many changed and how many GitHub did not answer for. */
export interface GraphRefreshResult { at: string; read: number; changed: number; unanswered: number; error?: string }

export interface IssueGraphKeeper {
  /** After a discover: keep the place of each issue whose read is due, then refresh the graph when its interval passed (the first: at once). */
  keep(issues: GitHubIssue[]): Promise<void>;
  /** For the source's status: the reads that failed by issue URL (`graphErrors`), and what the last refresh did (`graphRefresh`). */
  detail(): { graphErrors?: Record<string, string>; graphRefresh?: GraphRefreshResult };
}

/** A source's issue graph: each discover's reads, and the graph refresh, in one batched read each `refreshMinutes`. */
export function issueGraphKeeper(o: GraphRecording & { api: Pick<GitHubApi, 'graphStates'> }): IssueGraphKeeper {
  let errors: Record<string, string> = {};
  let refreshed: GraphRefreshResult | undefined;
  let last: number | undefined;
  return {
    async keep(issues) {
      errors = await recordIssueGraph(o, issues);
      const now = o.clock.now();
      if (!o.api.graphStates || (last !== undefined && now.getTime() - last < o.refreshMinutes * 60_000)) return;
      last = now.getTime();
      refreshed = await refreshIssueGraph(o.graph, o.api.graphStates.bind(o.api), now, o.refreshMinutes);
    },
    detail: () => ({ ...(Object.keys(errors).length ? { graphErrors: errors } : {}), ...(refreshed ? { graphRefresh: refreshed } : {}) }),
  };
}

const isItem = <N extends GraphNode>(n: N): n is N & { attrs: { repo: string; number: number } } => typeof n.attrs.repo === 'string' && typeof n.attrs.number === 'number';

async function refreshIssueGraph(graph: IssueGraphRecorder, read: NonNullable<GitHubApi['graphStates']>, now: Date, refreshMinutes: number): Promise<GraphRefreshResult> {
  // An issue read for itself within the interval is current: its own read said its state.
  const due = graph.unsettled().filter(isItem).filter((n) => !(n.readAt && now.getTime() - Date.parse(n.readAt) < refreshMinutes * 60_000));
  const result: GraphRefreshResult = { at: now.toISOString(), read: due.length, changed: 0, unanswered: 0 };
  if (due.length === 0) return result;
  let got;
  try {
    got = await read(due.map((n) => ({ repo: n.attrs.repo, number: n.attrs.number })));
  } catch (err) {
    return { ...result, error: (err as Error).message };
  }
  const changed: { id: string; attrs: GraphNode['attrs'] }[] = [];
  for (const n of due) {
    const s = got.items.get(itemKey(n.attrs.repo, n.attrs.number));
    if (!s) { result.unanswered++; continue; }
    if (s.state === String(n.attrs.state ?? '').toLowerCase() && (s.stateReason ?? '') === String(n.attrs.stateReason ?? '')) continue;
    changed.push({ id: n.id, attrs: { state: s.state, ...(s.stateReason ? { stateReason: s.stateReason } : {}) } });
  }
  graph.keepStates(changed);
  return { ...result, changed: changed.length };
}
