// The TL;DR (issue #569, design.md "TL;DR"): one or two plain sentences a cheap model (Claude Haiku) writes for a long
// card — a question, a proposal, a research report, a hand-off —, on top of the card, the agent's Markdown behind Show
// all. Written once, stored with the card, written again when its text changes; never in the way of the card. Pure.

/** The cards that get one. */
export const TLDR_KINDS = ['question', 'proposal', 'research', 'handoff'] as const;
export type TldrKind = typeof TLDR_KINDS[number];

/** A card's TL;DR as stored with it. */
export interface Tldr {
  /** Plain text: one or two sentences, at most `TLDR_MAX` characters. */
  text: string;
  /** The SHA-256 (hex) of the text it was written from: when the card's text no longer hashes to it, it is stale. */
  of: string;
  /** The model that wrote it, as it named itself. */
  model?: string;
  at: string;
}

/** Whether TL;DRs are written and shown: a user setting, read on every sweep and every read. */
export interface TldrSettings { enabled: boolean }
export const DEFAULT_TLDR: TldrSettings = { enabled: true };

/** The most a TL;DR holds; a longer answer is cut at a word. */
export const TLDR_MAX = 300;

/**
 * The model at its seam: the prompt in, the TL;DR or why there is none out. Never throws. The default is the `claude`
 * CLI in print mode with Haiku (`src/tldr/haiku.ts`); tests put a double here (`UserSeams.tldrWriter`).
 */
export type TldrWriter = (prompt: string, signal: AbortSignal) => Promise<{ text: string; model?: string } | { error: string }>;
