// What a user's `claude-analytics` usage source reads with (issue #2966, design.md "Daily usage from the Analytics API"):
// the Claude Analytics API key, the user's system secret `claude-analytics-key`, opened at each read so a key set, replaced
// or removed applies at the next read; and the Claude accounts the user's other usage sources read now, whose daily usage it
// keeps. Only the hopper opens the key, in its own process: never a job, a machine or a box. An admin sets the key on Usage
// or by the operator CLI (`POST /ui/api/claude-analytics-key`): it is checked once against the Analytics API, at the
// `baseUrl` of the user's `claude-analytics` source (else the Claude API), before it is kept; one that fails is not kept.
import type { Account, AnalyticsKeyView } from '../domain/types.ts';
import type { Clock, ConfigRecords, UsageSource } from '../domain/ports.ts';
import { PLUGINS, loadPluginsConfig } from '../plugins/plugins-config.ts';
import { ANALYTICS_BASE_URL, checkAnalyticsKey } from '../plugins/usage-source/claude-analytics/index.ts';
import type { AnalyticsContext } from '../plugins/sdk.ts';
import { maskSecret } from '../secrets/mask.ts';
import type { SystemChanger, SystemResult, SystemSecrets } from '../vault/system.ts';

/** The read purpose its open names in the vault's read event. */
const PURPOSE = 'the claude-analytics usage source';
const NAME = 'claude-analytics-key';

export function analyticsContext(system: Pick<SystemSecrets, 'open'>, sources: () => readonly UsageSource[]): AnalyticsContext {
  return {
    key: () => system.open(NAME, PURPOSE),
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

export type AnalyticsKeyResult = { ok: true; view: AnalyticsKeyView } | Exclude<SystemResult, { ok: true }>;

/** The analytics key's view, set and remove: never the key. */
export interface AnalyticsKey {
  view(): AnalyticsKeyView;
  /** Checks `value` once against the Analytics API, then keeps it in place of any key kept. */
  set(value: string, who: SystemChanger): Promise<AnalyticsKeyResult>;
  remove(who: SystemChanger): Promise<AnalyticsKeyResult>;
}

export function createAnalyticsKey(o: {
  system: Pick<SystemSecrets, 'meta' | 'set' | 'remove' | 'problem'>;
  /** The one check of a key against the Analytics API (`checkAnalyticsKey` at the source's `baseUrl`). */
  check(key: string): Promise<{ ok: true } | { ok: false; why: string }>;
}): AnalyticsKey {
  function view(): AnalyticsKeyView {
    const meta = o.system.meta(NAME);
    const problem = o.system.problem();
    return {
      set: meta !== undefined,
      ...(meta ? { ...(meta.last4 ? { last4: meta.last4 } : {}), setAt: meta.setAt, setBy: meta.setBy } : {}),
      ...(problem ? { problem } : {}),
    };
  }
  const done = (r: SystemResult): AnalyticsKeyResult => (r.ok ? { ok: true, view: view() } : r);
  return {
    view,
    async set(raw, who) {
      const value = raw.trim();
      if (!value) return { ok: false, code: 'invalid', error: 'the key is empty' };
      const cannot = o.system.problem();
      if (cannot) return { ok: false, code: 'unavailable', error: cannot };
      const checked = await o.check(value);
      if (!checked.ok) return { ok: false, code: 'invalid', error: `the key was not saved: the check against the Analytics API failed: ${maskSecret(checked.why, value, 'analytics key')}` };
      return done(await o.system.set(NAME, value, who));
    },
    async remove(who) {
      return done(await o.system.remove(NAME, who));
    },
  };
}

/** The `baseUrl` of the user's first `claude-analytics` usage source, else the Claude API: where its reads go. */
export function analyticsBaseUrl(config: Pick<ConfigRecords, 'read'>): string {
  const c = loadPluginsConfig(config.read(PLUGINS));
  const spec = 'usageSources' in c ? c.usageSources?.find((s) => s.plugin === 'claude-analytics') : undefined;
  const url = spec?.options?.baseUrl;
  return typeof url === 'string' && url ? url : ANALYTICS_BASE_URL;
}

/** The user's analytics key, checked at the `baseUrl` its source reads. */
export function userAnalyticsKey(o: { system: Pick<SystemSecrets, 'meta' | 'set' | 'remove' | 'problem'>; config: Pick<ConfigRecords, 'read'>; clock: Clock }): AnalyticsKey {
  return createAnalyticsKey({ system: o.system, check: (key) => checkAnalyticsKey(analyticsBaseUrl(o.config), key, o.clock.now()) });
}
