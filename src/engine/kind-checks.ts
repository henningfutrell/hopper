// Jev's kind check (issue #655, design.md "Trust stamps"; the decision point `intake-kind`): asked for each waiting work job
// from a job source that never started (`kindCheckDue`). Off, Jev is not asked and the job does the work. In shadow, Jev is
// asked once per waiting job and this hopper's run, its pick only recorded. Active, the job is held until the check is
// made, and the check is kept on the job: research or a proposal asks the job for it (`research.asked`, `proposal.asked`,
// `by: jev`), as a person's ask does; keep, or no sure pick, keeps the work. Jev reads no credential and has no tool.
import { DEFAULT_MINOR_DECISION_SETTINGS, REVIEW_SECTIONS, TERMINAL_STATUSES, type EventType, type Job, type MinorDecisionMode } from '../domain/types.ts';
import { checkedKind, KEEP_KIND, KIND_CHECK_INSTRUCTIONS, kindCheckDue, kindCheckState, kindOptions } from '../domain/kind-check.ts';
import type { EngineContext } from './context.ts';

/** At most this many checks at once. */
const MAX_CHECKS = 4;

/** Why the check holds a job, the point active. */
export const KIND_CHECK_PENDING = 'Jev checks what kind of job it is: held — it starts once the check is made; a person can cancel it';

export interface KindChecks {
  /**
   * At a Decision, over the waiting jobs: Jev asked, after the caller's transaction, for each one due for a check and not
   * asked yet; answers whether the check holds a job now (the point active and the check due). One settings read. Never throws.
   */
  of(waiting: readonly Job[]): (job: Job) => boolean;
}

export function createKindChecks(c: EngineContext): KindChecks {
  const asked = new Set<string>();
  let inFlight = 0;
  const mode = (): MinorDecisionMode => ({ ...DEFAULT_MINOR_DECISION_SETTINGS['intake-kind'], ...c.store.settings.getMinorDecisionSettings()['intake-kind'] }).mode;
  const due = (job: Job): boolean => kindCheckDue(job, c.executors.get(job.spec.executor)?.reviews === true);

  async function run(job: Job, m: MinorDecisionMode): Promise<void> {
    const out = await c.jevFirst.decide({
      point: 'intake-kind', jobId: job.id, instructions: KIND_CHECK_INSTRUCTIONS, options: kindOptions(), state: kindCheckState(job), consequential: [],
      // In shadow the job does the work: a pick is compared with keep at once.
      ...(m === 'shadow' ? { rules: KEEP_KIND } : {}),
    });
    if (m !== 'active' || c.stopping()) return;
    const written = c.store.tx(() => {
      const cur = c.store.jobs.get(job.id);
      // Written only while the check is still due: a start, a person's ask or another hopper's check came first.
      if (!cur || TERMINAL_STATUSES.includes(cur.status) || !due(cur)) return false;
      const { kind, check } = checkedKind(out);
      if (kind) {
        const type = REVIEW_SECTIONS[kind];
        c.store.jobs.respecify(cur.id, { ...cur.spec, [type.specFlag]: true });
        c.store.events.append({ type: `${type.prefix}.asked` as EventType, jobId: cur.id, data: { by: 'jev' } });
      }
      c.store.jobs.update(cur.id, { kindCheck: check });
      return true;
    });
    if (written) c.trigger('intake-kind checked');
  }

  function sweep(waiting: readonly Job[], m: MinorDecisionMode): void {
    if (m === 'off' || c.stopping()) return;
    for (const job of waiting) {
      const k = `${job.id}:${m}`;
      if (asked.has(k) || inFlight >= MAX_CHECKS || !due(job)) continue;
      asked.add(k);
      inFlight += 1;
      void run(job, m)
        .catch((e: unknown) => { asked.delete(k); console.warn(`hopper: Jev's kind check of job ${job.id} failed: ${e instanceof Error ? e.message : String(e)}`); })
        .finally(() => { inFlight -= 1; });
    }
  }

  return {
    of(waiting) {
      if (waiting.length === 0) return () => false;
      const m = mode();
      if (m !== 'off') setImmediate(() => sweep(waiting, m));
      return (job) => m === 'active' && due(job);
    },
  };
}
