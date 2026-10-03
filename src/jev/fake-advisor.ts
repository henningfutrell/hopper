import type { Clock, JevAdvisor } from '../domain/ports.ts';
import type { Job, JevAction, JevAdvice } from '../domain/types.ts';

/** Same markers as grok-bot-jev src/router.py BYPASS_MARKERS. */
const BYPASS_MARKERS = ['bypass jev', 'bypass jev:', 'no jev'];

function bypassed(job: Job): boolean {
  const notes = job.spec.meta?.notes;
  const text = `${job.spec.goal ?? ''} ${typeof notes === 'string' ? notes : ''}`.toLowerCase();
  return BYPASS_MARKERS.some((m) => text.includes(m));
}

function classify(job: Job): { action: JevAction; reason: string } {
  const { kind, meta = {} } = job.spec;
  const sameErrors = Number(meta.same_error_count ?? 0);
  if (meta.cached_artifact) return { action: 'reuse_cache', reason: 'meta.cached_artifact set' };
  if (meta.prior_error && sameErrors >= 1) {
    return { action: 'stop_retry', reason: `prior_error repeated ${sameErrors}x` };
  }
  if (kind === 'lookup') return { action: 'run_deterministic', reason: 'kind=lookup' };
  if (kind === 'chat') return { action: 'chat_only', reason: 'kind=chat' };
  if (kind === 'account') return { action: 'ask_human', reason: 'kind=account requires approval' };
  if (meta.needs_subagent) return { action: 'allow_subagent', reason: 'meta.needs_subagent set' };
  if (kind === 'research' || kind === 'browser') {
    return { action: 'research_capped', reason: `kind=${kind}` };
  }
  return { action: 'proceed_full', reason: 'default full work' };
}

export function createFakeAdvisor(o: { clock: Clock }): JevAdvisor {
  return {
    name: 'fake',
    async advise(job: Job): Promise<JevAdvice> {
      const at = o.clock.now().toISOString();
      if (bypassed(job)) {
        return { action: 'proceed_full', reason: 'bypass marker', jevUsed: false, details: {}, source: 'fake', at };
      }
      return { ...classify(job), jevUsed: true, details: {}, source: 'fake', at };
    },
  };
}
