// A person's act that gives an ended job's item back, answered before its source gives it back (issue #1194, design.md
// "Actions answer at once"): `SourceRegistry.giveBack` and `SourceRegistry.afterAnswer`.
import type { ActingPerson } from './types.ts';

/**
 * The acts that give an item back after their answer: Run again, Rework, Failures' Retry, a hand-off's Continue and
 * I fixed it, Push it, Tend again.
 */
export const GIVE_BACK_ACTS = ['rerun', 'rework', 'retry', 'continue', 'fixed', 'push', 'tend'] as const;
export type GiveBackAct = typeof GIVE_BACK_ACTS[number];

/** A person's act, answered: its give-back runs, or why it is refused now. */
export type GiveBackAnswer =
  | { ok: true; jobId: string; giveBack: GiveBackAct }
  | { ok: false; reason: 'not_found' | 'conflict'; message: string };

/** How a give-back that ran after its answer ended. */
export type GiveBackRun = { ok: true } | { ok: false; message: string };

/** A person's act checked now: why it is refused, or the ended job and the work that runs after the answer. */
export type GiveBackChecked =
  | { ok: true; jobId: string; run: () => Promise<GiveBackRun> }
  | { ok: false; reason: 'not_found' | 'conflict'; message: string };

/** The give-back part of the sources' registry (`SourceRegistry`, ports.ts). */
export interface GiveBackRegistry {
  /**
   * A person's Run again (`rerun`), or Rework (`rework`, issue #724: a done job's open pull request sent back, made a draft
   * by its source, the new job told `notes`), answered at once (issue #1194): the checks the hopper can make now — the job
   * the newest of its item, its end reported to its source, for Rework finished and following an open pull request —,
   * then the answer. Its source gives the item back after, on the job's report chain, and the new job follows
   * (`job.rerun`, `job.rework_requested`); a give-back that fails records `job.give_back_failed` and makes no job. The same
   * act sent again while one runs answers that one.
   */
  giveBack(jobId: string, act: { kind: 'rerun' } | { kind: 'rework'; notes: string }, acting?: ActingPerson): GiveBackAnswer;
  /**
   * A person's Retry, a hand-off's Continue or I fixed it, Push it or Tend again, `checked` now by its own service (issue
   * #1194): refused with why, else answered; its `run` goes on after, and one that fails records `job.give_back_failed`.
   * The same job's act sent again while one runs answers that one.
   */
  afterAnswer(act: GiveBackAct, checked: GiveBackChecked, acting?: ActingPerson): GiveBackAnswer;
  /** Tend again checked now (issue #1194): refused with why, or its run, for `afterAnswer`. */
  checkTendAgain(jobId: string, acting: ActingPerson): GiveBackChecked;
}
