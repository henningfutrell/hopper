// The usage limits set in the UI (issue #522, design.md "Usage limits"): the user's soft and hard limits and soft lanes
// (issue #2091), stored in the user's settings, win over HOPPER_SOFT_LIMIT / HOPPER_HARD_LIMIT from the moment they are
// set. The change is a `usage.limits_changed` event, which wakes the engine: the next Decision decides by them.
import { DEFAULT_SOFT_LANES } from '../domain/decider-policy.ts';
import type { UsageLimitPair, UsageLimits } from '../domain/types.ts';
import { policyOf, type EngineContext } from './context.ts';
import { EngineError } from './errors.ts';

/** The usage limits the decider uses now, with the defaults they replace. */
export function usageLimitsOf(c: Pick<EngineContext, 'policy' | 'store'>): UsageLimits {
  const now = policyOf(c);
  return {
    soft: now.softLimit, hard: now.hardLimit, softLanes: now.softLanes ?? DEFAULT_SOFT_LANES,
    defaults: { soft: c.policy.softLimit, hard: c.policy.hardLimit, softLanes: c.policy.softLanes ?? DEFAULT_SOFT_LANES },
    set: c.store.settings.getUsageLimits() !== undefined,
  };
}

export interface UsageLimitCommands {
  /** Set the user's usage limits: fractions of 0..1, soft below hard; soft lanes a whole number from 0, absent: kept. */
  setUsageLimits(limits: UsageLimitPair): UsageLimits;
}

export function createUsageLimitCommands(c: EngineContext): UsageLimitCommands {
  return {
    setUsageLimits({ soft, hard, softLanes: asked }) {
      if (!(soft >= 0 && hard <= 1 && soft < hard)) throw new EngineError('invalid', 'the soft limit must be below the hard limit, both from 0 to 1');
      if (asked !== undefined && !(Number.isInteger(asked) && asked >= 0)) throw new EngineError('invalid', 'the soft lanes must be a whole number from 0');
      const was = usageLimitsOf(c);
      const softLanes = asked ?? was.softLanes;
      const from = { soft: was.soft, hard: was.hard, softLanes: was.softLanes };
      const to = { soft, hard, softLanes };
      c.store.tx(() => {
        c.store.settings.setUsageLimits(to);
        if (from.soft !== soft || from.hard !== hard || from.softLanes !== softLanes) c.store.events.append({ type: 'usage.limits_changed', data: { from, to } });
      });
      return usageLimitsOf(c);
    },
  };
}
