// The job graph and a job's parts list in plain words (issue #935, design.md "The job graph"): where a node stands, in
// human terms — Plan, Building it (attempt 2 of 3), PR open: checks running, Merged, Waiting on you: approve the plan — with no
// pull request number in it; whether it waits on the person; what comes next; and a job tree summed up in one line.
// Pure: the graph and the parts list call it with what they already read.
import type { JobGraphEdge, JobGraphNode, JobGraphPullRequest, JobStage, JobTree } from './job-graph.ts';
import type { OwnWait } from './own-command.ts';
import type { Job, JobStatus } from './types.ts';
import { waitOnLabel, type WaitOn } from './wait-on.ts';
import { pullRequestWaitOf, type PullRequestWait } from './work-items.ts';

/** What the words of a node are made from: its kind and stage, and for a job, its status, phase, attempt and pull request. */
export interface Worded {
  kind: 'job' | 'issue' | 'pull_request' | 'question' | 'handoff';
  stage: JobStage;
  status?: JobStatus;
  /** `proposal` or `research`: a review section's job; absent, the work itself. */
  phase?: string;
  /** A job on a wait for its own command (issue #1037): `command` while it runs, `stuck` once flagged stuck. */
  ownWait?: OwnWait;
  /** A job on its own wait: what it waits on (issue #1245); absent on a wait from before. */
  waitOn?: WaitOn;
  /** Its run in the chain of runs again of its issue (1 the first), and how many the failure settings allow. */
  attempt?: number;
  attempts?: number;
  pullRequest?: JobGraphPullRequest;
  /** A failed job a person dismissed (issue #1036). */
  dismissed?: true;
  /** A failed job whose item is handed to a person on its failure (issue #1067). */
  handedOff?: true;
  /** An issue closed as not planned or as a duplicate (issue #1895). */
  closed?: true;
  /** An issue that waits on its batch (issue #1337). */
  awaitsBatch?: true;
  /** A job queued or parked because a job of higher priority took its lane (issue #1525): that job, as people read it. */
  preemptedBy?: string;
}

/** The statuses a preempted job shows it in (issue #1525): parked, then queued again until it runs. */
const PREEMPT_SHOWN: ReadonlySet<JobStatus> = new Set<JobStatus>(['parked', 'queued', 'held']);

/** The job that took a preempted job's lane, as people read it: its issue number and title, else its goal, else its id. */
export function preempterLabel(job: Job | undefined, id: string): string {
  const s = job?.source;
  const title = s?.title || job?.spec.goal;
  if (s?.number !== undefined) return title ? `#${s.number} ${title}` : `#${s.number}`;
  return title || `job ${id}`;
}

/** Whether the job shows that it was preempted, and by whom: `label` names the job that took its lane (issue #1525). */
export const preemptedByOf = (job: Pick<Job, 'preempted' | 'status'>, label: (id: string) => string): { preemptedBy: string } | Record<string, never> =>
  job.preempted && PREEMPT_SHOWN.has(job.status) ? { preemptedBy: label(job.preempted.by) } : {};

const WAITING: Partial<Record<JobStatus, string>> = { operator_led: 'A person works on it', parked: 'Parked' };

/** What a person waits to be asked for: a plan to approve, a report to accept, a question to answer. */
function waitingOnYou(n: Worded): string | undefined {
  if (n.kind === 'question') return 'answer it';
  if (n.kind === 'handoff' || n.handedOff) return 'take it over';
  if (n.ownWait === 'stuck') return 'its own command is gone, so it is stuck';
  if (n.status !== 'waiting_answer') return undefined;
  if (n.phase === 'proposal') return 'approve the plan';
  if (n.phase === 'research') return 'accept the research';
  return 'answer a question';
}

/** True when the node waits on the person: a question, a hand-off, a plan or a report to read. */
export const waitsOnYou = (n: Worded): boolean => waitingOnYou(n) !== undefined;

/** What an open pull request waits on (issue #1067): named, never "ready for review" — a job's pull request is on its way to the merge. */
const PR_OPEN_WAIT = 'PR open: waiting for the merge';
const PR_WAIT_WORDS: Readonly<Record<PullRequestWait, string>> = {
  draft: 'PR open: draft', conflicts: 'PR open: has merge conflicts', fixing_checks: 'PR open: fixing checks',
  checks_running: 'PR open: checks running', merge: PR_OPEN_WAIT,
};

/** A pull request's stage, in words: what it waits on first. */
function pullRequestWords(pr: JobGraphPullRequest): string {
  if (pr.state === 'merged') return 'Merged';
  if (pr.state === 'closed') return 'Closed without a merge';
  if (pr.state === 'abandoned') return 'Dropped';
  if (pr.state === 'unknown') return 'Not followed yet';
  return PR_WAIT_WORDS[pullRequestWaitOf(pr)];
}

/** Where a node stands, in human terms. */
export function stageWords(n: Worded): string {
  const you = waitingOnYou(n);
  if (you) return `Waiting on you: ${you}`;
  if (n.kind === 'pull_request' && n.pullRequest) return pullRequestWords(n.pullRequest);
  switch (n.stage) {
    case 'queued': return n.preemptedBy ? `Queued: preempted by ${n.preemptedBy}` : 'Queued';
    case 'running': {
      if (n.ownWait === 'command') return 'Running: waiting on its own command';
      if (n.phase === 'proposal') return 'Plan';
      if (n.phase === 'research') return 'Research';
      return n.attempt && n.attempt > 1 ? `Building it (attempt ${n.attempt}${n.attempts ? ` of ${n.attempts}` : ''})` : 'Building it';
    }
    case 'waiting':
      if (n.status === 'waiting_on') return `Waiting on ${n.waitOn ? waitOnLabel(n.waitOn) : 'nothing recorded'}`;
      if (n.status === 'parked' && n.preemptedBy) return `Parked: preempted by ${n.preemptedBy}`;
      return (n.status && WAITING[n.status]) ?? 'Waiting';
    case 'pr_open': return n.pullRequest ? pullRequestWords(n.pullRequest) : PR_OPEN_WAIT;
    case 'partly_done': return 'Part shipped: the rest runs after the merge';
    case 'done': return n.awaitsBatch ? 'Merged: waits on its batch run' : n.pullRequest?.state === 'merged' ? 'Merged' : 'Done';
    case 'failed': return 'Failed';
    case 'cancelled': return n.closed ? 'Closed' : 'Cancelled';
    case 'superseded': return n.dismissed ? 'Dismissed' : 'Superseded';
    case 'no_job': return 'Not started';
  }
}

/** What comes next for a job, and who does it: the person, the agent, or nobody. */
export function nextWords(n: Worded, tasks?: { done: number; total: number }): string {
  const you = waitingOnYou(n);
  if (you === 'answer a question') return 'You: answer the question.';
  if (n.ownWait === 'stuck') return 'You: end the wait, or cancel the job.';
  if (n.ownWait === 'command') return 'It goes on when its own command ends.';
  if (you) return `You: ${you}.`;
  switch (n.stage) {
    case 'queued': return n.preemptedBy ? 'It resumes from where it stopped when a lane is free.' : 'It starts when a lane is free.';
    case 'running': return tasks ? `The agent works on it: ${tasks.done} of ${tasks.total} tasks done.` : 'The agent works on it.';
    case 'waiting': return n.status === 'operator_led' ? 'A person finishes it.' : n.preemptedBy ? 'It goes back in the queue, and resumes from where it stopped.' : 'It goes on when what it waits for happens.';
    case 'pr_open': return n.pullRequest?.checks === 'failing' ? 'Fix the failed checks, or run it again.' : n.pullRequest?.checks === 'pending' ? 'It goes on to the merge once its checks pass.' : 'Merge the pull request, or yolo mode merges it.';
    case 'partly_done': return 'Merge the pull request: then the next part runs.';
    case 'done': return n.awaitsBatch ? 'Nothing: its batch run closes the issue.' : 'Nothing: it is done.';
    case 'failed': return 'Read why it failed, then run it again or close it.';
    case 'cancelled': return n.closed ? 'Nothing: the issue is closed.' : 'Nothing: it was cancelled.';
    case 'superseded': return n.dismissed ? 'Nothing: it was dismissed.' : 'Nothing: other work finished its issue.';
    case 'no_job': return 'A job starts when a source takes the issue.';
  }
}

/**
 * One piece of a tree, for its summary: its stage, whether a run again redoes a failed run, whether it waits on you, and
 * whether it is an issue closed as not planned (issue #1895).
 */
export interface Piece { stage: JobStage; redone: boolean; you: boolean; closed?: boolean }

/** A job tree in one line: "3 of 4 pieces shipped, 1 being redone, nothing waiting on you." */
export function summaryWords(pieces: readonly Piece[], waiting: number): string {
  const count = (f: (p: Piece) => boolean) => pieces.filter(f).length;
  const shipped = count((p) => p.stage === 'done');
  const redone = count((p) => p.redone && (p.stage === 'running' || p.stage === 'queued'));
  const going = count((p) => !p.redone && !p.you && ['queued', 'running', 'pr_open', 'partly_done', 'waiting'].includes(p.stage));
  const failed = count((p) => p.stage === 'failed');
  const closed = count((p) => p.closed === true);
  const bits = [`${shipped} of ${pieces.length} ${pieces.length === 1 ? 'piece' : 'pieces'} shipped`];
  if (going) bits.push(`${going} in progress`);
  if (redone) bits.push(`${redone} being redone`);
  if (failed) bits.push(`${failed} failed`);
  if (closed) bits.push(`${closed} closed`);
  bits.push(waiting ? `${waiting} waiting on you` : 'nothing waiting on you');
  return `${bits.join(', ')}.`;
}

/** A job's run in the chain of runs again of its issue: 1, plus each earlier failed run it redoes (a next part is no new attempt). */
export function attemptIn(job: Job, byId: ReadonlyMap<string, Job>): number {
  let n = 1;
  for (let prev = job.rerunOf, seen = new Set([job.id]); prev && byId.get(prev)?.status === 'failed' && !seen.has(prev); prev = byId.get(prev)!.rerunOf) { seen.add(prev); n++; }
  return n;
}

/**
 * A tree in one line: its pieces are its issues (its jobs, when it has none); a piece is being redone when its newest
 * job runs a failed one again. What waits on you: its questions and hand-offs, and its jobs waiting on a plan or report.
 */
export function treeSummary(t: Omit<JobTree, 'summary'>, nodes: ReadonlyMap<string, JobGraphNode>, edges: readonly JobGraphEdge[], newestOf: ReadonlyMap<string, Job>, byId: ReadonlyMap<string, Job>): string {
  const members = t.nodes.map((id) => nodes.get(id)!);
  const issues = members.filter((n) => n.kind === 'issue');
  const redone = (job: Job | undefined) => job?.rerunOf !== undefined && byId.get(job.rerunOf)?.status === 'failed';
  const pieces: Piece[] = (issues.length ? issues : members.filter((n) => n.kind === 'job'))
    .map((n) => ({ stage: n.stage, redone: redone(n.kind === 'issue' ? newestOf.get(n.id) : byId.get(n.jobId!)), you: n.waitsOnYou === true, closed: n.closed === true }));
  const asking = new Set(edges.filter((e) => e.kind === 'asks' || e.kind === 'hands_off').map((e) => e.from));
  const waiting = members.filter((n) => n.waitsOnYou && n.kind !== 'issue' && !asking.has(n.id)).length;
  return summaryWords(pieces, waiting);
}

/**
 * Each node's words (issue #935): an issue says what its newest job says, while it is at that job's stage (issue #1036);
 * a job that ended well says its failed processes after (issue #2722 part 7).
 */
export function wordNodes(nodes: ReadonlyMap<string, JobGraphNode>, newestOf: ReadonlyMap<string, Job>): void {
  for (const n of nodes.values()) {
    const newest = n.kind === 'issue' ? nodes.get(`job:${newestOf.get(n.id)?.id}`) : undefined;
    const worded = newest?.stage === n.stage && !n.awaitsBatch ? newest : n;
    n.stageText = stageWords(worded) + (worded.failedProcesses ? `, but ${worded.failedProcesses.said}` : '');
    if (waitsOnYou(worded)) n.waitsOnYou = true;
  }
}
