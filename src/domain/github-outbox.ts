// The GitHub outbox (issue #1238, design.md "GitHub outbox"): one row per GitHub change a person's action asked for, kept in
// the user's store with the action's own local change, and sent after the answer, in batches. Its rows, its port, and the
// coalescing of the rows due for one issue into the fewest calls (pure).
import type { ActingPerson } from './failures.ts';
import type { GiveBackAct, GiveBackInput } from './give-back.ts';
import type { IntakeActionKind } from './intake.ts';
import type { PullRequestAct } from './pull-requests.ts';

/**
 * One change on one issue. `read_comments` is Approve's read of the assignee's comments, kept in the approved snapshot.
 * `comment` posts one comment: a hand-off's resolution (issue #551), a Decline's note (issue #1710). `close_not_planned`
 * closes the issue as not planned: a person's Decline with the choice Close (issue #1710). `pull_request` is a person's Merge now or Close PR on
 * job `jobId`'s open pull request (issue #677, part 3): the source follows it with the act, and records it by `acting`.
 * `give_back` is a person's act that gives ended job `jobId`'s item back: Run again or Rework (part 4), the new job told
 * Rework's `notes`; or Failures' Retry, a hand-off's Continue or I fixed it, Push it or Tend again (part 5), run by its own
 * service, which `target` (the failure record, hand-off or job the act names) and the person's `input` name, so the sync
 * loop checks and runs it again after a restart. `at`: when the act was kept, so a send again finds a job made since.
 */
export type OutboxChange =
  | { op: 'add_labels'; labels: string[] }
  | { op: 'remove_labels'; labels: string[] }
  | { op: 'add_assignees'; assignees: string[] }
  | { op: 'read_comments' }
  | { op: 'comment'; body: string }
  | { op: 'close_not_planned' }
  | { op: 'pull_request'; act: PullRequestAct; jobId: string; acting: ActingPerson }
  | { op: 'give_back'; act: OutboxGiveBack; jobId: string; acting?: ActingPerson; notes?: string; target?: string; input?: GiveBackInput; at?: string };

/** The give-backs kept as outbox rows: Run again and Rework (part 4), and the acts their own services run (part 5). */
export type OutboxGiveBack = GiveBackAct;

/** What a give-back row names besides its act, its job and who acted. */
export type OutboxGiveBackMore = Pick<Extract<OutboxChange, { op: 'give_back' }>, 'notes' | 'target' | 'input' | 'at'>;

/**
 * The act that asked for a row: a person's intake action, `resolve`, a person's resolution of a hand-off told to its item,
 * a person's Merge now or Close PR (part 3), a person's act that gives an ended job's item back (parts 4 and 5), or
 * `mirror`, the label mirror's change of a blocked item's end labels to its state (issue #1891), or `follow`, the end labels
 * of the state a followed pull request's end moves its item to (issue #1892 part 14).
 */
export type OutboxAct = IntakeActionKind | 'resolve' | PullRequestAct | OutboxGiveBack | 'mirror' | 'follow';

const NOT_INTAKE: readonly OutboxAct[] = ['resolve', 'merge', 'close', 'rerun', 'rework', 'retry', 'continue', 'fixed', 'push', 'tend', 'mirror', 'follow'];

/** An act whose rows are not an intake item's write: the item shows no marker for them. */
export const notIntake = (act: OutboxAct): act is 'resolve' | PullRequestAct | OutboxGiveBack | 'mirror' | 'follow' => NOT_INTAKE.includes(act);

/**
 * The sync loop's part of a flush: it sends a Merge now or Close PR row (part 3) or a give-back row (parts 4 and 5), and
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
  /**
   * Claims the source's rows due at `at` — pending ones, and `sending` ones whose claim ended (a stopped or killed hopper
   * left them) — for a send, until `until`, in one statement: of two hoppers on one database one gets each row (issue
   * #1959). Answers them `sending`, oldest first. With `only`, only the rows of that item and act (issue #1892 part 14).
   */
  claim(source: string, at: string, until: string, only?: { key: string; act: OutboxAct }): OutboxRow[];
  update(ids: number[], patch: OutboxPatch): void;
  /** The source's rows of one item, sent ones too (until pruned), oldest first. */
  of(source: string, key: string): OutboxRow[];
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
 * add call and one remove call; the assignees in one call; Approve's comment reads in one; the same comment once; the
 * close once; a job's same Merge now, Close PR or give-back once. The newest row of a label says what it ends as. Removes
 * go first, then adds, assignments, the read, the comments, the close and the job's acts.
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
    const closes: number[] = [];
    const comments = new Map<string, number[]>();
    const acts = new Map<string, { change: OutboxChange; rows: number[] }>();
    const cancelled: number[] = [];
    for (const r of issueRows) {
      const c = r.change;
      if (c.op === 'add_assignees') for (const a of c.assignees) assignees.set(a, [...(assignees.get(a) ?? []), r.id]);
      else if (c.op === 'read_comments') reads.push(r.id);
      else if (c.op === 'close_not_planned') closes.push(r.id);
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
    if (closes.length) calls.push({ change: { op: 'close_not_planned' }, rows: closes });
    calls.push(...acts.values());
    // A row whose every label cancelled sends nothing; one with a label left is sent with that call.
    const inCalls = new Set(calls.flatMap((c) => c.rows));
    return { repo, key, calls, cancelled: [...new Set(cancelled)].filter((id) => !inCalls.has(id)) };
  });
}

/**
 * How long a send holds the rows it claimed (issue #1959), renewed before each call: no other hopper sends them meanwhile.
 * A row a stopped or killed hopper left `sending` is sent again once its claim ends. Longer than a call's longest wait at
 * the rate limiter (`SOURCE_DEFER_AFTER_MS`, 60 s).
 */
export const OUTBOX_CLAIM_MS = 2 * 60_000;

/** How many attempts a row gets before it is `failed` and waits for a person's Retry. */
export const OUTBOX_ATTEMPTS = 5;

/** The wait after the `attempts`th failed attempt: 5 s, doubled each time, at most 5 minutes. */
export const outboxBackoffMs = (attempts: number): number => Math.min(5_000 * 2 ** Math.max(0, attempts - 1), 5 * 60_000);

/**
 * A person's act on one job — Merge now, Close PR, a give-back — while its row is not sent (issue #1238): what its pull
 * request's card and the ended job show, as an intake item shows its write-behind. `running`, with the next `attempt` and
 * the `error` of the try before while it waits its backoff; `failed` with why, until the same act is sent again.
 */
export type JobActMarker =
  | { act: PullRequestAct | OutboxGiveBack; state: 'running'; attempt?: number; error?: string }
  | { act: PullRequestAct | OutboxGiveBack; state: 'failed'; error: string };

/** Each job's marker from its act rows not sent (pure): a failed row wins, else the oldest row on its way. */
export function jobActMarkers(rows: OutboxRow[]): Record<string, JobActMarker> {
  const out: Record<string, JobActMarker> = {};
  for (const r of rows) {
    const c = r.change;
    if ((c.op !== 'pull_request' && c.op !== 'give_back') || r.state === 'sent') continue;
    if (out[c.jobId]?.state === 'failed') continue;
    if (r.state === 'failed') out[c.jobId] = { act: c.act, state: 'failed', error: r.lastError ?? 'failed' };
    else if (!out[c.jobId]) out[c.jobId] = r.lastError !== undefined ? { act: c.act, state: 'running', attempt: r.attempts + 1, error: r.lastError } : { act: c.act, state: 'running' };
  }
  return out;
}
