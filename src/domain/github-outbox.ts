// The GitHub outbox (issue #1238, design.md "GitHub outbox"): one row per GitHub change a person's action asked for, kept in
// the user's store with the action's own local change, and sent after the answer, in batches. Its rows, its port, and the
// coalescing of the rows due for one issue into the fewest calls (pure).
import type { ActingPerson } from './failures.ts';
import type { GiveBackAct } from './give-back.ts';
import type { IntakeActionKind } from './intake.ts';
import type { PullRequestAct } from './pull-requests.ts';

/**
 * One change on one issue. `read_comments` is Approve's read of the assignee's comments, kept in the approved snapshot.
 * `comment` posts one comment: a hand-off's resolution (issue #551). `pull_request` is a person's Merge now or Close PR on
 * job `jobId`'s open pull request (issue #677, part 3): the source follows it with the act, and records it by `acting`.
 * `give_back` is a person's Run again or Rework of ended job `jobId` (part 4): the source gives its item back, and the new
 * job follows, told Rework's `notes`.
 */
export type OutboxChange =
  | { op: 'add_labels'; labels: string[] }
  | { op: 'remove_labels'; labels: string[] }
  | { op: 'add_assignees'; assignees: string[] }
  | { op: 'read_comments' }
  | { op: 'comment'; body: string }
  | { op: 'pull_request'; act: PullRequestAct; jobId: string; acting: ActingPerson }
  | { op: 'give_back'; act: OutboxGiveBack; jobId: string; acting?: ActingPerson; notes?: string };

/** The give-backs kept as outbox rows (part 4): Run again and Rework. */
export type OutboxGiveBack = Extract<GiveBackAct, 'rerun' | 'rework'>;

/**
 * The act that asked for a row: a person's intake action, `resolve`, a person's resolution of a hand-off told to its item,
 * a person's Merge now or Close PR (part 3), or a person's Run again or Rework (part 4).
 */
export type OutboxAct = IntakeActionKind | 'resolve' | PullRequestAct | OutboxGiveBack;

const NOT_INTAKE: readonly OutboxAct[] = ['resolve', 'merge', 'close', 'rerun', 'rework'];

/** An act whose rows are not an intake item's write: the item shows no marker for them. */
export const notIntake = (act: OutboxAct): act is 'resolve' | PullRequestAct | OutboxGiveBack => NOT_INTAKE.includes(act);

/**
 * The sync loop's part of a flush: it sends a Merge now or Close PR row (part 3) or a Run again or Rework row (part 4), and
 * says one failed for good.
 */
export interface OutboxActs {
  pullRequest(change: Extract<OutboxChange, { op: 'pull_request' }>): Promise<void>;
  gaveUp(change: Extract<OutboxChange, { op: 'pull_request' }>, error: string): void;
  giveBack(change: Extract<OutboxChange, { op: 'give_back' }>): Promise<void>;
  giveBackFailed(change: Extract<OutboxChange, { op: 'give_back' }>, error: string): void;
}

export type OutboxState = 'pending' | 'sending' | 'sent' | 'failed';

/** The event recorded once GitHub took the row's change, so no event says a write that never happened. */
export interface OutboxEvent { type: string; data: Record<string, unknown> }

export interface OutboxInput {
  /** The job source that sends it. */
  source: string;
  repo: string;
  /** The issue's URL: the item's key. */
  key: string;
  /** The person's act that asked for it, and its tag (Approve's hash; a resolution's job and time). */
  act: OutboxAct;
  tag: string;
  change: OutboxChange;
  event?: OutboxEvent;
  /** Who acted, when the act names them. */
  createdBy?: string;
}

export interface OutboxRow extends OutboxInput {
  id: number;
  state: OutboxState;
  attempts: number;
  lastError?: string;
  /** When it is sent next: a failed attempt waits its backoff. */
  nextAt: string;
  createdAt: string;
  sentAt?: string;
}

export type OutboxPatch = Partial<Pick<OutboxRow, 'state' | 'attempts' | 'lastError' | 'nextAt' | 'sentAt'>>;

export interface GitHubOutboxRepository {
  /** Run fn in one transaction with the store's other writes: an action keeps its local change and its rows together. */
  tx<T>(fn: () => T): T;
  add(rows: OutboxInput[], at: string): void;
  /** The source's rows not sent: pending, sending and failed, oldest first. */
  open(source: string): OutboxRow[];
  /** The source's pending rows due at `at`, oldest first. */
  due(source: string, at: string): OutboxRow[];
  update(ids: number[], patch: OutboxPatch): void;
  /** The source's rows of one item, sent ones too (until pruned), oldest first. */
  of(source: string, key: string): OutboxRow[];
  /** Rows a stopped process left `sending` go back to `pending`: their calls are sent again (labels and assignees are idempotent). */
  recover(source: string): number;
  /** Sent rows sent before `before` go. */
  prune(before: string): number;
}

/** One call the flusher makes for one issue, and the rows it sends. */
export interface OutboxCall {
  change: OutboxChange;
  rows: number[];
}

/** What a batch sends for one issue: its calls, in order, and the rows that cancel out and send nothing. */
export interface OutboxPlan {
  repo: string;
  key: string;
  calls: OutboxCall[];
  cancelled: number[];
}

/**
 * The rows due for one issue, coalesced: an add and a remove of the same label cancel out; the labels left go in one
 * add call and one remove call; the assignees in one call; Approve's comment reads in one; the same comment once; a job's
 * same Merge now, Close PR, Run again or Rework once. The newest row of a label says what it ends as. Removes go first,
 * then adds, assignments, the read, the comments and the job's acts.
 */
export function coalesce(rows: OutboxRow[]): OutboxPlan[] {
  const byIssue = new Map<string, OutboxRow[]>();
  for (const r of [...rows].sort((a, b) => a.id - b.id)) byIssue.set(`${r.repo}\n${r.key}`, [...(byIssue.get(`${r.repo}\n${r.key}`) ?? []), r]);
  return [...byIssue.values()].map((issueRows) => {
    const { repo, key } = issueRows[0]!;
    /** Each label's pending ops, in order: what is left after opposite ops cancel. */
    const labels = new Map<string, { op: 'add' | 'remove'; row: number }[]>();
    const assignees = new Map<string, number[]>();
    const reads: number[] = [];
    const comments = new Map<string, number[]>();
    const acts = new Map<string, { change: OutboxChange; rows: number[] }>();
    const cancelled: number[] = [];
    for (const r of issueRows) {
      const c = r.change;
      if (c.op === 'add_assignees') for (const a of c.assignees) assignees.set(a, [...(assignees.get(a) ?? []), r.id]);
      else if (c.op === 'read_comments') reads.push(r.id);
      else if (c.op === 'comment') comments.set(c.body, [...(comments.get(c.body) ?? []), r.id]);
      else if (c.op === 'pull_request' || c.op === 'give_back') { const k = `${c.jobId}\n${c.act}`; acts.set(k, { change: acts.get(k)?.change ?? c, rows: [...(acts.get(k)?.rows ?? []), r.id] }); }
      else {
        const op = c.op === 'add_labels' ? 'add' : 'remove';
        for (const l of c.labels) {
          const ops = labels.get(l) ?? [];
          const last = ops[ops.length - 1];
          if (last && last.op !== op) { ops.pop(); cancelled.push(last.row, r.id); } else ops.push({ op, row: r.id });
          labels.set(l, ops);
        }
      }
    }
    const left = (op: 'add' | 'remove') => [...labels].filter(([, ops]) => ops.length > 0 && ops[ops.length - 1]!.op === op);
    const rowsOf = (ops: { row: number }[][]) => [...new Set(ops.flat().map((o) => o.row))];
    const calls: OutboxCall[] = [];
    const removes = left('remove');
    if (removes.length) calls.push({ change: { op: 'remove_labels', labels: removes.map(([l]) => l) }, rows: rowsOf(removes.map(([, o]) => o)) });
    const adds = left('add');
    if (adds.length) calls.push({ change: { op: 'add_labels', labels: adds.map(([l]) => l) }, rows: rowsOf(adds.map(([, o]) => o)) });
    if (assignees.size) calls.push({ change: { op: 'add_assignees', assignees: [...assignees.keys()] }, rows: [...new Set([...assignees.values()].flat())] });
    if (reads.length) calls.push({ change: { op: 'read_comments' }, rows: reads });
    for (const [body, ids] of comments) calls.push({ change: { op: 'comment', body }, rows: ids });
    calls.push(...acts.values());
    // A row whose every label cancelled sends nothing; one with a label left is sent with that call.
    const inCalls = new Set(calls.flatMap((c) => c.rows));
    return { repo, key, calls, cancelled: [...new Set(cancelled)].filter((id) => !inCalls.has(id)) };
  });
}

/** How many attempts a row gets before it is `failed` and waits for a person's Retry. */
export const OUTBOX_ATTEMPTS = 5;

/** The wait after the `attempts`th failed attempt: 5 s, doubled each time, at most 5 minutes. */
export const outboxBackoffMs = (attempts: number): number => Math.min(5_000 * 2 ** Math.max(0, attempts - 1), 5 * 60_000);
