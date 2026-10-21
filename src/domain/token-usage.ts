// The token ledger (issue #2302, design.md "The token ledger"): what a job's agent spent, read from its agent session's
// log — the `usage` block of each assistant message, the same data ccusage reads —, never scraped from its terminal.
// Counts and metadata only: no text of the log is kept. Pure.

/** Token counts. `cacheWrite1h`: the part of `cacheWrite` written to the one-hour cache, which costs more. */
export interface TokenCounts { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h?: number }

/**
 * One model's token use: its counts and the assistant messages that spent them (`turns`). `failedTests`: the local test
 * runs its messages started that failed (part 4, a waste signal); absent when none.
 */
export interface ModelTokenUse extends TokenCounts { model: string; turns: number; failedTests?: number }

/** An agent session's token use: per model, by model name, and the times of its first and last counted message. */
export interface SessionTokenUse { models: ModelTokenUse[]; first?: string; last?: string }

/** Token use summed, with its estimated cost; `costKnown` false when a model in it has no known price. */
export interface TokenTotals extends TokenCounts { turns: number; costUsd: number; costKnown: boolean; failedTests?: number }

/** List prices in US dollars per million tokens: input, output, cache read. A cache write is 1.25 × input (5 minutes), 2 × (an hour). */
const PRICES: Record<string, readonly [number, number, number]> = {
  'claude-fable-5-1': [10, 50, 0.25], 'claude-mythos-5-1': [10, 50, 0.25], 'claude-fable-5': [10, 50, 1], 'claude-mythos-5': [10, 50, 1],
  'claude-opus-5-5': [4, 20, 0.2], 'claude-opus-5': [5, 25, 0.5], 'claude-opus-4-8': [5, 25, 0.5], 'claude-opus-4-7': [5, 25, 0.5],
  'claude-opus-4-6': [5, 25, 0.5], 'claude-opus-4-5': [5, 25, 0.5], 'claude-opus-4-1': [15, 75, 1.5], 'claude-opus-4': [15, 75, 1.5],
  'claude-sonnet-5-5': [2, 10, 0.2], 'claude-sonnet-5': [2, 10, 0.2], 'claude-sonnet-4-6': [3, 15, 0.3], 'claude-sonnet-4-5': [3, 15, 0.3],
  'claude-sonnet-4': [3, 15, 0.3], 'claude-haiku-4-5': [1, 5, 0.1], 'claude-3-5-haiku': [0.8, 4, 0.08],
};

/** A model id as the price list names it: no provider prefix, no date, no context marker. */
const priceKey = (model: string): string => model.replace(/^(anthropic\.|us\.anthropic\.)/, '').replace(/\[[^\]]*\]$/, '').replace(/[-@]\d{8}$/, '').replace(/-v\d+(:\d+)?$/, '');

/** The estimated cost in US dollars of `t` on `model` at list price; undefined when the model has no known price. */
export function estimatedCostUsd(model: string, t: TokenCounts): number | undefined {
  const p = PRICES[priceKey(model)];
  if (!p) return undefined;
  const [input, output, read] = p;
  const hour = Math.min(t.cacheWrite1h ?? 0, t.cacheWrite);
  return (t.input * input + t.output * output + t.cacheRead * read + (t.cacheWrite - hour) * input * 1.25 + hour * input * 2) / 1_000_000;
}

/** A shell command that runs a test suite: its failure is a failed test run. Only the count is kept, never the command. */
const TEST_RUN = /(^|[\s;&|(])(npx |pnpm |yarn |bunx? )?(vitest|jest|mocha|pytest|playwright test|rspec|go test|cargo test|dotnet test|mvn( -\S+)* test|gradle test|(npm|pnpm|yarn|bun) (run )?test)\b/;

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * The token use in an agent session's log (JSON lines). Each assistant message counts once — a message is written again as
 * it streams, so the last line of each message id and request id wins —, a synthetic one (`<synthetic>`, the agent's own)
 * not at all. Lines that are not JSON are passed over. A shell command that runs tests and whose tool result is an error is a
 * failed test run, counted on the model that ran it.
 */
export function sessionTokenUse(log: string): SessionTokenUse {
  const byMessage = new Map<string, { model: string; at?: string; counts: TokenCounts }>();
  /** Each test run started, by its tool use id: the model that ran it. */
  const testRuns = new Map<string, string>();
  const failed = new Set<string>();
  for (const text of log.split('\n')) {
    if (text.includes('"tool_result"') && text.includes('"is_error":true')) {
      try {
        const content = (JSON.parse(text) as { message?: { content?: unknown } }).message?.content;
        if (Array.isArray(content)) for (const b of content as { type?: unknown; tool_use_id?: unknown; is_error?: unknown }[]) if (b.type === 'tool_result' && b.is_error === true && typeof b.tool_use_id === 'string') failed.add(b.tool_use_id);
      } catch { /* not JSON */ }
      continue;
    }
    if (!text.includes('"usage"')) continue;
    let o: { type?: unknown; timestamp?: unknown; requestId?: unknown; message?: { id?: unknown; model?: unknown; usage?: Record<string, unknown> } };
    try { o = JSON.parse(text) as typeof o; } catch { continue; }
    const m = o.message, u = m?.usage;
    if (o.type !== 'assistant' || !u || typeof m.model !== 'string' || m.model === '<synthetic>') continue;
    const content = (m as { content?: unknown }).content;
    if (Array.isArray(content)) {
      for (const b of content as { type?: unknown; id?: unknown; name?: unknown; input?: { command?: unknown } }[]) {
        if (b.type === 'tool_use' && b.name === 'Bash' && typeof b.id === 'string' && typeof b.input?.command === 'string' && TEST_RUN.test(b.input.command)) testRuns.set(b.id, m.model);
      }
    }
    const hour = (u.cache_creation as Record<string, unknown> | undefined)?.ephemeral_1h_input_tokens;
    const counts: TokenCounts = { input: num(u.input_tokens), output: num(u.output_tokens), cacheRead: num(u.cache_read_input_tokens), cacheWrite: num(u.cache_creation_input_tokens), ...(num(hour) ? { cacheWrite1h: num(hour) } : {}) };
    const key = `${typeof m.id === 'string' ? m.id : byMessage.size}:${typeof o.requestId === 'string' ? o.requestId : ''}`;
    // A message is when it was first written.
    const at = byMessage.get(key)?.at ?? (typeof o.timestamp === 'string' ? o.timestamp : undefined);
    byMessage.set(key, { model: m.model, ...(at ? { at } : {}), counts });
  }
  const models = new Map<string, ModelTokenUse>();
  let first: string | undefined, last: string | undefined;
  for (const { model, at, counts } of byMessage.values()) {
    const was = models.get(model) ?? { model, turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    models.set(model, { ...addCounts(was, counts), model, turns: was.turns + 1 });
    if (at && (!first || at < first)) first = at;
    if (at && (!last || at > last)) last = at;
  }
  for (const [id, model] of testRuns) {
    const was = models.get(model);
    if (was && failed.has(id)) was.failedTests = (was.failedTests ?? 0) + 1;
  }
  return { models: [...models.values()].sort((a, b) => a.model.localeCompare(b.model)), ...(first ? { first } : {}), ...(last ? { last } : {}) };
}

function addCounts<T extends TokenCounts>(a: T, b: TokenCounts): T {
  const hour = (a.cacheWrite1h ?? 0) + (b.cacheWrite1h ?? 0);
  return { ...a, input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, ...(hour ? { cacheWrite1h: hour } : {}) };
}

/** Model uses summed, each one's cost estimated at its own model's price. */
export function sumTokenUse(uses: readonly ModelTokenUse[]): TokenTotals {
  let total: TokenTotals = { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, costKnown: true };
  for (const u of uses) {
    const cost = estimatedCostUsd(u.model, u);
    const failedTests = (total.failedTests ?? 0) + (u.failedTests ?? 0);
    total = { ...addCounts(total, u), turns: total.turns + u.turns, costUsd: total.costUsd + (cost ?? 0), costKnown: total.costKnown && cost !== undefined, ...(failedTests ? { failedTests } : {}) };
  }
  return total;
}

/**
 * One row of the token ledger: one model's use in one agent session of one job, as last read. `machineId`, `laneId`: where
 * it was read last; `account`: who that machine's agent tool was last read signed in as, then (the label only, never a token).
 */
export interface TokenLedgerEntry extends ModelTokenUse { jobId: string; session: string; readAt: string; machineId?: string; laneId?: string; account?: string; first?: string; last?: string }

/** Where and when a session's use was read: its machine and lane, and that machine's account then. */
export interface TokenReadAt { readAt: string; machineId?: string | undefined; laneId?: string | undefined; account?: string | undefined }

export interface TokenLedgerRepository {
  /** A session's use, in place of the one read before: the log only grows, so the last read is the whole session. */
  put(jobId: string, session: string, use: SessionTokenUse, at: TokenReadAt): void;
  /** The rows of one job, or of the sessions whose last counted message is at or after `since`; oldest first. */
  list(q?: { jobId?: string; since?: string }): TokenLedgerEntry[];
}

/** What a rollup groups the ledger by. `day`: the UTC day of a session's last counted message. */
export const TOKEN_GROUPS = ['job', 'issue', 'repo', 'machine', 'lane', 'account', 'model', 'day'] as const;
export type TokenGroup = (typeof TOKEN_GROUPS)[number];

/**
 * One group of a rollup: its key (`(none)` when the ledger does not say), its totals and how many jobs it holds. `parts`:
 * when the rollup is split by a second group, the group's rows summed per that group, the costliest first; they sum to it.
 */
export interface TokenRollupRow extends TokenTotals { key: string; jobs: number; parts?: TokenRollupRow[] }

/** What a rollup needs to know of a job: its repository and its issue (`owner/name#N`). */
export interface JobTokenFacts { repo?: string | undefined; issue?: string | undefined }

const NONE = '(none)';

/** The ledger's rows summed per group, the costliest first, then by key; with `split`, each group split by that one too. */
export function tokenRollup(entries: readonly TokenLedgerEntry[], by: TokenGroup, facts: (jobId: string) => JobTokenFacts | undefined, split?: TokenGroup): TokenRollupRow[] {
  const keyOf = (e: TokenLedgerEntry): string | undefined => {
    switch (by) {
      case 'job': return e.jobId;
      case 'issue': return facts(e.jobId)?.issue;
      case 'repo': return facts(e.jobId)?.repo;
      case 'machine': return e.machineId;
      case 'lane': return e.laneId;
      case 'account': return e.account;
      case 'model': return e.model;
      case 'day': return (e.last ?? e.readAt).slice(0, 10);
    }
  };
  const groups = new Map<string, { rows: TokenLedgerEntry[]; jobs: Set<string> }>();
  for (const e of entries) {
    const key = keyOf(e) ?? NONE;
    const g = groups.get(key) ?? { rows: [], jobs: new Set<string>() };
    g.rows.push(e);
    g.jobs.add(e.jobId);
    groups.set(key, g);
  }
  return [...groups].map(([key, g]) => ({ key, ...sumTokenUse(g.rows), jobs: g.jobs.size, ...(split ? { parts: tokenRollup(g.rows, split, facts) } : {}) }))
    .sort((a, b) => b.costUsd - a.costUsd || a.key.localeCompare(b.key));
}

/**
 * A job's token use, as its page and `GET /api/jobs/:id/tokens` show it: totals, per model, and where it was read.
 * `waste`: its waste signals (part 4, `src/domain/token-waste.ts`), which the route adds.
 */
export interface JobTokenView { jobId: string; total: TokenTotals; models: (TokenTotals & { model: string })[]; sessions: number; machines: string[]; accounts: string[]; first?: string; last?: string; waste?: import('./token-waste.ts').TokenWaste[] }

/** One job's ledger rows as its view. */
export function jobTokenView(jobId: string, entries: readonly TokenLedgerEntry[]): JobTokenView {
  const firsts = entries.flatMap((e) => (e.first ? [e.first] : [])).sort(), lasts = entries.flatMap((e) => (e.last ? [e.last] : [])).sort();
  const distinct = (xs: (string | undefined)[]): string[] => [...new Set(xs.filter((x): x is string => x !== undefined))].sort();
  return {
    jobId, total: sumTokenUse(entries), sessions: new Set(entries.map((e) => e.session)).size,
    models: tokenRollup(entries, 'model', () => undefined).map(({ key, jobs: _, ...t }) => ({ model: key, ...t })),
    machines: distinct(entries.map((e) => e.machineId)), accounts: distinct(entries.map((e) => e.account)),
    ...(firsts[0] ? { first: firsts[0] } : {}), ...(lasts.length > 0 ? { last: lasts.at(-1)! } : {}),
  };
}
