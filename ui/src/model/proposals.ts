// Proposals as the UI reads them (issue #537): which wait on a person (the nav badge counts them, seen or not), their
// one order (high-priority jobs' first, then the longest waiting), and the parts as people read them.
import { highFirst } from './priority.ts';
import type { ProposalSection, ProposalView } from './wire.ts';

/** Open and at the human stage: it waits on a person until it is accepted, rejected or sent back. */
export const awaitsDecision = (p: ProposalView): boolean => p.status === 'open' && p.stage === 'human';

/** The open proposals' order, the API's too: high-priority jobs' first, then the longest waiting. */
export const proposalOrder = (ps: ProposalView[]): ProposalView[] =>
  highFirst([...ps].sort((a, b) => a.createdAt.localeCompare(b.createdAt)), (p) => p.high);

/** The badge: how many wait on a person, and how many of those are high priority. */
export const proposalsBadge = (ps: ProposalView[]): { n: number; high: number } => {
  const waiting = ps.filter(awaitsDecision);
  return { n: waiting.length, high: waiting.filter((p) => p.high).length };
};

/** Each part's label, in the order the agent writes them (the protocol's labels). */
export const SECTIONS: ReadonlyArray<[ProposalSection, string]> = [
  ['goal', 'Goal'], ['approach', 'Approach'], ['alternatives', 'Alternatives considered'], ['risks', 'Risks'], ['effort', 'Effort'], ['context', 'Context'],
];
export const sectionLabel = (s: ProposalSection): string => SECTIONS.find(([k]) => k === s)?.[1] ?? s;
