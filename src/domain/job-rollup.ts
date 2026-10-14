// Finished work rolls up on the job graph (issue #1036, design.md "The job graph", part 4). Split from job-graph.ts. Pure,
// and from what the hopper keeps already: no read of its own. A pull request any job or the issue graph saw merged is
// merged for every job that names it — a tend or a rework hands it to a newer job, which follows it to its end —, with no
// checks or conflicts; an issue GitHub closed as completed is done; a failed or cancelled job that a later job of its
// issue, its issue's close, the merge of the pull request it tended, or a person's dismissal took the place of is
// superseded.
import type { GraphNode } from './issue-graph.ts';
import { issueNodeId, pullRequestOf, stageAt, type JobGraphPullRequest, type JobStage } from './job-graph.ts';
import type { Tended } from './pull-requests.ts';
import type { Job } from './types.ts';

/** The states a pull request never leaves, and which wins when two say different (issue #1036): merged over the rest. */
const FINAL_RANK: Readonly<Record<string, number>> = { merged: 2, closed: 1, abandoned: 1 };
/** Why a closed issue closed when it is not done by its close. */
const NOT_COMPLETED: readonly string[] = ['not_planned', 'duplicate'];

interface Rolled { final?: string; open?: JobGraphPullRequest }

/**
 * Each pull request the jobs name, rolled up over them and the issue graph (issue #1036): `final`, the state it never
 * leaves (merged, closed, abandoned) when a job's follow or the issue graph saw it there; `open`, what its newest follower
 * saw of it while open. A tend or a rework hands the pull request to a newer job, which follows it to its end.
 */
function rolledPullRequests(jobs: readonly Job[], graphNodes: readonly GraphNode[]): Map<string, Rolled> {
  const out = new Map<string, Rolled>();
  const saw = (url: string, state: string, view?: JobGraphPullRequest) => {
    const r = out.get(url) ?? {};
    const rank = FINAL_RANK[state];
    if (rank !== undefined && (r.final === undefined || rank >= FINAL_RANK[r.final]!)) r.final = state;
    if (state === 'open' && view) r.open = view;
    out.set(url, r);
  };
  for (const job of jobs) {
    const pr = pullRequestOf(job);
    if (pr) saw(pr.url, pr.state, pr);
  }
  // The issue graph says only what one read saw: merged is final; closed or open may have changed since.
  for (const n of graphNodes) if (n.kind === 'pull_request' && String(n.attrs.state ?? '').toLowerCase() === 'merged') saw(n.id, 'merged');
  return out;
}

/** What the graph reads of the rollup. */
export interface Rollup {
  /** A job's pull request as the graph shows it: rolled up over every job that names it. */
  viewOf(job: Job): JobGraphPullRequest | undefined;
  /** Each job's stage, by its id. */
  stages: Map<string, JobStage>;
  /** The issue nodes GitHub closed as completed, as the issue graph last read them. */
  completed: Set<string>;
  /** The job each issue reads its stage, its words and whether a run again redoes a failed run from. */
  newestOf: Map<string, Job>;
}

const followedOf = (job: Job): { follow?: string; tended?: Tended } => (job.sourceState?.source ?? {}) as { follow?: string; tended?: Tended };
const issueOf = (job: Job): string | undefined => (job.source?.repo && job.source.number !== undefined ? issueNodeId(job.source.repo, job.source.number) : undefined);

/** The rollup of `jobs`, oldest first, over the issue graph's nodes. */
export function rollUp(jobs: readonly Job[], graphNodes: readonly GraphNode[]): Rollup {
  const rolled = rolledPullRequests(jobs, graphNodes);
  const viewOf = (job: Job): JobGraphPullRequest | undefined => {
    const pr = pullRequestOf(job);
    const r = pr && rolled.get(pr.url);
    if (!pr || !r) return pr;
    // A pull request that ended shows no checks, draft or conflicts: they are what it was, not what it is.
    if (r.final) return { url: pr.url, state: r.final };
    return r.open ? { ...r.open, state: pr.state } : pr;
  };
  // The issues GitHub closed as completed, as the issue graph last read them.
  const completed = new Set<string>();
  for (const n of graphNodes) {
    const { repo, number, state, stateReason } = n.attrs;
    if (n.kind === 'issue' && typeof repo === 'string' && typeof number === 'number' && String(state).toLowerCase() === 'closed'
      && !NOT_COMPLETED.includes(String(stateReason ?? '').toLowerCase())) completed.add(issueNodeId(repo, number));
  }
  const stages = new Map<string, JobStage>();
  for (const job of jobs) {
    let stage = stageAt(job, rolled.get(pullRequestOf(job)?.url ?? '')?.final ?? followedOf(job).follow);
    // Nothing waits on a part's merge once its issue is done.
    if (stage === 'partly_done' && completed.has(issueOf(job) ?? '')) stage = 'done';
    stages.set(job.id, stage);
  }
  // The jobs of each issue, oldest first.
  const jobsOf = new Map<string, Job[]>();
  for (const job of jobs) {
    const issue = issueOf(job);
    if (issue) jobsOf.set(issue, [...jobsOf.get(issue) ?? [], job]);
  }
  // The tend jobs of a pull request that merged after all.
  const tendOfMerged = new Set<string>();
  for (const job of jobs) {
    const t = followedOf(job).tended;
    if (t && rolled.get(t.pullRequest)?.final === 'merged') tendOfMerged.add(t.nextJobId);
  }
  for (const job of jobs) {
    const stage = stages.get(job.id)!;
    if (stage !== 'failed' && stage !== 'cancelled') continue;
    const issue = issueOf(job);
    const later = issue !== undefined && jobsOf.get(issue)!.at(-1) !== job;
    if (job.dismissedAt !== undefined || later || completed.has(issue ?? '') || tendOfMerged.has(job.id)) stages.set(job.id, 'superseded');
  }
  // The job each issue reads its stage, its words and whether a run again redoes a failed run from: its newest job not
  // superseded, else its newest.
  const newestOf = new Map<string, Job>();
  for (const [issue, list] of jobsOf) newestOf.set(issue, [...list].reverse().find((j) => stages.get(j.id) !== 'superseded') ?? list.at(-1)!);

  return { viewOf, stages, completed, newestOf };
}
