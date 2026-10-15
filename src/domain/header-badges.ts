// Header badges (issue #1181, design.md "Header badges"): which of the Dashboard's KPI cards show their total as a badge in
// the header, on every screen. The user's own choice, a viewer's too, kept in the user's settings; one Lanes badge until
// they choose. A badge reads its card's own total, so the two never disagree.

/** The KPI cards a header badge may show, in the cards' order. */
export const HEADER_BADGES = ['inFlight', 'lanes', 'waiting', 'waitingAnswer', 'finished', 'failed'] as const;
export type HeaderBadge = typeof HEADER_BADGES[number];

export interface HeaderBadgeSettings {
  /** In the cards' order, each once; empty: no badge. */
  badges: HeaderBadge[];
}

/** One Lanes badge: the lanes holding a job, busy and draining. */
export const DEFAULT_HEADER_BADGES: HeaderBadgeSettings = { badges: ['lanes'] };

/** The badges in the cards' order, each once; a name no card has (a record from a later build) is left out. */
export const inCardOrder = (badges: readonly string[]): HeaderBadge[] => HEADER_BADGES.filter((b) => badges.includes(b));
