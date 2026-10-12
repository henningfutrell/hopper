// The job graph and a job's parts list in plain words (issue #935, design.md "The job graph"): where a node stands, in
// human terms — Plan, Building it (attempt 2 of 3), Ready for review, Merged, Waiting on you: approve the plan — with no
// pull request number in it; whether it waits on the person; what comes next; and a job tree summed up in one line.
// Pure: the graph and the parts list call it with what they already read.
import type { JobGraphPullRequest, JobStage } from './job-graph.ts';
import type { JobStatus } from './types.ts';

/** What the words of a node are made from: its kind and stage, and for a job, its status, phase, attempt and pull request. */
export interface Worded {
  kind: 'job' | 'issue' | 'pull_request' | 'question' | 'handoff';
  stage: JobStage;
  status?: JobStatus;
  /** `proposal` or `research`: a review section's job; absent, the work itself. */
  phase?: string;
  /** Its run in the chain of runs again of its issue (1 the first), and how many the failure settings allow. */
  attempt?: number;
  attempts?: number;
  pullRequest?: JobGraphPullRequest;
}

const WAITING: Partial<Record<JobStatus, string>> = { operator_led: 'A person works on it', parked: 'Parked', waiting_on: 'Waiting on the outside world' };

/** What a person waits to be asked for: a plan to approve, a report to accept, a question to answer. */
function waitingOnYou(n: Worded): string | undefined {
  if (n.kind === 'question') return 'answer it';
  if (n.kind === 'handoff') return 'take it over';
  if (n.status !== 'waiting_answer') return undefined;
  if (n.phase === 'proposal') return 'approve the plan';
  if (n.phase === 'research') return 'accept the research';
  return 'answer a question';
}

/** True when the node waits on the person: a question, a hand-off, a plan or a report to read. */
export const waitsOnYou = (n: Worded): boolean => waitingOnYou(n) !== undefined;

/** A pull request's stage, in words: what a reviewer sees first. */
function pullRequestWords(pr: JobGraphPullRequest): string {
  if (pr.state === 'merged') return 'Merged';
  if (pr.state === 'closed') return 'Closed without a merge';
  if (pr.state === 'abandoned') return 'Dropped';
  if (pr.state === 'unknown') return 'Not followed yet';
  if (pr.draft) return 'Draft';
  if (pr.conflicting) return 'Has merge conflicts';
  if (pr.checks === 'failing') return 'Checks failed';
  return 'Ready for review';
}

/** Where a node stands, in human terms. */
export function stageWords(n: Worded): string {
  const you = waitingOnYou(n);
  if (you) return `Waiting on you: ${you}`;
  if (n.kind === 'pull_request' && n.pullRequest) return pullRequestWords(n.pullRequest);
  switch (n.stage) {
    case 'queued': return 'Queued';
    case 'running': {
      if (n.phase === 'proposal') return 'Plan';
      if (n.phase === 'research') return 'Research';
      return n.attempt && n.attempt > 1 ? `Building it (attempt ${n.attempt}${n.attempts ? ` of ${n.attempts}` : ''})` : 'Building it';
    }
    case 'waiting': return (n.status && WAITING[n.status]) ?? 'Waiting';
    case 'pr_open': return n.pullRequest ? pullRequestWords(n.pullRequest) : 'Ready for review';
    case 'partly_done': return 'Part shipped: the rest runs after the merge';
    case 'done': return n.pullRequest?.state === 'merged' ? 'Merged' : 'Done';
    case 'failed': return 'Failed';
    case 'cancelled': return 'Cancelled';
    case 'no_job': return 'Not started';
  }
}

/** What comes next for a job, and who does it: the person, the agent, or nobody. */
export function nextWords(n: Worded, tasks?: { done: number; total: number }): string {
  const you = waitingOnYou(n);
  if (you === 'answer a question') return 'You: answer the question.';
  if (you) return `You: ${you}.`;
  switch (n.stage) {
    case 'queued': return 'It starts when a lane is free.';
    case 'running': return tasks ? `The agent works on it: ${tasks.done} of ${tasks.total} tasks done.` : 'The agent works on it.';
    case 'waiting': return n.status === 'operator_led' ? 'A person finishes it.' : 'It goes on when what it waits for happens.';
    case 'pr_open': return n.pullRequest?.checks === 'failing' ? 'Fix the failed checks, or run it again.' : 'Review and merge the pull request.';
    case 'partly_done': return 'Merge the pull request: then the next part runs.';
    case 'done': return 'Nothing: it is done.';
    case 'failed': return 'Read why it failed, then run it again or close it.';
    case 'cancelled': return 'Nothing: it was cancelled.';
    case 'no_job': return 'A job starts when a source takes the issue.';
  }
}

/** One piece of a tree, for its summary: its stage, whether a run again redoes a failed run, whether it waits on you. */
export interface Piece { stage: JobStage; redone: boolean; you: boolean }

/** A job tree in one line: "3 of 4 pieces shipped, 1 being redone, nothing waiting on you." */
export function summaryWords(pieces: readonly Piece[], waiting: number): string {
  const count = (f: (p: Piece) => boolean) => pieces.filter(f).length;
  const shipped = count((p) => p.stage === 'done');
  const redone = count((p) => p.redone && (p.stage === 'running' || p.stage === 'queued'));
  const going = count((p) => !p.redone && !p.you && ['queued', 'running', 'pr_open', 'partly_done', 'waiting'].includes(p.stage));
  const failed = count((p) => p.stage === 'failed');
  const bits = [`${shipped} of ${pieces.length} ${pieces.length === 1 ? 'piece' : 'pieces'} shipped`];
  if (going) bits.push(`${going} in progress`);
  if (redone) bits.push(`${redone} being redone`);
  if (failed) bits.push(`${failed} failed`);
  bits.push(waiting ? `${waiting} waiting on you` : 'nothing waiting on you');
  return `${bits.join(', ')}.`;
}
