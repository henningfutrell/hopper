// A person's Run again or Rework, answered before its source gives the item back (issue #1194, design.md "Actions answer
// at once"): `SourceRegistry.giveBack`.

/** What a person's Run again or Rework gives back after its answer. */
export type GiveBackAct = 'rerun' | 'rework';

/** A person's Run again or Rework, answered: its give-back runs, or why it is refused now. */
export type GiveBackAnswer =
  | { ok: true; jobId: string; giveBack: GiveBackAct }
  | { ok: false; reason: 'not_found' | 'conflict'; message: string };
