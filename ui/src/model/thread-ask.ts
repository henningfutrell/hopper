// Asking on the issue thread in the UI (issue #435), pure: what each policy does, the summary of the settings, the change
// a save sends, and what a question's thread record says on its card.
import type { Question, ThreadAskPolicy, ThreadAskSettings } from './wire.ts';

export const POLICY_LABELS: Readonly<Record<ThreadAskPolicy, string>> = {
  post: 'Post at once',
  review: 'Hold for my review',
  off: 'Do not post',
};

const DOES: Readonly<Record<ThreadAskPolicy, string>> = {
  post: 'post the question on the issue at once',
  review: 'hold the question until you approve it',
  off: 'keep the question in the hopper',
};

/** What is on now, in one sentence. */
export function threadAskSummary(s: ThreadAskSettings): string {
  if (s.ownRepos === s.otherRepos) return s.ownRepos === 'off' ? 'Off: no question goes on an issue thread.' : `In every repository, the hopper will ${DOES[s.ownRepos]}.`;
  return `In your own repositories, the hopper will ${DOES[s.ownRepos]}; in other repositories, it will ${DOES[s.otherRepos]}.`;
}

/** The change a save sends: only what differs; undefined: nothing to save. */
export function threadAskPatch(s: ThreadAskSettings, d: ThreadAskSettings): Partial<ThreadAskSettings> | undefined {
  const patch: Partial<ThreadAskSettings> = {
    ...(d.ownRepos === s.ownRepos ? {} : { ownRepos: d.ownRepos }),
    ...(d.otherRepos === s.otherRepos ? {} : { otherRepos: d.otherRepos }),
  };
  return Object.keys(patch).length > 0 ? patch : undefined;
}

/** What a question's card says of its place on the issue thread; undefined: it is not asked there. */
export function threadLine(q: Pick<Question, 'thread'>): string | undefined {
  const t = q.thread;
  if (!t) return undefined;
  if (t.state === 'review') return 'Held for your review before it goes on the issue thread.';
  if (t.state === 'approved') return 'Approved: it goes on the issue thread at the next sync.';
  return 'Asked on the issue thread: a reply there answers it.';
}

/** Whether a person may approve it for the thread now. */
export const awaitsThreadReview = (q: Pick<Question, 'status' | 'thread'>): boolean => q.status === 'open' && q.thread?.state === 'review';
