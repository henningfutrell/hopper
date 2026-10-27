// The completion review setting (issue #2846), apart from settings.ts for its size: a user's key-value setting, absent when
// never set.
import type { CompletionReviewSettings } from '../domain/completion-review.ts';

export function completionReviewSettings(read: (key: string) => string | undefined, write: (key: string, value: string) => void): {
  getCompletionReview(): Partial<CompletionReviewSettings> | undefined;
  setCompletionReview(settings: CompletionReviewSettings): void;
} {
  return {
    getCompletionReview() {
      const text = read('completionReview');
      return text === undefined ? undefined : JSON.parse(text) as Partial<CompletionReviewSettings>;
    },
    setCompletionReview(s) {
      write('completionReview', JSON.stringify({ on: s.on, outcomes: [...s.outcomes], multiJob: s.multiJob, minRunMinutes: s.minRunMinutes }));
    },
  };
}
