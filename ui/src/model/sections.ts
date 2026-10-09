// The sections (issue #543, design.md "Sections"): the categories of things that wait on or involve a person, in the
// server's nav order (src/domain/sections.ts; GET /api/sections). Each has its nav entry and its badge, by one rule:
// the badge counts what is open and waits on a person, seen or not, and stays up while anything is (#499); a
// high-priority job's mark it and say how many (#535). What "open" is stays each section's own.
import { plural } from './failures.ts';
import { REVIEW_UI } from './reviews.ts';
import type { ReviewKind, SectionKind } from './wire.ts';

/** In nav order. A section the server declares and the UI does not list fails the typecheck. */
export const SECTION_KINDS = ['questions', 'proposals', 'research', 'logins', 'failures'] as const satisfies readonly SectionKind[];
const everySection: Exclude<SectionKind, typeof SECTION_KINDS[number]> extends never ? true : never = true;
void everySection;

export interface SectionBadge { n: number; cls: string; title: string; high: number }

/** What each section's badge counts, as the views have it. */
export interface SectionCounts {
  questions: { n: number; high: number };
  reviews: Readonly<Record<ReviewKind, { n: number; high: number }>>;
  logins: { n: number; high: number; warn: boolean };
  failures: { problems: number; handoffs: number; high: number };
}

const highOf = (n: number): string => (n > 0 ? `; ${n} high priority` : '');
const waits = (n: number, noun: string): string => `${plural(n, noun)} ${n === 1 ? 'waits' : 'wait'} on you`;

/** Every section's badge, by the one rule. */
export function sectionBadges(c: SectionCounts): Record<SectionKind, SectionBadge> {
  const review = (k: ReviewKind): SectionBadge => ({ n: c.reviews[k].n, high: c.reviews[k].high, cls: 'bg-question text-background', title: `${waits(c.reviews[k].n, REVIEW_UI[k].noun)}${highOf(c.reviews[k].high)}` });
  return {
    questions: { n: c.questions.n, high: c.questions.high, cls: 'bg-question text-background', title: `${waits(c.questions.n, 'question')}${highOf(c.questions.high)}` },
    proposals: review('proposal'),
    research: review('research'),
    logins: { n: c.logins.n, high: c.logins.high, cls: c.logins.warn ? 'bg-warn text-background' : 'bg-foreground text-background', title: `${waits(c.logins.n, 'login')}${c.logins.warn ? '; one expires soon' : ''}${highOf(c.logins.high)}` },
    failures: { n: c.failures.problems + c.failures.handoffs, high: c.failures.high, cls: 'bg-bad text-background', title: `${plural(c.failures.problems, 'open problem')}, ${plural(c.failures.handoffs, 'job needs', 'jobs need')} a person${highOf(c.failures.high)}` },
  };
}
