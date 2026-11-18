// The usage limits from the command line (issue #2932, design.md "Usage limits"): `hopper usage limits` reads GET /api/usage —
// the user's usage limits and each machine's lane cap and band —; `limits set` changes the soft and hard limits and the soft
// lanes, keeping those it does not name (an admin's POST /ui/api/usage/limits); with `--machine` it sets that machine's own
// usage limits (issue #1860), and `limits clear --machine` takes them off, each a plugins edit of the machine's options
// (POST /ui/api/plugins). `hopper usage meter <source> auto|live|analytics` sets a usage source's `meter` option (issue #2966):
// how its account is metered; auto, the default, leaves its options. `hopper usage day-budget <source> <usd>|off` sets its `dayCostUsd`, the
// account day budget (issue #2966). The daemon checks every value.
import { parseArgs } from 'node:util';
import { OperatorRefusal, usage, type Call, type Getter } from './cli-operator-call.ts';
import type { UsageLimitPair, UsageLimits } from './domain/types.ts';

export const USAGE_LIMITS_USAGE = `  hopper usage limits                                the usage limits (soft, hard, soft lanes) and each machine's lane cap
  hopper usage limits set [--machine <machine>] [--soft <0..1>] [--hard <0..1>] [--soft-lanes <n>]
                                                     change them, or one machine's own; the limits not named stay
  hopper usage limits clear --machine <machine>      the machine goes by the user's usage limits again
  hopper usage meter <usage source> auto|live|analytics
                                                     how its account is metered: live reads its usage windows; analytics
                                                     reads it as having no usage limits and shows its daily usage; auto:
                                                     analytics for an Enterprise plan, else live
  hopper usage day-budget <usage source> <usd>|off   its account day budget: at the estimated spend of one UTC day, its
                                                     jobs run on the soft lanes only`;

const LINE = 'usage limits [set [--machine <machine>] [--soft <0..1>] [--hard <0..1>] [--soft-lanes <n>] | clear --machine <machine>]';
const METER_LINE = 'usage meter <usage source> auto|live|analytics';
const METERS = new Set(['auto', 'live', 'analytics']);
const DAY_BUDGET_LINE = 'usage day-budget <usage source> <usd>|off';

interface Configured { role: string; instance: { name: string; plugin: string; options?: Record<string, unknown> } }
interface PluginsAnswer { config: { version: string }; instances: Configured[] }

const fraction = (s: string | undefined): number | undefined => {
  if (s === undefined) return undefined;
  if (!/^(0(\.\d+)?|1(\.0+)?|\.\d+)$/.test(s)) throw usage(LINE);
  return Number(s);
};
const whole = (s: string | undefined): number | undefined => {
  if (s === undefined) return undefined;
  if (!/^\d+$/.test(s)) throw usage(LINE);
  return Number(s);
};

/** The plugins edit that sets the options of `role` instance `name` to what `change` makes of them now. */
const optionsEdit = (role: string, name: string, what: string, change: (now: Record<string, unknown>, get: Getter) => Promise<Record<string, unknown>>) =>
  async (get: Getter): Promise<{ path: string; body: unknown }> => {
    const plugins = await get('/api/plugins') as PluginsAnswer;
    const found = plugins.instances.find((c) => c.role === role && c.instance.name === name);
    if (!found) throw new OperatorRefusal(`no ${what} named ${name}`);
    const options = await change({ ...found.instance.options }, get);
    return { path: '/ui/api/plugins', body: { action: 'options', role, name, version: plugins.config.version, options } };
  };

/** `ask` over the limits now: `base` when the machine has none of its own (the user's). */
const merged = (ask: Partial<UsageLimitPair>, base: UsageLimitPair): UsageLimitPair => {
  const softLanes = ask.softLanes ?? base.softLanes;
  return { soft: ask.soft ?? base.soft, hard: ask.hard ?? base.hard, ...(softLanes === undefined ? {} : { softLanes }) };
};

const userLimits = async (get: Getter): Promise<UsageLimits> => ((await get('/api/usage')) as { limits: UsageLimits }).limits;

export function usageLimitsCall(args: string[]): Call {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, strict: true, options: { machine: { type: 'string' }, soft: { type: 'string' }, hard: { type: 'string' }, 'soft-lanes': { type: 'string' } } });
  } catch {
    throw usage(LINE);
  }
  const { values: v, positionals: [, verb, ...extra] } = parsed;
  if (extra.length > 0) throw usage(LINE);
  const ask = { soft: fraction(v.soft), hard: fraction(v.hard), softLanes: whole(v['soft-lanes']) };
  const asked = Object.fromEntries(Object.entries(ask).filter(([, n]) => n !== undefined)) as Partial<UsageLimitPair>;
  const named = Object.keys(asked).length > 0;
  if (verb === undefined) {
    if (named || v.machine !== undefined) throw usage(LINE);
    return {
      role: 'viewer', path: '/api/usage',
      pick: (a) => {
        const r = a as { limits: UsageLimits; machines: { machineId: string; maxLanes: number; cap: number; band: string; unknown?: string[]; usageLimits?: UsageLimitPair }[] };
        return { limits: r.limits, machines: r.machines.map((m) => ({ machineId: m.machineId, maxLanes: m.maxLanes, cap: m.cap, band: m.band, ...(m.unknown ? { unknown: m.unknown } : {}), ...(m.usageLimits ? { usageLimits: m.usageLimits } : {}) })) };
      },
    };
  }
  if (verb === 'clear') {
    if (named || !v.machine) throw usage(LINE);
    return {
      role: 'admin', path: '/ui/api/plugins',
      post: optionsEdit('machine-source', v.machine, 'machine', async ({ usageLimits: _, ...rest }) => rest),
    };
  }
  if (verb !== 'set' || !named || v.machine === '') throw usage(LINE);
  if (v.machine === undefined) return { role: 'admin', path: '/ui/api/usage/limits', body: async (get) => merged(asked, await userLimits(get)) };
  return {
    role: 'admin', path: '/ui/api/plugins',
    post: optionsEdit('machine-source', v.machine, 'machine', async (now, get) => {
      // A machine with none of its own starts from the user's soft and hard limits; its soft lanes stay the user's unless named.
      const own = now.usageLimits as UsageLimitPair | undefined;
      const { soft, hard } = own ?? await userLimits(get);
      return { ...now, usageLimits: merged(asked, own ?? { soft, hard }) };
    }),
  };
}

/** `usage meter <source> auto|live|analytics` (issue #2966): the source's `meter`; auto, the default, takes it out of its options. */
export function meterCall(args: string[]): Call {
  const [, source, meter, ...extra] = args;
  if (!source || source.startsWith('-') || meter === undefined || !METERS.has(meter) || extra.length > 0) throw usage(METER_LINE);
  return {
    role: 'admin', path: '/ui/api/plugins',
    post: optionsEdit('usage-source', source, 'usage source', async ({ meter: _, ...rest }) => (meter === 'auto' ? rest : { ...rest, meter })),
  };
}

/** `usage day-budget <source> <usd>|off` (issue #2966): the source's `dayCostUsd`; off, or 0, takes it out of its options. */
export function dayBudgetCall(args: string[]): Call {
  const [, source, value, ...extra] = args;
  const usd = value === 'off' ? 0 : Number(value);
  if (!source || source.startsWith('-') || value === undefined || value === '' || !(usd >= 0) || extra.length > 0) throw usage(DAY_BUDGET_LINE);
  return {
    role: 'admin', path: '/ui/api/plugins',
    post: optionsEdit('usage-source', source, 'usage source', async ({ dayCostUsd: _, ...rest }) => (usd > 0 ? { ...rest, dayCostUsd: usd } : rest)),
  };
}
