// Jev's trust check (issue #655 part 4, design.md "Trust stamps"; the decision point `intake-trust`): asked for each
// waiting job whose stamp is due for it (`checkDue`: a level it would start at on the rules alone, no person stamped it,
// no check made). Off, Jev is not asked and the rules' level stands. In shadow, Jev is asked once per waiting job and this
// hopper's run, its pick only recorded. Active, the job is held until the check is made, and the check is the stamp:
// kept, lowered with its reason, or — no answer, not sure, Jev not there — lowered to `untrusted` (fail closed), each
// lowering a `job.trust_lowered` event. Jev reads no credential and has no tool; every option is at or below the level.
import { DEFAULT_MINOR_DECISION_SETTINGS, type Job, type MinorDecisionMode } from '../domain/types.ts';
import { KEEP, TRUST_CHECK_INSTRUCTIONS, trustCheckState, trustOptions } from '../domain/trust-check.ts';
import { atLeast } from '../domain/trust-stamp.ts';
import type { EngineContext } from './context.ts';

/** At most this many checks at once. */
const MAX_CHECKS = 4;

export interface TrustChecks {
  /**
   * At a Decision, over the waiting jobs: Jev asked, after the caller's transaction, for each one due for a check and not
   * asked yet; answers whether the check holds a job now (the point active and the check due). One settings read. Never throws.
   */
  of(waiting: readonly Job[]): (job: Job) => boolean;
}

export function createTrustChecks(c: EngineContext): TrustChecks {
  const asked = new Set<string>();
  let inFlight = 0;
  const mode = (): MinorDecisionMode => ({ ...DEFAULT_MINOR_DECISION_SETTINGS['intake-trust'], ...c.store.settings.getMinorDecisionSettings()['intake-trust'] }).mode;

  async function run(job: Job, m: MinorDecisionMode): Promise<void> {
    const level = c.store.jobs.trustLevel(job);
    if (level === undefined || !job.stamp) return;
    const out = await c.jevFirst.decide({
      point: 'intake-trust', jobId: job.id, instructions: TRUST_CHECK_INSTRUCTIONS, options: trustOptions(level),
      state: trustCheckState(job, level, job.stamp.reasons), consequential: [],
      // In shadow the rules' level stands: a pick is compared with keep at once.
      ...(m === 'shadow' ? { rules: KEEP } : {}),
    });
    if (m !== 'active' || c.stopping()) return;
    const written = c.store.tx(() => {
      const next = c.store.jobs.checkTrust(job.id, out);
      const to = next ? c.store.jobs.trustLevel(next) : undefined;
      if (!next || to === undefined || atLeast(to, level)) return next !== undefined;
      const reason = next.stamp!.reasons.at(-1)!;
      c.store.events.append({ type: 'job.trust_lowered', jobId: job.id, data: { from: level, to, reason, by: 'jev' } });
      return true;
    });
    if (written) c.trigger('intake-trust checked');
  }

  function sweep(waiting: readonly Job[], m: MinorDecisionMode): void {
    if (m === 'off' || c.stopping()) return;
    for (const job of waiting) {
      const k = `${job.id}:${m}`;
      if (asked.has(k) || inFlight >= MAX_CHECKS || !c.store.jobs.checkDue(job)) continue;
      asked.add(k);
      inFlight += 1;
      void run(job, m)
        .catch((e: unknown) => { asked.delete(k); console.warn(`hopper: Jev's trust check of job ${job.id} failed: ${e instanceof Error ? e.message : String(e)}`); })
        .finally(() => { inFlight -= 1; });
    }
  }

  return {
    of(waiting) {
      if (waiting.length === 0) return () => false;
      const m = mode();
      if (m !== 'off') setImmediate(() => sweep(waiting, m));
      return (job) => m === 'active' && c.store.jobs.checkDue(job);
    },
  };
}
