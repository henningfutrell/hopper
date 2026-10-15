// Tagged items (issue #1141): what each GitHub source lists of the open issues and pull requests that ask for the user's
// review, mention the user, or are assigned to the user. Tagged lists them per source; Needs you and the nav count them.
import type { TaggedItem, TaggedWhy } from '../../../src/domain/tagged.ts';
import type { SourceStatus } from './wire.ts';

/** Each reason's words on a row. A Record of every reason, so one added in the daemon and not here fails the UI typecheck. */
export const TAGGED_WHY_LABEL: Record<TaggedWhy, string> = { review: 'review requested', mention: 'mentioned', assign: 'assigned' };

/** Whether a source reads tagged items at all: a connected account's GitHub source does. */
export const readsTagged = (s: SourceStatus): boolean => Array.isArray(s.detail?.tagged);

/** A source's tagged items not dismissed, newest change first, or none. */
export const taggedOf = (s: SourceStatus): TaggedItem[] => (readsTagged(s) ? s.detail!.tagged as TaggedItem[] : []);

/** The tagged items across the sources: what Needs you and the nav count. */
export const taggedWaiting = (sources: readonly SourceStatus[]): number => sources.reduce((n, s) => n + taggedOf(s).length, 0);

/** The items a person dismissed that are still tagged. */
export const taggedDismissed = (s: SourceStatus): number => (typeof s.detail?.taggedDismissed === 'number' ? s.detail.taggedDismissed : 0);
