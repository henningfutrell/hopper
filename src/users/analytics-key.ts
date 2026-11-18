// What a user's `claude-analytics` usage source reads with (issue #2966, design.md "Daily usage from the Analytics API"):
// the Claude Analytics API key, the user's system secret `claude-analytics-key`, opened at each read so a key set, replaced
// or removed applies at the next read; and the Claude accounts the user's other usage sources read now, whose daily usage it
// keeps. Only the hopper opens the key, in its own process: never a job, a machine or a box.
import type { Account } from '../domain/types.ts';
import type { UsageSource } from '../domain/ports.ts';
import type { AnalyticsContext } from '../plugins/sdk.ts';
import type { SystemSecrets } from '../vault/system.ts';

/** The read purpose its open names in the vault's read event. */
const PURPOSE = 'the claude-analytics usage source';

export function analyticsContext(system: Pick<SystemSecrets, 'open'>, sources: () => readonly UsageSource[]): AnalyticsContext {
  return {
    key: () => system.open('claude-analytics-key', PURPOSE),
    // An account read signed in, with an email: one per email, the first source's.
    accounts: () => {
      const seen = new Map<string, Account>();
      for (const s of sources()) {
        const a = s.state?.().account;
        if (a?.service !== 'claude' || !a.identity || a.signedOut) continue;
        if (!seen.has(a.identity.toLowerCase())) seen.set(a.identity.toLowerCase(), a);
      }
      return [...seen.values()];
    },
  };
}
