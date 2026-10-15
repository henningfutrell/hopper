// The write-behind of a person's intake action (issue #1194): the GitHub work it leaves after its answer — Approve's
// comments and `hopper:done`, Assign to me's assignment, Release claim's and Take off the backburner's labels, Take into
// Intake's label and assignment. The action records what it can and answers; its write-behind runs after, not awaited,
// and the item shows it (`IntakeOutcome.writeBehind`) while it runs and once it failed. The next discover waits for every
// write-behind under way, so it lists what they wrote. One that failed stays shown, and in the source's
// `detail.writeBehindErrors`, until the same act sent again goes through. The same act sent again (a second click, another
// tab) before a discover listed the item again writes nothing more, unless it failed. Take into Intake's shows on its
// untracked pull request's row too (`census.detail`), the issue it takes in being in no Intake list yet.
import type { IntakeActionKind, IntakeOutcome, IntakeWriteBehind } from '../../domain/intake.ts';

export type WriteBehind = ReturnType<typeof createWriteBehind>;

export function createWriteBehind() {
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
      const mine: IntakeWriteBehind = { act, state: 'running' };
      state.set(key, mine);
      const ends = Promise.resolve().then(work).then(
        () => { if (state.get(key) === mine) state.delete(key); },
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
      return failed.length ? { writeBehindErrors: Object.fromEntries(failed) } : {};
    },
  };
}
