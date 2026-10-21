// Shared secrets on Vault (issue #718): whose agents may read each one, who set it and when, and the readers
// the hopper's admin types. Only metadata reaches the page: there is no value to show.
import type { SharedSecretView } from './wire.ts';

/** A date and time in the viewer's own form. */
const when = (iso: string): string => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

/** Whose agents may read it: every user's, or the users named. */
export const sharedReadersText = (s: Pick<SharedSecretView, 'readers'>): string =>
  s.readers ? `the agents of ${s.readers.join(', ')}` : 'every user\'s agents';

/** The card's line: who set it last and when, and how it is kept. */
export const sharedSecretLine = (s: SharedSecretView): string => `Set — ${when(s.changedAt)} by ${s.changedBy} · sealed`;

/** The readers typed: user ids, comma- or space-separated, each once; none (undefined) shares with every user. */
export function readersOf(raw: string): string[] | undefined {
  const ids = [...new Set(raw.split(/[\s,]+/).filter(Boolean))];
  return ids.length ? ids : undefined;
}
