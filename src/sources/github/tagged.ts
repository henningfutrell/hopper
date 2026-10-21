// Tagged items (issue #1141, design.md "Tagged items"): the open issues and pull requests of the job repositories where the
// user's connected account is a requested reviewer, is @mentioned, or is assigned. Read each intake sync interval, and at
// once on a sync a person asked for; a read that fails keeps the last list and says why. An item with the source's label is
// intake's, and a pull request the user wrote is the user's own work (Pull requests): neither is tagged. Each pull request
// that newly asks for the user's review records `source.review_requested`, once while it asks. What is kept between reads —
// those requests, a person's dismissals and the jobs a person started on an item (issue #2342) — is in the user's
// settings, so a restart records nothing again.
import type { IntakeActionResult, IntakeContext } from '../../domain/intake.ts';
import type { Clock } from '../../domain/ports.ts';
import { NO_TAGGED_RECORD, dismissTagged, mergeTagged, shownTagged, startTagged, taggedRead, type TaggedItem, type TaggedRecord, type TaggedStarted } from '../../domain/tagged.ts';
import type { GitHubApi } from './api.ts';

export function taggedReader(o: { source: string; api: Pick<GitHubApi, 'taggedItems'>; label: string; clock: Clock; everyMs: () => number; intake?: IntakeContext }) {
  let items: TaggedItem[] = [];
  let error: string | undefined;
  let readAt: number | undefined;
  let memory: TaggedRecord = NO_TAGGED_RECORD;
  const kept = (): TaggedRecord => o.intake?.tagged?.get() ?? memory;
  const keep = (r: TaggedRecord) => { memory = r; o.intake?.tagged?.set(r); };
  return {
    /** Read the tagged items of `login` in `repos` when due: each intake sync interval, or at once when `asked`. */
    async read(repos: string[], login: string, asked: boolean): Promise<void> {
      if (!o.api.taggedItems || repos.length === 0) return;
      const now = o.clock.now().getTime();
      if (!asked && readAt !== undefined && now - readAt < o.everyMs()) return;
      try {
        const scope = new Set(repos.map((r) => r.toLowerCase()));
        const label = o.label.toLowerCase();
        const hits = (await o.api.taggedItems(login, repos)).filter((h) => scope.has(h.repo.toLowerCase())
          && !h.labels.some((l) => l.toLowerCase() === label)
          && !(h.kind === 'pull' && h.author.toLowerCase() === login.toLowerCase()));
        items = mergeTagged(hits.map(({ labels: _labels, ...h }) => h));
        const r = taggedRead(kept(), items);
        for (const i of r.newReviews) o.intake?.record('source.review_requested', { source: o.source, key: i.key, author: i.author });
        keep(r.record);
        readAt = now;
        error = undefined;
      } catch (err) {
        error = (err as Error).message;
      }
    },
    /** Dismiss items the last read listed (an intake action, `dismiss`). */
    dismiss(keys: string[]): IntakeActionResult {
      const r = dismissTagged(kept(), items, keys);
      keep(r.record);
      return { done: r.done, failed: r.failed };
    },
    /** Keep the job a person started on an item the last read listed (issue #2342, the intake action `tagged_start`). */
    start(started: TaggedStarted): IntakeActionResult {
      const r = startTagged(kept(), items, started);
      if (r.done.length) keep(r.record);
      return { done: r.done, failed: r.failed };
    },
    /** What `describe` shows: the items not dismissed, how many are, when they were read, and why the last read failed. */
    detail(): Record<string, unknown> {
      if (!o.api.taggedItems) return {};
      const shown = shownTagged(items, kept());
      return {
        tagged: shown, ...(items.length > shown.length ? { taggedDismissed: items.length - shown.length } : {}),
        ...(readAt !== undefined ? { taggedAt: new Date(readAt).toISOString() } : {}), ...(error ? { taggedError: error } : {}),
      };
    },
  };
}
