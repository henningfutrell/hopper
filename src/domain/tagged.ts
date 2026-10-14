// Tagged items (issue #1141): the open issues and pull requests of the job repositories where the user's connected account
// is a requested reviewer, is @mentioned, or is assigned — work on GitHub that waits on the person, not on a job. A GitHub
// source reads them each intake sync interval; the UI lists them on Tagged, and Needs you counts them. An item leaves the
// list by itself when it is handled on GitHub (the review given, the pull request merged or closed, the issue closed); a
// person may also **dismiss** one. A dismissal holds only for the reasons the item had then: a new reason shows it again.
// A pull request that newly asks the user for a review records `source.review_requested` once, so it notifies.
import type { ChecksState } from './pull-requests.ts';

/** Why an item is tagged: a review is requested from the user, the user is @mentioned, or the item is assigned to the user. */
export const TAGGED_WHYS = ['review', 'mention', 'assign'] as const;
export type TaggedWhy = typeof TAGGED_WHYS[number];

/** One tagged item, as the last read found it. */
export interface TaggedItem {
  /** Its URL: the item's key. */
  key: string;
  /** owner/repo. */
  repo: string;
  number: number;
  kind: 'issue' | 'pull';
  title: string;
  /** Its author's login; empty when GitHub did not say. */
  author: string;
  /** Every reason it is tagged, in TAGGED_WHYS order; never empty. */
  why: TaggedWhy[];
  createdAt: string;
  updatedAt: string;
  /** A pull request's head commit checks: `none` when it has none. Absent on an issue. */
  checks?: ChecksState | 'none';
  /** A pull request that is a draft. */
  isDraft?: boolean;
}

/** A person's dismissal of one tagged item, for the reasons it had then. */
export interface TaggedDismissal { key: string; why: TaggedWhy[] }

/**
 * What a source keeps of its tagged items between reads, in the user's settings: the pull requests it last saw ask for the
 * user's review (so each new request is recorded once) and the dismissals still in force.
 */
export interface TaggedRecord { reviewRequested: string[]; dismissed: TaggedDismissal[] }

export const NO_TAGGED_RECORD: TaggedRecord = { reviewRequested: [], dismissed: [] };

/** One search hit: the item and the one reason the search asked for. */
export type TaggedHit = Omit<TaggedItem, 'why'> & { why: TaggedWhy };

const byWhy = (a: TaggedWhy, b: TaggedWhy) => TAGGED_WHYS.indexOf(a) - TAGGED_WHYS.indexOf(b);

/** The hits as items: one per key, with every reason it was found for, newest change first. */
export function mergeTagged(hits: readonly TaggedHit[]): TaggedItem[] {
  const out = new Map<string, TaggedItem>();
  for (const h of hits) {
    const seen = out.get(h.key);
    if (seen) { if (!seen.why.includes(h.why)) seen.why = [...seen.why, h.why].sort(byWhy); continue; }
    out.set(h.key, { ...h, why: [h.why] });
  }
  return [...out.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.key.localeCompare(b.key));
}

/**
 * A new read against what was kept: the pull requests that newly ask for the user's review, and the record to keep — the
 * review requests now, and each dismissal cut to the reasons the item still has (one with none left goes).
 */
export function taggedRead(kept: TaggedRecord, items: readonly TaggedItem[]): { record: TaggedRecord; newReviews: TaggedItem[] } {
  const now = new Map(items.map((i) => [i.key, i]));
  const reviews = items.filter((i) => i.why.includes('review'));
  const before = new Set(kept.reviewRequested);
  const dismissed = kept.dismissed.flatMap((d) => {
    const why = d.why.filter((w) => now.get(d.key)?.why.includes(w));
    return why.length ? [{ key: d.key, why }] : [];
  });
  return { record: { reviewRequested: reviews.map((i) => i.key), dismissed }, newReviews: reviews.filter((i) => !before.has(i.key)) };
}

/** The items a person has not dismissed: one with a reason its dismissal does not hold is shown. */
export function shownTagged(items: readonly TaggedItem[], record: TaggedRecord): TaggedItem[] {
  const dismissed = new Map(record.dismissed.map((d) => [d.key, d.why]));
  return items.filter((i) => i.why.some((w) => !dismissed.get(i.key)?.includes(w)));
}

/** Dismiss `keys`, each only while the last read listed it: for every reason it has now. */
export function dismissTagged(record: TaggedRecord, items: readonly TaggedItem[], keys: readonly string[]): { record: TaggedRecord; done: string[]; failed: Record<string, string> } {
  const listed = new Map(items.map((i) => [i.key, i]));
  const done: string[] = [];
  const failed: Record<string, string> = {};
  let dismissed = record.dismissed;
  for (const key of keys) {
    const item = listed.get(key);
    if (!item) { failed[key] = 'not a tagged item the last sync listed'; continue; }
    dismissed = [...dismissed.filter((d) => d.key !== key), { key, why: [...item.why] }];
    done.push(key);
  }
  return { record: { ...record, dismissed }, done, failed };
}
