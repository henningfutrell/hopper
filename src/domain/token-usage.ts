// The token ledger (issue #2302, design.md "The token ledger"): what a job's agent spent, read from its agent session's
// log — the `usage` block of each assistant message, the same data ccusage reads —, never scraped from its terminal.
// Counts and metadata only: no text of the log is kept. Pure.

/** Token counts. `cacheWrite1h`: the part of `cacheWrite` written to the one-hour cache, which costs more. */
export interface TokenCounts { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h?: number }

/** One model's token use: its counts and the assistant messages that spent them (`turns`). */
export interface ModelTokenUse extends TokenCounts { model: string; turns: number }

/** An agent session's token use: per model, by model name, and the times of its first and last counted message. */
export interface SessionTokenUse { models: ModelTokenUse[]; first?: string; last?: string }

/** Token use summed, with its estimated cost; `costKnown` false when a model in it has no known price. */
export interface TokenTotals extends TokenCounts { turns: number; costUsd: number; costKnown: boolean }

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

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * The token use in an agent session's log (JSON lines). Each assistant message counts once — a message is written again as
 * it streams, so the last line of each message id and request id wins —, a synthetic one (`<synthetic>`, the agent's own)
 * not at all. Lines that are not JSON are passed over.
 */
export function sessionTokenUse(log: string): SessionTokenUse {
  const byMessage = new Map<string, { model: string; at?: string; counts: TokenCounts }>();
  for (const text of log.split('\n')) {
    if (!text.includes('"usage"')) continue;
    let o: { type?: unknown; timestamp?: unknown; requestId?: unknown; message?: { id?: unknown; model?: unknown; usage?: Record<string, unknown> } };
    try { o = JSON.parse(text) as typeof o; } catch { continue; }
    const m = o.message, u = m?.usage;
    if (o.type !== 'assistant' || !u || typeof m.model !== 'string' || m.model === '<synthetic>') continue;
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
    total = { ...addCounts(total, u), turns: total.turns + u.turns, costUsd: total.costUsd + (cost ?? 0), costKnown: total.costKnown && cost !== undefined };
  }
  return total;
}
