// Tagged items (issue #1141): what each GitHub source lists of the open issues and pull requests that ask for the user's
// review, mention the user, or are assigned to the user. Tagged lists them per source; Needs you and the nav count them,
// but not one a person started a job on (issue #2342).
import type { TaggedItem, TaggedStart, TaggedWhy } from '../../../src/domain/tagged.ts';
import type { SourceStatus } from './wire.ts';

/** Each reason's words on a row. A Record of every reason, so one added in the daemon and not here fails the UI typecheck. */
export const TAGGED_WHY_LABEL: Record<TaggedWhy, string> = { review: 'review requested', mention: 'mentioned', assign: 'assigned' };

/** Whether a source reads tagged items at all: a connected account's GitHub source does. */
export const readsTagged = (s: SourceStatus): boolean => Array.isArray(s.detail?.tagged);

/** A source's tagged items not dismissed, newest change first, or none. */
export const taggedOf = (s: SourceStatus): TaggedItem[] => (readsTagged(s) ? s.detail!.tagged as TaggedItem[] : []);

/** The tagged items across the sources that wait on the person: what Needs you and the nav count. One a person started a job on (issue #2342) waits on that job. */
export const taggedWaiting = (sources: readonly SourceStatus[]): number => sources.reduce((n, s) => n + taggedOf(s).filter((i) => !i.started).length, 0);

/** Each start's words on its button and on the row once started (issue #2342). */
export const TAGGED_START_LABEL: Record<TaggedStart, string> = { research: 'Research', propose: 'Propose', work: 'Start work' };

/** What the row says of the job started on it. */
export function taggedStartedText(s: NonNullable<TaggedItem['started']>): string {
  if (s.start === 'research') return 'Research started';
  if (s.start === 'propose') return 'Proposal started';
  return s.work === 'review' ? 'Review started' : 'Work started';
}

/** The items a person dismissed that are still tagged. */
export const taggedDismissed = (s: SourceStatus): number => (typeof s.detail?.taggedDismissed === 'number' ? s.detail.taggedDismissed : 0);
