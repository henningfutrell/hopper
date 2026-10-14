// Auto-park (issue #650, design.md "Parked jobs"): a question that waits on a person longer than the park timeout parks
// its job by itself, as the Park button does, so a night of unanswered questions holds no machine. The timer starts when
// the question reaches a person (`escalatedToHumanAt`): time at the escalation levels does not count. One timeout for
// high-priority jobs, one for the rest; 0 turns it off. A question a risk rule or the consequential guard sent to a
// person, and a job waiting on a login, are never parked by it. Pure.

export interface AutoParkSettings {
  /** Minutes a question of a job that is not high priority waits on a person before its job parks; 0: never. */
  minutes: number;
  /** The same, for a high-priority job. */
  highPriorityMinutes: number;
}

export const DEFAULT_AUTO_PARK: AutoParkSettings = { minutes: 30, highPriorityMinutes: 30 };

/** The longest timeout a person may set: a week, in minutes. */
export const MAX_AUTO_PARK_MINUTES = 7 * 24 * 60;

/** The timeout for a job, in minutes; 0: it does not park by itself. */
export const autoParkMinutes = (s: AutoParkSettings, high: boolean): number => (high ? s.highPriorityMinutes : s.minutes);

/** A timeout as people read it: minutes, or seconds below one minute. */
export function autoParkWait(minutes: number): string {
  return minutes >= 1 ? `${Math.round(minutes * 10) / 10} min` : `${Math.round(minutes * 600) / 10} s`;
}

/** What the card and the `job.parked` event say about a job auto-park parked. */
export const autoParkWhy = (minutes: number): string => `Parked automatically: the question waited ${autoParkWait(minutes)}.`;
