// The usage limits set in the UI (issue #522, design.md "Usage limits"): the user's soft and hard limits, stored
// in the user's settings, win over HOPPER_SOFT_LIMIT / HOPPER_HARD_LIMIT from the moment they are set. The
// change is a `usage.limits_changed` event, which wakes the engine: the next Decision decides by them.
import type { UsageLimitPair, UsageLimits } from '../domain/types.ts';
import { policyOf, type EngineContext } from './context.ts';
import { EngineError } from './errors.ts';

/** The usage limits the decider uses now, with the defaults they replace. */
export function usageLimitsOf(c: Pick<EngineContext, 'policy' | 'store'>): UsageLimits {
  const now = policyOf(c);
  return {
    soft: now.softLimit, hard: now.hardLimit,
    defaults: { soft: c.policy.softLimit, hard: c.policy.hardLimit },
    set: c.store.settings.getUsageLimits() !== undefined,
  };
}

export interface UsageLimitCommands {
  /** Set the user's usage limits: fractions of 0..1, soft below hard. */
  setUsageLimits(limits: UsageLimitPair): UsageLimits;
}

export function createUsageLimitCommands(c: EngineContext): UsageLimitCommands {
  return {
    setUsageLimits({ soft, hard }) {
      if (!(soft >= 0 && hard <= 1 && soft < hard)) throw new EngineError('invalid', 'the soft limit must be below the hard limit, both from 0 to 1');
      const was = usageLimitsOf(c);
      const from = { soft: was.soft, hard: was.hard };
      c.store.tx(() => {
        c.store.settings.setUsageLimits({ soft, hard });
        if (from.soft !== soft || from.hard !== hard) c.store.events.append({ type: 'usage.limits_changed', data: { from, to: { soft, hard } } });
      });
      return usageLimitsOf(c);
    },
  };
}
