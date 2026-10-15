// Waits on a pull request's checks (issue #1072 part 2, design.md "Jobs ask the hopper, not GitHub"): `pr wait` on a pull
// request the hopper follows, while its checks run, opens a watch on the job's stream (issue #613). The hopper answers it
// again from its own records — never GitHub — when what it saw of a pull request changed (`job.pull_request_seen`, a merge,
// a close) and when the job subscribes; once the checks end, or the pull request is merged or closed, the watch ends with
// its status, and a job on its own wait (HOPPER_WAITING) is woken with it. Never on a timer: the stream's sweep ends a
// watch at its deadline. Issue #1210: `pr wait --for mergeable` waits instead for the next mergeability the hopper sees.
import { randomUUID } from 'node:crypto';
import type { DomainEvent, EventType } from '../domain/types.ts';
import { prWaitOver, type KnownPullRequest, type PrWaitOver, type PullRequestStatus } from './pr-status.ts';

/** The stream types `pr wait` emits, each with its phase; the payload is the pull request's status as JSON text. */
export const GITHUB_STREAM_TYPES = {
  /** Its checks run: the status when the watch opened. */
  'github.pr_waiting': 'waiting',
  /** Its checks ended, or it was merged or closed: the status now. */
  'github.pr_settled': 'done',
} as const;

/** A `pr wait` watch says so in its body (`owner`): the skill waits never ask it again as a skill request. */
export const PR_WAIT_OWNER = 'github';

/** The events after which what the hopper knows of a pull request may have changed. */
const PR_CHANGES: readonly EventType[] = [
  'job.pull_request_seen', 'job.pull_request_followed', 'job.pull_request_merged', 'job.pull_request_closed', 'job.pull_request_abandoned',
];

interface OpenWatch { id: string; jobId: string; deadline: string; body: Record<string, string> }

/** One user's side: their job stream, their event log, and what their records know of a pull request. */
export interface PrWaitUser {
  stream: {
    open(o: { id: string; jobId: string; seconds?: number; body: Record<string, string> }): OpenWatch;
    emit(jobId: string, type: string, payload: unknown, request?: string): unknown;
    finish(jobId: string, request: string, type: string, payload: unknown): unknown;
    repo: { openWatches(jobId?: string): OpenWatch[] };
  };
  subscribe(l: (e: DomainEvent) => void): () => void;
  pullRequest(repo: string, number: number): KnownPullRequest;
  /** Ends the job's own wait with the answer, when it is on one; nothing otherwise. */
  endWait?(jobId: string, answer: string): void;
}

export interface PrWaits {
  /** A watch on the job's wait for pull request `number` of `repo` (on its checks unless `over` says): the one open already, else a new one. */
  open(userId: string, jobId: string, pr: { repo: string; number: number; status: PullRequestStatus; over?: PrWaitOver }, seconds?: number): OpenWatch | undefined;
  /** Answers again each `pr wait` watch open on the user's job (every job of theirs when none is named): settled ends it. */
  redrive(userId: string, jobId?: string): void;
}

const answerOf = (s: PullRequestStatus): string => `${JSON.stringify(s)}\n`;

/** What a watch waits for, kept in its body: `for` and `from` only on a wait on its mergeability. */
const overBody = (over: PrWaitOver | undefined): Record<string, string> => (over?.for === 'mergeable' ? { for: over.for, from: over.from } : {});
const overOf = (body: Record<string, string>): PrWaitOver =>
  body.for === 'mergeable' ? { for: 'mergeable', from: body.from as PullRequestStatus['mergeable'] } : { for: 'checks' };

export function createPrWaits(o: { user(id: string): PrWaitUser | undefined; newId?: () => string; log(line: string): void }): PrWaits {
  const newId = o.newId ?? (() => randomUUID());
  /** The users whose pull request changes are heard, by their event log's subscribe: one listener each. */
  const heard = new WeakSet<PrWaitUser['subscribe']>();
  const hear = (userId: string, u: PrWaitUser): void => {
    if (heard.has(u.subscribe)) return;
    heard.add(u.subscribe);
    u.subscribe((e) => {
      if (PR_CHANGES.includes(e.type)) waits.redrive(userId);
    });
  };

  const waits: PrWaits = {
    open(userId, jobId, pr, seconds) {
      const u = o.user(userId);
      if (!u) return undefined;
      hear(userId, u);
      const body: Record<string, string> = { owner: PR_WAIT_OWNER, repo: pr.repo.toLowerCase(), number: String(pr.number), ...overBody(pr.over) };
      const had = u.stream.repo.openWatches(jobId).find((w) => w.body.owner === PR_WAIT_OWNER && w.body.repo === body.repo && w.body.number === body.number
        && w.body.for === body.for && w.body.from === body.from);
      if (had) return had;
      const w = u.stream.open({ id: newId(), jobId, body, ...(seconds !== undefined ? { seconds } : {}) });
      u.stream.emit(jobId, 'github.pr_waiting', answerOf(pr.status), w.id);
      return w;
    },

    redrive(userId, jobId) {
      const u = o.user(userId);
      if (!u) return;
      hear(userId, u);
      for (const w of u.stream.repo.openWatches(jobId)) {
        if (w.body.owner !== PR_WAIT_OWNER || w.body.repo === undefined) continue;
        try {
          const { known } = u.pullRequest(w.body.repo, Number(w.body.number));
          if (!known || !prWaitOver(known, overOf(w.body))) continue;
          const answer = answerOf(known);
          if (u.stream.finish(w.jobId, w.id, 'github.pr_settled', answer)) u.endWait?.(w.jobId, answer);
        } catch (e) {
          o.log(`hopper: GitHub proxy: answering the wait ${w.id} again failed: ${(e as Error).message}`);
        }
      }
    },
  };
  return waits;
}
