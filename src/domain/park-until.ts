// A park condition (issue #2890, design.md "Parked jobs"): what a person who parks a job names for the hopper to pick it up
// on — an issue or a pull request ends (closed, merged), a job ends, or a time passes. Kept on the park (`parked.until`), and
// tested on each tick by the park-condition pass (engine/park-until.ts) with the same item reads as a wait check. Pure.
import { refsIn } from './watched-items.ts';

export type ParkUntil =
  | { kind: 'item'; repo: string; number: number }
  | { kind: 'job'; jobId: string }
  | { kind: 'time'; at: string };

/** The longest condition text a person may give. */
export const PARK_UNTIL_MAX = 200;

const JOB = /^job[\s:]+([\w-]+)$/i;
const OWN_NUMBER = /^#(\d+)$/;

/**
 * The park condition `text` names, or why it names none: `owner/name#N`, `name#N` (the job's owner), `#N` (the job's own
 * repository, `ownRepo`) or a link to an issue or a pull request; `job <id>`; an ISO time.
 */
export function parkUntilOf(text: string, ownRepo: string | undefined): ParkUntil | string {
  const t = text.trim();
  const job = JOB.exec(t);
  if (job) return { kind: 'job', jobId: job[1]! };
  if (/^\d{4}-\d{2}-\d{2}T/.test(t)) {
    const at = Date.parse(t);
    return Number.isNaN(at) ? `${t} is not a time: write an ISO time, for example 2026-11-02T08:00:00Z` : { kind: 'time', at: new Date(at).toISOString() };
  }
  const own = OWN_NUMBER.exec(t);
  if (own) return ownRepo ? { kind: 'item', repo: ownRepo, number: Number(own[1]) } : `${t} names no repository: the job has none, so write owner/name#N`;
  const refs = refsIn(t, ownRepo);
  if (refs.length > 1) return `${t} names more than one condition: name one`;
  const ref = refs[0];
  if (ref?.kind !== 'issue') return `${t} names no condition: write owner/name#N (an issue or a pull request), job <id>, or an ISO time`;
  return { kind: 'item', repo: ref.repo, number: ref.number };
}

/** The condition as a person reads it, after "parked until". */
export function parkUntilLabel(u: ParkUntil): string {
  switch (u.kind) {
    case 'item': return `${u.repo}#${u.number} closes or merges`;
    case 'job': return `job ${u.jobId} ends`;
    case 'time': return u.at;
  }
}
