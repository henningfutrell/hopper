// claude-analytics: the daily usage of Claude Enterprise accounts, from the Claude Enterprise Analytics API (issue #2966,
// design.md "Daily usage from the Analytics API"). Enterprise seats are metered by spend, so `claude -p /usage` gives no
// session or week window for them; this source shows what each account used on its last day, one day late. It reads the
// day before today (UTC), or the newest day the API has: the users' Claude Code activity (`/analytics/users`), then the
// cost and the tokens of those users' Claude Code use (`/analytics/cost`, `/analytics/usage`, by user id). It keeps only
// the accounts the user's other usage sources read (`claude auth status`), matched by email; every other user's row is
// dropped as it is read. An informational source: it gives no reading, never throttles and never caps a lane, and with no
// read its usage is not unknown. The key is the user's system secret `claude-analytics-key`, opened at each read; none
// set is a state (`notConfigured`), not a problem. Its calls go to the Claude API only (`baseUrl`, a loopback fake in tests).
import type { PluginDefinition } from '../../sdk.ts';
import { createPolledUsageSource, type Read } from '../polled.ts';
import { dailyUsageOf, newestDayIn, parseCostPage, parseUsagePage, parseUsersPage, type Page, type UserRow } from './parse.ts';

export interface ClaudeAnalyticsOptions { baseUrl: string; intervalSeconds: number }

/** Each call is stopped after this long. */
const TIMEOUT_MS = 30_000;
/** At most this many pages of one endpoint in one read: 1000 rows each. The API allows 60 calls a minute. */
const MAX_PAGES = 20;
const VERSION = '2026-10-21';
/** The usage and cost endpoints need it (https://platform.claude.com/docs/en/manage-claude/usage-cost-analytics-api). */
const USAGE_COST_BETA = 'analytics-usage-cost-2026-08-24';
const DAY_MS = 86_400_000;
/** The Claude API: where the key goes when no `claude-analytics` source names another `baseUrl`. */
export const ANALYTICS_BASE_URL = 'https://api.anthropic.com';

export const NOT_CONFIGURED = 'analytics key not configured: the organization\'s Primary Owner makes a key with the read:analytics scope '
  + '(claude.ai → Organization settings → API), and an admin sets it on Usage';

/** What a call answered: its JSON, or why not. Never the key: an error names the status and the API's own message. */
type Answer = { json: unknown } | { status: number; message: string } | { error: string };

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The API's error message, cut short, with anything like a key masked. */
function errorMessage(text: string): string {
  let m = text;
  try {
    const j = JSON.parse(text) as { error?: { message?: unknown } };
    if (typeof j.error?.message === 'string') m = j.error.message;
  } catch { /* the text as it is */ }
  return m.replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-…').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** One call to the API at `baseUrl`, with the key. */
async function callApi(baseUrl: string, key: string, path: string, query: [string, string][], beta: boolean, signal: AbortSignal): Promise<Answer> {
  const url = new URL(path, baseUrl);
  for (const [k, v] of query) url.searchParams.append(k, v);
  try {
    const r = await fetch(url, {
      headers: { 'x-api-key': key, 'anthropic-version': VERSION, ...(beta ? { 'anthropic-beta': USAGE_COST_BETA } : {}), 'user-agent': 'hopper' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
    });
    const text = await r.text();
    if (!r.ok) return { status: r.status, message: errorMessage(text) };
    try { return { json: JSON.parse(text) as unknown }; } catch { return { error: `${path}: the answer is not JSON` }; }
  } catch (e) {
    return { error: `${path}: ${message(e)}` };
  }
}

/**
 * The one check of a key before it is kept (issue #2966): one page of one user of `/analytics/users` for the day before
 * `now`. The API took the key when it answers the data, or a 400 for a day it has not made yet; a 401 or a 403 is a key it
 * refused. Why not never holds the key.
 */
export async function checkAnalyticsKey(baseUrl: string, key: string, now: Date): Promise<{ ok: true } | { ok: false; why: string }> {
  const path = '/v1/organizations/analytics/users';
  const a = await callApi(baseUrl, key, path, [['date', day(now.getTime() - DAY_MS)], ['limit', '1']], false, AbortSignal.timeout(TIMEOUT_MS));
  if ('json' in a || ('status' in a && a.status === 400)) return { ok: true };
  if ('error' in a) return { ok: false, why: `Analytics API ${a.error}` };
  return { ok: false, why: a.status === 401 || a.status === 403 ? `the Analytics API refused the key (HTTP ${a.status}): ${a.message}` : `Analytics API ${path}: HTTP ${a.status}: ${a.message}` };
}

const claudeAnalytics: PluginDefinition<'usage-source', ClaudeAnalyticsOptions> = {
  id: 'claude-analytics',
  role: 'usage-source',
  describe: 'Claude Enterprise accounts\' daily usage — cost, tokens and Claude Code activity, one day late — from the Claude Enterprise Analytics API, with the analytics key set on Usage; shown only, it never limits a job',
  options: (z) => z.object({
    baseUrl: z.url().default(ANALYTICS_BASE_URL).meta({ commandBearing: true, description: 'where the analytics key is sent: the Claude API' }),
    intervalSeconds: z.number().int().min(3600).default(21600).meta({ description: 'seconds between reads (the data is daily)' }),
  }),
  // Never a call to the API here: whether the key is set and works shows in the source's state.
  detect: async (_sys, o) => ({ status: 'available', detail: `the Analytics API at ${o.baseUrl}, with the analytics key set on Usage` }),
  create(ctx, o) {
    const call = (key: string, path: string, query: [string, string][], beta: boolean, signal: AbortSignal): Promise<Answer> =>
      callApi(o.baseUrl, key, path, query, beta, signal);
    const failed = (path: string, a: Exclude<Answer, { json: unknown }>): string =>
      ('error' in a ? `Analytics API ${a.error}`
        : a.status === 401 || a.status === 403 ? `the Analytics API refused the analytics key (HTTP ${a.status}): ${a.message}`
          : `Analytics API ${path}: HTTP ${a.status}: ${a.message}`);

    /** Every page of one endpoint, or why not. */
    async function pages<T>(key: string, path: string, query: [string, string][], beta: boolean, parse: (json: unknown) => Page<T>, signal: AbortSignal): Promise<{ rows: T[] } | { answer: Exclude<Answer, { json: unknown }> } | { problem: string }> {
      const rows: T[] = [];
      let next: string | undefined;
      for (let i = 0; i < MAX_PAGES; i++) {
        const a = await call(key, path, [...query, ['limit', '1000'], ...(next ? [['page', next] as [string, string]] : [])], beta, signal);
        if (!('json' in a)) return { answer: a };
        const p = parse(a.json);
        if ('problem' in p) return p;
        rows.push(...p.rows);
        if (!p.next) return { rows };
        next = p.next;
      }
      return { problem: `Analytics API ${path}: more than ${MAX_PAGES} pages` };
    }

    return createPolledUsageSource(ctx, {
      intervalSeconds: o.intervalSeconds, informational: true,
      async read(signal): Promise<Read> {
        let key: string | undefined;
        try {
          key = ctx.analytics?.key();
        } catch (e) {
          return { problem: `the analytics key cannot be opened: ${message(e)}` };
        }
        // Read again soon: a key set now applies at once, not an interval later.
        if (!key) return { notConfigured: NOT_CONFIGURED, notReady: true };
        const accounts = (ctx.analytics?.accounts() ?? []).flatMap((a) => (a.identity ? [a.identity] : []));
        // No account read yet (the other sources read after start): nothing to keep, so no call. Read again soon.
        if (accounts.length === 0) return { budgets: [], notReady: true };
        const keep = new Set(accounts.map((a) => a.toLowerCase()));
        // Yesterday; a day the API has not made yet is a 400 that names the newest day it has: that day, once.
        let date = day(ctx.clock.now().getTime() - DAY_MS);
        let users = await pages(key, '/v1/organizations/analytics/users', [['date', date]], false, (j) => parseUsersPage(j, keep), signal);
        const older = 'answer' in users && 'status' in users.answer && users.answer.status === 400 ? newestDayIn(users.answer.message, date) : undefined;
        if (older) {
          date = older;
          users = await pages(key, '/v1/organizations/analytics/users', [['date', date]], false, (j) => parseUsersPage(j, keep), signal);
        }
        if ('answer' in users) return { problem: failed('/v1/organizations/analytics/users', users.answer) };
        if ('problem' in users) return users;
        const ids = users.rows.map((u: UserRow) => u.id);
        // Only the matched users' cost and tokens are asked for, by their ids.
        const range: [string, string][] = [
          ['starting_at', `${date}T00:00:00Z`], ['ending_at', `${day(Date.parse(`${date}T00:00:00Z`) + DAY_MS)}T00:00:00Z`],
          ['group_by[]', 'actor'], ['actor_types[]', 'user_actor'], ['products[]', 'claude_code'], ...ids.map((id): [string, string] => ['actor_ids[]', id]),
        ];
        const cost = ids.length ? await pages(key, '/v1/organizations/analytics/cost', range, true, parseCostPage, signal) : { rows: [] };
        if ('answer' in cost) return { problem: failed('/v1/organizations/analytics/cost', cost.answer) };
        if ('problem' in cost) return cost;
        const tokens = ids.length ? await pages(key, '/v1/organizations/analytics/usage', range, true, parseUsagePage, signal) : { rows: [] };
        if ('answer' in tokens) return { problem: failed('/v1/organizations/analytics/usage', tokens.answer) };
        if ('problem' in tokens) return tokens;
        return { budgets: [], daily: dailyUsageOf({ date, accounts, users: users.rows, cost: cost.rows, tokens: tokens.rows }) };
      },
    });
  },
};

export default claudeAnalytics;
