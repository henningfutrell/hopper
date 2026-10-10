// Review sections as the UI reads them (issues #537, #543): Proposals and Research, one model. Which items wait on a
// person (the nav badge counts them, seen or not, #499), their one order (high-priority jobs' first, then the longest
// waiting, #535), and what each section is called. The parts and the decisions are the server's: GET /api/<section>
// answers its `type`, and the view offers exactly those.
import { highFirst } from './priority.ts';
import type { ReviewItemView, ReviewKind, ReviewSectionView, ReviewSettingsView } from './wire.ts';

/** The review kinds, in the server's order (research, then the proposal it informs). */
export const REVIEW_KINDS: readonly ReviewKind[] = ['research', 'proposal'];

/** What the UI calls each review section, and where it lives. */
export const REVIEW_UI: Readonly<Record<ReviewKind, {
  section: 'proposals' | 'research'; noun: string; label: string; prefix: string; revising: string; askPath: string; ask: string; parts: string;
}>> = {
  proposal: {
    section: 'proposals', noun: 'proposal', label: 'Proposals', prefix: 'proposal', revising: 'Being revised', askPath: 'propose', ask: 'Propose',
    parts: 'a TL;DR, the problem, a set of paths with their tradeoffs, the recommended one and why, the context it relied on',
  },
  research: {
    section: 'research', noun: 'research report', label: 'Research', prefix: 'research', revising: 'Continuing', askPath: 'research', ask: 'Research',
    parts: 'the question, findings, sources and evidence, confidence, open threads, a next step',
  },
};

/** One review section as the store holds it; settings and type null until read. */
export interface ReviewState { items: ReviewItemView[]; decided: ReviewItemView[]; settings: ReviewSettingsView | null; type: ReviewSectionView | null }
export const EMPTY_REVIEWS: Readonly<Record<ReviewKind, ReviewState>> = {
  proposal: { items: [], decided: [], settings: null, type: null },
  research: { items: [], decided: [], settings: null, type: null },
};

/** Open and at the human stage: it waits on a person until a decision. */
export const awaitsDecision = (p: ReviewItemView): boolean => p.status === 'open' && p.stage === 'human';

/** The open items' order, the API's too: high-priority jobs' first, then the longest waiting. */
export const reviewOrder = (ps: ReviewItemView[]): ReviewItemView[] =>
  highFirst([...ps].sort((a, b) => a.createdAt.localeCompare(b.createdAt)), (p) => p.high);

/** The badge: how many wait on a person, and how many of those are high priority. */
export const reviewBadge = (ps: ReviewItemView[]): { n: number; high: number } => {
  const waiting = ps.filter(awaitsDecision);
  return { n: waiting.length, high: waiting.filter((p) => p.high).length };
};

/** A part's label, as the server declares it. */
export const partLabel = (type: ReviewSectionView, id: string): string => type.parts.find(([k]) => k === id)?.[1] ?? id;

/** The item's headline: its newest version's first part, else its item's title. */
export const headlineOf = (p: ReviewItemView, type: ReviewSectionView | null): string | undefined => {
  const first = type?.parts[0]?.[0];
  return (first ? p.versions.at(-1)?.sections[first] : undefined) ?? p.source?.title;
};

/** A research report's open threads, one per line or `;`, list marks aside: what Dig deeper can name. */
export function openThreadsOf(text: string | undefined): string[] {
  if (!text) return [];
  const lines = text.split('\n').map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean);
  return (lines.length === 1 ? lines[0]!.split(';') : lines).map((t) => t.trim()).filter(Boolean);
}

/** Dig deeper's notes: the threads chosen, then anything typed. */
export const digDeeperNotes = (threads: string[], typed: string): string =>
  [threads.length > 0 ? `Dig deeper on these open threads:\n${threads.map((t) => `- ${t}`).join('\n')}` : '', typed.trim()].filter(Boolean).join('\n\n');
