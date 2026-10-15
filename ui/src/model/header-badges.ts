// Header badges (issue #1181): the Dashboard's KPI cards the viewer picks show their totals in the header, on every
// screen. A badge reads its card's own total (`cardTotals`, which the cards read too), so a badge and its card never
// disagree. One Lanes badge until the viewer chooses: the lanes holding a job, busy and draining.
import type { Kpis } from './board.ts';
import type { HeaderBadge, HeaderBadgeSettings, InFlight } from './wire.ts';

/** Each card a badge may show, in the cards' order, with its words. */
export const BADGES: Record<HeaderBadge, { title: string; words: (n: number) => string }> = {
  inFlight: { title: 'In flight', words: () => 'in flight' },
  lanes: { title: 'Lanes', words: (n) => (n === 1 ? 'lane in use' : 'lanes in use') },
  waiting: { title: 'Waiting', words: () => 'waiting' },
  waitingAnswer: { title: 'On a question', words: () => 'on a question' },
  finished: { title: 'Finished', words: () => 'finished in 24 h' },
  failed: { title: 'Failed', words: () => 'failed' },
};

const ORDER = Object.keys(BADGES) as HeaderBadge[];

export const DEFAULT_HEADER_BADGES: readonly HeaderBadge[] = ['lanes'];

/** Each card's total: the number it shows, and its badge's. In flight is the work-item ledger's count (issue #1164). */
export function cardTotals(k: Kpis, inFlight: InFlight | null): Record<HeaderBadge, number> {
  return {
    inFlight: inFlight?.total ?? 0, lanes: k.lanesBusy, waiting: k.waiting, waitingAnswer: k.waitingAnswer, finished: k.finished, failed: k.failed,
  };
}

/** The badges the header shows: the saved choice in the cards' order; the default until one is read. */
export const shownBadges = (s: HeaderBadgeSettings | undefined): readonly HeaderBadge[] => {
  const badges = s?.badges;
  return Array.isArray(badges) ? ORDER.filter((b) => badges.includes(b)) : DEFAULT_HEADER_BADGES;
};

/** The choice with one badge turned on or off, in the cards' order. */
export const toggleBadge = (shown: readonly HeaderBadge[], b: HeaderBadge, on: boolean): HeaderBadge[] =>
  ORDER.filter((x) => (x === b ? on : shown.includes(x)));
