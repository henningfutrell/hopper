// The post key (issue #1591, design.md "Posted once"): a promotion or a bug report keeps its row before GitHub is asked
// for a new issue or comment, and the text it posts ends with the row's key as a hidden line. Before a create, the hopper
// looks for that key on GitHub: a stop, or a timeout after GitHub made it, links what GitHub made, never a second. Pure.

/**
 * A resend key's form (issues #1607, #2813): the caller's own key for one filing, the same each time it sends it again —
 * `hopper-gh` makes one for each issue create, comment, pull request create and bug report, and sends it again when no
 * answer came; the Report a bug form and File an issue make one for each form. The same key again is answered what the
 * first send made, and nothing is filed twice.
 */
export const RESEND_KEY = /^[A-Za-z0-9_-]{8,64}$/;

/** The hidden line: GitHub shows no HTML comment. */
export const postKeyLine = (key: string): string => `<!-- hopper post ${key} -->`;

/** The text as posted: its post key line at the end. */
export const withPostKey = (text: string, key: string): string => `${text}\n\n${postKeyLine(key)}`;

/** Whether a text GitHub answered carries the post key. */
export const hasPostKey = (text: string | null | undefined, key: string): boolean =>
  (text ?? '').split('\n').some((l) => l.trim() === postKeyLine(key));

/** How long before the row was kept a look-up reads from: GitHub's clock and the hopper's differ. */
export const POST_KEY_LOOKBACK_MS = 60 * 60_000;

/** Where a look-up for a row kept at `at` reads from (GitHub's `since`). */
export const postKeySince = (at: string): string => new Date(Date.parse(at) - POST_KEY_LOOKBACK_MS).toISOString();
