// The GitHub outbox of one source (issue #1238, design.md "GitHub outbox"): the GitHub changes a person's intake action
// asks for — Approve's comment read and `hopper:done`, Assign to me's assignment, Release claim's and Take off the
// backburner's labels, Take into Intake's label and assignment — kept as rows in the user's store, in the transaction of
// the action's own local change, and sent after the answer by `flush`: the rows due, coalesced per issue
// (`coalesce`, src/domain/github-outbox.ts), one call per change left. A row's event is recorded once GitHub took it. A
// failed call waits its backoff and is tried again; a permanent refusal, or the last attempt, leaves it `failed` until the
// same act is sent again. A discover never waits for the outbox: it lists what GitHub says, and an item with rows not sent
// is not taken (`held`), so a sync never overtakes or undoes the action. The item shows its rows (`writeBehind`): `running`,
// with the `attempt` and `error` of the try before while a failed call waits its backoff (issue #1194 part 8). The detail
// says how many rows are not sent (`writeBehindPending`) and when the last went through (`lastWriteBehindAt`); each row's
// act is timed for `afterAnswer` (`after-answer-timings.ts`): its wait in the outbox apart from its call.
import type { IntakeActionKind, IntakeOutcome, IntakeWriteBehind } from '../../domain/intake.ts';
import type { Clock } from '../../domain/ports.ts';
import type { AfterAnswerTiming } from '../../domain/types.ts';
import { createAfterAnswerTimings } from '../after-answer-timings.ts';
import {
  OUTBOX_ATTEMPTS, coalesce, outboxBackoffMs,
  type GitHubOutboxRepository, type OutboxChange, type OutboxInput, type OutboxRow,
} from '../../domain/github-outbox.ts';
import { GitHubApiError, type GitHubApi } from './api.ts';

export type GitHubOutbox = ReturnType<typeof createGitHubOutbox>;

/** Sends one coalesced change on one issue. */
export type OutboxSend = (repo: string, key: string, change: OutboxChange) => Promise<void>;

/** How long a sent row is kept: what the item's history and a check of the table read. */
const KEEP_SENT_MS = 7 * 24 * 60 * 60_000;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface GitHubOutboxOptions {
  source: string;
  rows: GitHubOutboxRepository;
  clock: Clock;
  /** Records a row's event once GitHub took its change. */
  record?(type: string, data: Record<string, unknown>): void;
  /** A row GitHub took: what the source knows of its item follows it. */
  sent?(row: OutboxRow): void;
}

export function createGitHubOutbox(o: GitHubOutboxOptions) {
  const { rows, clock } = o;
  /** The act sent for each item and the discover it was sent in, until a later discover listed it: a second click writes nothing more. */
  const recent = new Map<string, { act: IntakeActionKind; tag: string; round: number }>();
  let round = 0;
  let recovered = false;
  let flushing: Promise<{ due: number; wrote: string[] }> | undefined;
  let lastSentAt: string | undefined;
  const timings = createAfterAnswerTimings(() => clock.now());
  const now = () => clock.now().toISOString();
  const openOf = (key: string) => rows.open(o.source).filter((r) => r.key === key);

  /** Each item's marker from its rows not sent: failed when a row failed, else running, with its next attempt while it waits its backoff. */
  const markers = (): Map<string, IntakeWriteBehind> => {
    const out = new Map<string, IntakeWriteBehind>();
    for (const r of rows.open(o.source)) {
      if (out.get(r.key)?.state === 'failed') continue;
      if (r.state === 'failed') out.set(r.key, { act: r.act, state: 'failed', error: r.lastError ?? 'failed' });
      else if (r.lastError !== undefined) out.set(r.key, { act: r.act, state: 'running', attempt: r.attempts + 1, error: r.lastError });
      else if (!out.has(r.key)) out.set(r.key, { act: r.act, state: 'running' });
    }
    return out;
  };

  /** A row's act timed: its wait in the outbox, from its row to its call, apart from the call. */
  const time = (r: OutboxRow, startedAt: number, endedAt: number): void =>
    timings.record(r.act, Math.max(0, clock.now().getTime() - Date.parse(r.createdAt) - (endedAt - startedAt)), endedAt - startedAt);

  /** Rows the same act left with an error: sent again now, from their first attempt. */
  const revive = (failed: OutboxRow[]): void => rows.update(failed.map((r) => r.id), { state: 'pending', attempts: 0, nextAt: now(), lastError: undefined });

  /** The calls' rows a failed call leaves: each waits its backoff, or is failed when GitHub refused it or it was its last attempt. Answers those failed. */
  function failed(left: OutboxRow[], e: unknown): OutboxRow[] {
    const permanent = e instanceof GitHubApiError ? e.permanent : !(e instanceof TypeError);
    const retryAt = e instanceof GitHubApiError ? e.retryAt : undefined;
    for (const r of left) {
      const attempts = r.attempts + 1;
      const last = permanent || attempts >= OUTBOX_ATTEMPTS;
      const at = retryAt ?? clock.now().getTime() + outboxBackoffMs(attempts);
      rows.update([r.id], { state: last ? 'failed' : 'pending', attempts, lastError: message(e), nextAt: new Date(at).toISOString() });
    }
    return left.filter((r) => permanent || r.attempts + 1 >= OUTBOX_ATTEMPTS);
  }

  async function sendDue(send: OutboxSend): Promise<{ due: number; wrote: string[] }> {
    if (!recovered) { rows.recover(o.source); recovered = true; }
    const due = rows.due(o.source, now());
    if (due.length === 0) return { due: 0, wrote: [] };
    rows.update(due.map((r) => r.id), { state: 'sending' });
    const byId = new Map(due.map((r) => [r.id, r]));
    const wrote = new Set<string>();
    for (const plan of coalesce(due)) {
      if (plan.cancelled.length) rows.update(plan.cancelled, { state: 'sent', sentAt: now() });
      const left = new Map<number, number>();
      for (const c of plan.calls) for (const id of c.rows) left.set(id, (left.get(id) ?? 0) + 1);
      for (const call of plan.calls) {
        const startedAt = performance.now();
        try {
          await send(plan.repo, plan.key, call.change);
        } catch (e) {
          const endedAt = performance.now();
          for (const r of failed([...left.keys()].map((id) => byId.get(id)!), e)) time(r, startedAt, endedAt);
          break;
        }
        const endedAt = performance.now();
        const done = call.rows.filter((id) => { const n = left.get(id)! - 1; if (n === 0) left.delete(id); else left.set(id, n); return n === 0; });
        rows.tx(() => {
          rows.update(done, { state: 'sent', sentAt: now(), lastError: undefined });
          for (const id of done) { const ev = byId.get(id)!.event; if (ev) o.record?.(ev.type, ev.data); }
        });
        for (const id of done) { const r = byId.get(id)!; recent.set(r.key, { act: r.act, tag: r.tag, round }); time(r, startedAt, endedAt); o.sent?.(r); }
        if (done.length) lastSentAt = now();
        wrote.add(plan.repo);
      }
    }
    rows.prune(new Date(clock.now().getTime() - KEEP_SENT_MS).toISOString());
    return { due: due.length, wrote: [...wrote] };
  }

  return {
    /** True: this act, with this tag, has rows on their way, or went through since a discover last listed the item: nothing more to do. */
    sent(act: IntakeActionKind, key: string, tag = ''): boolean {
      if (openOf(key).some((r) => r.act === act && r.tag === tag && r.lastError === undefined)) return true;
      const r = recent.get(key);
      return r?.act === act && r.tag === tag;
    },
    /**
     * Keeps `changes` for the item, with `local` — the action's own local change — in the same transaction. The same act's
     * rows that failed are sent again instead, from their first attempt.
     */
    queue(act: IntakeActionKind, key: string, repo: string, changes: Pick<OutboxInput, 'change' | 'event' | 'createdBy'>[], opts: { tag?: string; local?: () => void } = {}): void {
      const tag = opts.tag ?? '';
      rows.tx(() => {
        opts.local?.();
        const again = openOf(key).filter((r) => r.act === act && r.tag === tag && r.lastError !== undefined);
        if (again.length) revive(again);
        else rows.add(changes.map((c) => ({ ...c, source: o.source, act, key, repo, tag })), now());
        // An act with nothing for GitHub (an Approve that reads no comments) is done at once.
        if (!again.length && changes.length === 0) recent.set(key, { act, tag, round });
      });
    },
    /** Sends the rows due, one batch, coalesced; answers how many were due and the repositories it wrote to. A flush under way is joined, never doubled. */
    flush(send: OutboxSend): Promise<{ due: number; wrote: string[] }> {
      flushing ??= sendDue(send).finally(() => { flushing = undefined; });
      return flushing;
    },
    /** An item with rows not sent: a discover does not take it until they are. */
    held: (key: string): boolean => openOf(key).some((r) => r.state !== 'failed'),
    /** At a discover's start: its round. Never waits for the outbox. */
    begin: (): number => ++round,
    /** At a discover's end: what it listed holds the acts sent before it began. */
    listed(r: number): void { for (const [key, x] of recent) if (x.round < r) recent.delete(key); },
    /** The item's marker, while its rows are not sent. */
    of: (key: string): IntakeWriteBehind | undefined => markers().get(key),
    /** Each item with its marker, when it has one. */
    on(xs: IntakeOutcome[]): IntakeOutcome[] {
      const m = markers();
      return xs.map((x) => { const f = m.get(x.key); return f ? { ...x, writeBehind: f } : { ...x }; });
    },
    detail(): Record<string, unknown> {
      const pending = rows.open(o.source).filter((r) => r.state !== 'failed').length;
      const errors = [...markers()].flatMap(([key, f]) => (f.state === 'failed' ? [[key, `${f.act}: ${f.error}`] as const] : []));
      return {
        ...(pending ? { writeBehindPending: pending } : {}),
        ...(lastSentAt ? { lastWriteBehindAt: lastSentAt } : {}),
        ...(errors.length ? { writeBehindErrors: Object.fromEntries(errors) } : {}),
      };
    },
    /** Each act's rows, timed: their wait in the outbox apart from their call. */
    timings: (): AfterAnswerTiming[] => timings.summary(),
  };
}

/** Each coalesced change on GitHub; Approve's comment read through `readComments`. */
export function outboxSend(api: Pick<GitHubApi, 'addLabels' | 'removeLabels' | 'addAssignees'>, readComments: (repo: string, key: string) => Promise<void>): OutboxSend {
  return async (repo, key, change) => {
    const n = Number(key.slice(key.lastIndexOf('/') + 1));
    if (change.op === 'add_labels') await api.addLabels(repo, n, change.labels);
    else if (change.op === 'remove_labels') await api.removeLabels(repo, n, change.labels);
    else if (change.op === 'add_assignees') await api.addAssignees(repo, n, change.assignees);
    else await readComments(repo, key);
  };
}

/** The outbox kept in memory: a source with no store (tests). */
export function memoryGitHubOutbox(): GitHubOutboxRepository {
  const kept = new Map<number, OutboxRow>();
  let next = 1;
  const list = (f: (r: OutboxRow) => boolean) => [...kept.values()].filter(f).sort((a, b) => a.id - b.id).map((r) => structuredClone(r));
  return {
    tx: (fn) => fn(),
    add(input, at) { for (const r of input) { const id = next++; kept.set(id, { ...structuredClone(r), id, state: 'pending', attempts: 0, nextAt: at, createdAt: at }); } },
    open: (source) => list((r) => r.source === source && r.state !== 'sent'),
    due: (source, at) => list((r) => r.source === source && r.state === 'pending' && r.nextAt <= at),
    update(ids, patch) {
      for (const id of ids) {
        const row = kept.get(id);
        if (!row) continue;
        const n: OutboxRow = { ...row, ...patch };
        if ('lastError' in patch && patch.lastError === undefined) delete n.lastError;
        kept.set(id, n);
      }
    },
    recover(source) { let n = 0; for (const r of kept.values()) if (r.source === source && r.state === 'sending') { r.state = 'pending'; n++; } return n; },
    prune(before) { let n = 0; for (const [id, r] of kept) if (r.state === 'sent' && (r.sentAt ?? '') < before) { kept.delete(id); n++; } return n; },
  };
}
