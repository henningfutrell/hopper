// Sections (issue #543, design.md "Sections"): the categories of things that wait on or involve a person — Questions,
// Proposals, Research, Logins, Failures. Each is declared once here, in nav order: its label, the event types it emits
// (its webhooks are subscriptions to them), and for a review section, its review kind (src/domain/review.ts). What is
// open in each, and how many wait on a person, is counted by GET /api/sections (src/http/sections.ts); the UI's nav
// entries and badges follow the same list. Pure. Re-exported from types.ts.
import { EVENT_TYPES, type EventType } from './event-types.ts';
import type { ReviewKind } from './review.ts';

export const SECTION_KINDS = ['questions', 'proposals', 'research', 'logins', 'failures'] as const;
export type SectionKind = typeof SECTION_KINDS[number];

export interface SectionType {
  kind: SectionKind;
  label: string;
  /** The event types it emits, by their prefixes. */
  events: readonly EventType[];
  /** A review section's review kind (Proposals, Research); absent for the others. */
  review?: ReviewKind;
}

const ofPrefixes = (...prefixes: string[]): EventType[] => EVENT_TYPES.filter((t) => prefixes.some((p) => t.startsWith(`${p}.`)));

export const SECTIONS: Readonly<Record<SectionKind, SectionType>> = {
  questions: { kind: 'questions', label: 'Questions', events: ofPrefixes('question') },
  proposals: { kind: 'proposals', label: 'Proposals', events: ofPrefixes('proposal'), review: 'proposal' },
  research: { kind: 'research', label: 'Research', events: ofPrefixes('research'), review: 'research' },
  logins: { kind: 'logins', label: 'Logins', events: ofPrefixes('auth') },
  failures: { kind: 'failures', label: 'Failures', events: ofPrefixes('failure', 'handoff') },
};

/** One section as GET /api/sections answers it: its open items, the ones waiting on a person, how many of those are high priority. */
export interface SectionSummary { kind: SectionKind; label: string; open: number; waiting: number; high: number; events: EventType[] }
