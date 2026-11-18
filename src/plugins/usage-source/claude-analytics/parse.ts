// The Claude Enterprise Analytics API's answers as daily usage (issue #2966, design.md "Daily usage from the Analytics
// API"). Pure. Each page is parsed as it comes, and a user row of an account this hopper does not read is dropped there:
// the key reads every user of the organization, and the hopper keeps only its own accounts' counts, never a name or
// another account's row. Shapes: https://platform.claude.com/docs/en/api/beta/organization/analytics (read 2026-11-18).
import { z } from 'zod';
import type { DailyUsage, DailyUsageRead } from '../../../domain/types.ts';

/** A count the API may leave out or give as null: 0. */
const count = z.number().nonnegative().nullish().transform((n) => n ?? 0);
const toolAction = z.object({ accepted_count: count, rejected_count: count }).nullish();

/** `GET /v1/organizations/analytics/users`: one row per user of the organization on the day. */
const USERS_PAGE = z.object({
  data: z.array(z.object({
    user: z.object({ id: z.string().min(1), email_address: z.string().nullish() }).nullish(),
    claude_code_metrics: z.object({
      core_metrics: z.object({
        commit_count: count, distinct_session_count: count, pull_request_count: count,
        lines_of_code: z.object({ added_count: count, removed_count: count }).nullish(),
      }).nullish(),
      tool_actions: z.object({ edit_tool: toolAction, multi_edit_tool: toolAction, notebook_edit_tool: toolAction, write_tool: toolAction }).nullish(),
    }).nullish(),
  })),
  next_page: z.string().nullish(),
});

/** The actor a row of `/analytics/cost` or `/analytics/usage` grouped by `actor` is of: a user by id. */
const ACTOR = z.object({ user_id: z.string().nullish() }).nullish();

const COST_PAGE = z.object({
  data: z.array(z.object({ group: z.object({ actor: ACTOR }).nullish(), cost: z.object({ amount: z.string() }) })),
  has_more: z.boolean().nullish(),
  next_page: z.string().nullish(),
});

const USAGE_PAGE = z.object({
  data: z.array(z.object({
    group: z.object({ actor: ACTOR }).nullish(),
    usage: z.object({
      uncached_input_tokens: count, output_tokens: count, cache_read_input_tokens: count,
      cache_creation: z.object({ ephemeral_1h_input_tokens: count, ephemeral_5m_input_tokens: count }).nullish(),
    }),
  })),
  has_more: z.boolean().nullish(),
  next_page: z.string().nullish(),
});

/** One user row kept: an account this hopper reads, by its user id. */
export interface UserRow { id: string; account: string; activity: Omit<DailyUsage, 'account' | 'date' | 'costCents' | 'tokens'> }

/** A page parsed: its rows, and the cursor of the next page (absent: the last). */
export type Page<T> = { rows: T[]; next?: string } | { problem: string };

const problemOf = (what: string, e: z.ZodError): { problem: string } =>
  ({ problem: `${what}: ${e.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'answer'}: ${i.message}`).join('; ')}` });

/** The next page's cursor: only while the answer says there is more (`has_more`, when it says it). */
const nextOf = (p: { has_more?: boolean | null | undefined; next_page?: string | null | undefined }): { next?: string } =>
  (p.next_page && p.has_more !== false ? { next: p.next_page } : {});

/** A users page: the rows of the accounts `keep` names (by lower-case email); every other row is dropped here. */
export function parseUsersPage(json: unknown, keep: ReadonlySet<string>): Page<UserRow> {
  const p = USERS_PAGE.safeParse(json);
  if (!p.success) return problemOf('analytics users', p.error);
  const rows: UserRow[] = [];
  for (const r of p.data.data) {
    const email = r.user?.email_address?.toLowerCase();
    if (!r.user || !email || !keep.has(email)) continue;
    const core = r.claude_code_metrics?.core_metrics;
    const tools = Object.values(r.claude_code_metrics?.tool_actions ?? {});
    rows.push({
      id: r.user.id, account: email,
      activity: {
        sessions: core?.distinct_session_count ?? 0, commits: core?.commit_count ?? 0, pullRequests: core?.pull_request_count ?? 0,
        linesAdded: core?.lines_of_code?.added_count ?? 0, linesRemoved: core?.lines_of_code?.removed_count ?? 0,
        toolActions: { accepted: tools.reduce((n, t) => n + (t?.accepted_count ?? 0), 0), rejected: tools.reduce((n, t) => n + (t?.rejected_count ?? 0), 0) },
      },
    });
  }
  return { rows, ...(p.data.next_page ? { next: p.data.next_page } : {}) };
}

/** A cost page: cents per user id. `amount` is a decimal string of cents. */
export function parseCostPage(json: unknown): Page<{ userId: string; cents: number }> {
  const p = COST_PAGE.safeParse(json);
  if (!p.success) return problemOf('analytics cost', p.error);
  const rows: { userId: string; cents: number }[] = [];
  for (const r of p.data.data) {
    const userId = r.group?.actor?.user_id;
    const cents = Number(r.cost.amount);
    if (!userId) continue;
    if (!Number.isFinite(cents)) return { problem: `analytics cost: amount is not a number: ${r.cost.amount.slice(0, 40)}` };
    rows.push({ userId, cents });
  }
  return { rows, ...nextOf(p.data) };
}

/** A usage page: tokens per user id. */
export function parseUsagePage(json: unknown): Page<{ userId: string; tokens: DailyUsage['tokens'] }> {
  const p = USAGE_PAGE.safeParse(json);
  if (!p.success) return problemOf('analytics usage', p.error);
  const rows: { userId: string; tokens: DailyUsage['tokens'] }[] = [];
  for (const r of p.data.data) {
    const userId = r.group?.actor?.user_id;
    if (!userId) continue;
    const u = r.usage;
    rows.push({ userId, tokens: {
      input: u.uncached_input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens,
      cacheCreation: (u.cache_creation?.ephemeral_1h_input_tokens ?? 0) + (u.cache_creation?.ephemeral_5m_input_tokens ?? 0),
    } });
  }
  return { rows, ...nextOf(p.data) };
}

/** One day's read: each kept user with its cost and tokens summed; each account no user matched. */
export function dailyUsageOf(o: {
  date: string; accounts: readonly string[]; users: readonly UserRow[];
  cost: readonly { userId: string; cents: number }[]; tokens: readonly { userId: string; tokens: DailyUsage['tokens'] }[];
}): DailyUsageRead {
  const days: DailyUsage[] = o.users.map((u) => {
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    for (const t of o.tokens.filter((x) => x.userId === u.id)) {
      tokens.input += t.tokens.input; tokens.output += t.tokens.output; tokens.cacheRead += t.tokens.cacheRead; tokens.cacheCreation += t.tokens.cacheCreation;
    }
    const cents = o.cost.filter((c) => c.userId === u.id).reduce((n, c) => n + c.cents, 0);
    return { account: u.account, date: o.date, costCents: Math.round(cents * 100) / 100, tokens, ...u.activity };
  });
  const matched = new Set(days.map((d) => d.account));
  return { date: o.date, days, unmatched: o.accounts.filter((a) => !matched.has(a.toLowerCase())) };
}

/** The newest day an answer of 400 names (`YYYY-MM-DD`) when it is before `date`: the day to read in its place. */
export function newestDayIn(message: string, date: string): string | undefined {
  const days = [...message.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)].map((m) => m[1]!).filter((d) => d < date).sort();
  return days.at(-1);
}
