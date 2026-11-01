// The park-condition pass (issue #2890, design.md "Parked jobs"): a job a person parked with a park condition is picked up
// by the hopper once the condition holds — the issue or pull request it names ended (closed, merged), the job it names
// ended, or its time passed. The items are read as a wait check reads them (`WaitReads.endedWatched`, the job's source). The
// pick up is `job.unparked` `by` `hopper`, with the condition and what fired it; the job is told why it resumes. A pick up
// the engine refuses (a job with no agent session to resume, issue #530) is kept on the park (`untilRefused`), and the pass
// tries it no more: a person picks it up. A person may pick the job up at any time; the condition then ends with the park.
import type { Job } from '../domain/types.ts';
import { TERMINAL_STATUSES } from '../domain/types.ts';
import { parkUntilLabel, type ParkUntil } from '../domain/park-until.ts';
import { NOT_FOUND } from '../domain/watched-items.ts';
import type { EngineContext } from './context.ts';
import { EngineError } from './errors.ts';
import { recordUnpark, resumeUnparked } from './park.ts';
import type { WaitReads } from './wait-checks.ts';

/** How often the pass runs: each run lists the parked jobs, and reads an item through its source's cache. */
export const PARK_UNTIL_EVERY_MS = 5_000;

/** What a check of a park condition found: held, with what fired it; or not, with why. */
export type UntilOutcome = { held: true; fired: string } | { held: false; result: string };

/** Whether `until` holds now for the parked `job`: its item read through `reads`, its job through `jobOf`. */
export async function untilOutcome(job: Job, until: ParkUntil, o: { reads?: WaitReads; jobOf(id: string): Job | undefined; nowMs: number }): Promise<UntilOutcome> {
  switch (until.kind) {
    case 'time':
      return o.nowMs >= Date.parse(until.at) ? { held: true, fired: `the time ${until.at} passed` } : { held: false, result: `it waits until ${until.at}` };
    case 'job': {
      const other = o.jobOf(until.jobId);
      if (!other) return { held: true, fired: `job ${until.jobId} is gone` };
      return TERMINAL_STATUSES.includes(other.status) ? { held: true, fired: `job ${until.jobId} ${other.status}` } : { held: false, result: `job ${until.jobId} is ${other.status}` };
    }
    case 'item': {
      const ref = { kind: 'issue' as const, repo: until.repo, number: until.number };
      const ended = await o.reads?.endedWatched(job, [ref]).catch(() => undefined);
      if (!ended) return { held: false, result: `the hopper cannot read ${until.repo}#${until.number} now` };
      const end = ended.find((e) => e.ref.kind === 'issue' && e.ref.repo.toLowerCase() === until.repo.toLowerCase() && e.ref.number === until.number);
      // An item that does not exist never ends: the condition stays, and the card says so.
      if (!end || end.state === NOT_FOUND) return { held: false, result: end ? `${until.repo}#${until.number} cannot be read` : `${until.repo}#${until.number} is open` };
      return { held: true, fired: `${end.url} was ${end.state}` };
    }
  }
}

/** What the picked-up job is told: why it resumes. */
export const untilBrief = (until: ParkUntil, fired: string): string =>
  `This job was parked until ${parkUntilLabel(until)}. That happened: ${fired}. It is resumed now, in the same session and work tree. Check what changed, then go on with it where you left off.`;

/** One pass over every job parked with a park condition the pass may still try. True when it picked one up. */
export async function runParkUntil(c: EngineContext): Promise<boolean> {
  const { store } = c;
  let picked = false;
  for (const listed of store.jobs.list({ status: ['parked'] })) {
    const until = listed.parked?.until;
    if (!until || listed.parked?.untilRefused || c.stopping()) continue;
    try {
      const outcome = await untilOutcome(listed, until, { reads: c.waitReads, jobOf: (id) => store.jobs.get(id), nowMs: c.clock.now().getTime() });
      if (outcome.held && pickUp(c, listed, until, outcome.fired)) picked = true;
    } catch (e) {
      console.error(`hopper: the park condition of job ${listed.id} failed, tried again at the next pass`, e);
    }
  }
  return picked;
}

/** In a tx, while the job is still on the same park: picked up by the hopper, told why; a refusal kept on the park. */
function pickUp(c: EngineContext, listed: Job, until: ParkUntil, fired: string): boolean {
  const { store } = c;
  let next: Job | undefined;
  try {
    next = store.tx(() => {
      const now = store.jobs.get(listed.id);
      if (now?.status !== 'parked' || now.parked?.at !== listed.parked?.at) return undefined;
      // A job parked mid-turn is told why it resumes; one on a question or a review item waits on it again, as at any pick up.
      if (now.parked?.from === 'running' && now.pendingAnswer === undefined) store.jobs.update(now.id, { pendingAnswer: untilBrief(until, fired) });
      return recordUnpark(c, now.id, false, false, { by: 'hopper', until, fired });
    });
  } catch (e) {
    if (!(e instanceof EngineError)) throw e;
    store.tx(() => {
      const now = store.jobs.get(listed.id);
      if (now?.status === 'parked' && now.parked && now.parked.at === listed.parked?.at) store.jobs.update(now.id, { parked: { ...now.parked, untilRefused: e.message } });
    });
    return false;
  }
  if (!next) return false;
  resumeUnparked(c, next);
  return true;
}
