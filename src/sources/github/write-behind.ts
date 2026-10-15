// The write-behind of a person's intake action (issue #1194): the GitHub work it leaves after its answer — Approve's
// comments and `hopper:done`, Assign to me's assignment, Release claim's and Take off the backburner's labels, Take into
// Intake's label and assignment. The action records what it can and answers; its write-behind runs after, not awaited,
// and the item shows it (`IntakeOutcome.writeBehind`) while it runs and once it failed. The next discover waits for every
// write-behind under way, so it lists what they wrote. One that failed stays shown, and in the source's
// `detail.writeBehindErrors`, until the same act sent again goes through. The same act sent again (a second click, another
// tab) before a discover listed the item again writes nothing more, unless it failed. Take into Intake's shows on its
// untracked pull request's row too (`census.detail`), the issue it takes in being in no Intake list yet.
// A write GitHub refused for now (a 5xx, out of reach) is tried again after each of `retryMs` (part 8), shown running with
// its try and why meanwhile; one GitHub refuses for good (`permanent`), or rate-limited past the next try, fails at once.
// The detail says how many run (`writeBehindPending`) and when the last went through (`lastWriteBehindAt`); each act's
// write is timed, its tries in its run, for `afterAnswer` (`after-answer-timings.ts`).
import type { IntakeActionKind, IntakeOutcome, IntakeWriteBehind } from '../../domain/intake.ts';
import type { AfterAnswerTiming } from '../../domain/types.ts';
import { createAfterAnswerTimings } from '../after-answer-timings.ts';
import { GitHubApiError } from './api.ts';

export type WriteBehind = ReturnType<typeof createWriteBehind>;

/** The waits before a write's second and third try: GitHub's 5xx and a dropped connection are mostly over in seconds. */
export const RETRY_MS: readonly number[] = [1000, 4000];

export interface WriteBehindOptions {
  now?: () => Date;
  retryMs?: readonly number[];
}

/** False: GitHub refused it for good, or not before `at` + `waitMs`; trying again then gets the same answer. */
const triedAgain = (e: unknown, now: number, waitMs: number | undefined): boolean =>
  waitMs !== undefined && !(e instanceof GitHubApiError && (e.permanent || (e.retryAt ?? 0) > now + waitMs));

export function createWriteBehind(o: WriteBehindOptions = {}) {
  const now = o.now ?? (() => new Date());
  const retryMs = o.retryMs ?? RETRY_MS;
  const timings = createAfterAnswerTimings(now);
  let lastAt: string | undefined;
  /** Every write-behind under way, until it ends. */
  const under = new Set<Promise<void>>();
  /** Each item's write-behind, while it runs or once it failed. */
  const state = new Map<string, IntakeWriteBehind>();
  /** The act sent for each item, its tag (Approve's hash) and the discover it was sent in, until a later discover listed it. */
  const recent = new Map<string, { act: IntakeActionKind; tag: string; round: number }>();
  let round = 0;

  return {
    /** True: this act, with this tag, was sent since a discover last listed the item, and did not fail: nothing more to do. */
    sent(act: IntakeActionKind, key: string, tag = ''): boolean {
      const r = recent.get(key);
      return r?.act === act && r.tag === tag && state.get(key)?.state !== 'failed';
    },
    /** Runs `work` after the answer, not awaited. */
    run(act: IntakeActionKind, key: string, work: () => Promise<void>, tag = ''): void {
      recent.set(key, { act, tag, round });
      let mine: IntakeWriteBehind = { act, state: 'running' };
      state.set(key, mine);
      const queuedAt = performance.now();
      const tries = async (): Promise<void> => {
        const startedAt = performance.now();
        try {
          for (let attempt = 1; ; attempt++) {
            try { await work(); return; } catch (e) {
              const waitMs = retryMs[attempt - 1];
              if (!triedAgain(e, now().getTime(), waitMs) || state.get(key) !== mine) throw e;
              const next: IntakeWriteBehind = { act, state: 'running', attempt: attempt + 1, error: (e as Error).message };
              state.set(key, next);
              mine = next;
              await new Promise((r) => setTimeout(r, waitMs));
            }
          }
        } finally {
          timings.record(act, startedAt - queuedAt, performance.now() - startedAt);
        }
      };
      const ends = Promise.resolve().then(tries).then(
        () => { lastAt = now().toISOString(); if (state.get(key) === mine) state.delete(key); },
        (e: unknown) => { if (state.get(key) === mine) state.set(key, { act, state: 'failed', error: (e as Error).message }); },
      );
      under.add(ends);
      void ends.finally(() => under.delete(ends));
    },
    /** At a discover's start: ends when every write-behind under way ended, and answers the discover's round. */
    async begin(): Promise<number> { await Promise.allSettled([...under]); return ++round; },
    /** At a discover's end: what it listed holds the acts sent before it began. */
    listed(r: number): void { for (const [key, x] of recent) if (x.round < r) recent.delete(key); },
    /** The item's write-behind, while it runs or once it failed. */
    of(key: string): IntakeWriteBehind | undefined { const f = state.get(key); return f ? { ...f } : undefined; },
    /** The item with its write-behind, when it has one. */
    on(x: IntakeOutcome): IntakeOutcome { const f = state.get(x.key); return f ? { ...x, writeBehind: { ...f } } : { ...x }; },
    detail(): Record<string, unknown> {
      const failed = [...state].flatMap(([key, f]) => (f.state === 'failed' ? [[key, `${f.act}: ${f.error}`] as const] : []));
      const pending = [...state.values()].filter((f) => f.state === 'running').length;
      return {
        ...(pending ? { writeBehindPending: pending } : {}),
        ...(lastAt ? { lastWriteBehindAt: lastAt } : {}),
        ...(failed.length ? { writeBehindErrors: Object.fromEntries(failed) } : {}),
      };
    },
    /** Each act's write, timed: its wait to start apart from its run, every try in it. */
    timings: (): AfterAnswerTiming[] => timings.summary(),
  };
}
