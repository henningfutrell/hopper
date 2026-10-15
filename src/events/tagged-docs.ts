// The tagged items' event docs (issue #1141): part of EVENT_DOCS (docs.ts), apart for its size.
export const TAGGED_EVENT_DOCS: Record<'source.review_requested', string> = {
  'source.review_requested': 'A pull request in a job repository newly asks for the user\'s review (issue #1141): a **tagged item** for the reason `review`. `key` is its URL, `author` who wrote it. Recorded once while the request stands: after the user reviews it, a new request records it again. Never the text. It shows on Tagged; webhook subscribers get it like any event.',
};
