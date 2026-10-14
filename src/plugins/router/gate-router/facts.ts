// Verdicts the job's own facts fix (issue #628): no gate to judge, so no shim run and no model call.
// The gate router asks these before it spawns the shim; every other job goes to the gates.
import type { AdviceAction, Job } from '../../sdk.ts';

/** The `spec.meta` keys the gates read, beside `goal` and `kind`. */
export const META_KEYS = ['cached_artifact', 'cached_note', 'prior_error', 'same_error_count', 'sources_found', 'constraints'] as const;
/** Repeats of the same error that stop the retries: grok-bot-jev's precedence, and the fake router's. */
export const STOP_RETRY_SAME_ERRORS = 1;
const SHOWN_CHARS = 200;

export interface FactVerdict {
  action: AdviceAction;
  reason: string;
  /** The fact that fixed it. */
  rule: 'cached_artifact' | 'same_error_count' | 'no_meta_keys';
}

const present = (v: unknown): boolean => v !== undefined && v !== null && v !== false && v !== '';
const shown = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v)).slice(0, SHOWN_CHARS);

/** The verdict the job's facts fix, or undefined: the gates judge it. */
export function factVerdict(job: Job): FactVerdict | undefined {
  const meta = job.spec.meta ?? {};
  if (present(meta.cached_artifact)) {
    return { action: 'reuse_cache', reason: `a cached artifact is present: ${shown(meta.cached_artifact)}`, rule: 'cached_artifact' };
  }
  const repeats = Number(meta.same_error_count);
  if (present(meta.prior_error) && Number.isFinite(repeats) && repeats >= STOP_RETRY_SAME_ERRORS) {
    return { action: 'stop_retry', reason: `the same error ${repeats} times: ${shown(meta.prior_error)}`, rule: 'same_error_count' };
  }
  // Only the goal and kind to judge (every GitHub issue job today): the gates add nothing a model must be asked for.
  if (!META_KEYS.some((k) => k in meta)) {
    return { action: 'proceed_full', reason: 'no job facts for the gates to judge', rule: 'no_meta_keys' };
  }
  return undefined;
}
