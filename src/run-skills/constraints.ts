// What a drafted issue may hold (issues #472, #475, design.md "Run skills"), as one list: each constraint's text goes
// into the file-issue skill's prompt, and its check is what the hopper runs on a draft and on the text the user edited,
// before anything goes to GitHub. One list, so the skill and the check cannot drift. Pure.
import { scanText } from '../promotions/scan.ts';

/** A draft as the check reads it: the model's, or the user's edit of it. */
export interface DraftText { title: string; body: string; labels?: readonly string[] }

export interface DraftConstraint {
  id: string;
  /** The line the skill's prompt carries. */
  text: string;
  /** What the draft breaks; undefined: nothing. */
  check(d: DraftText): string | undefined;
}

export interface DraftFinding { constraint: string; what: string }

export const TITLE_MAX = 120;
export const BODY_MAX = 8000;

const all = (d: DraftText): string => `${d.title}\n${d.body}`;
/** `@login`, not part of an email address or a code span word. */
const MENTION = /(?<![\w.+`-])@[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?![\w@-])/;
const HOPPER_LABEL = /^hopper(?:$|[:@])/i;

export const DRAFT_CONSTRAINTS: readonly DraftConstraint[] = [
  {
    id: 'no-secret',
    text: 'Never include a secret: a token, a key, a password or a private key.',
    check: (d) => (scanText(all(d)).some((f) => f.kind === 'secret') ? 'it holds a secret: a token or a key' : undefined),
  },
  {
    id: 'no-personal-data',
    text: 'Never include personal or machine details: email addresses, phone numbers, IP addresses, host names or home directory paths.',
    check: (d) => (scanText(all(d)).some((f) => f.kind === 'personal') ? 'it holds personal data: an email address, a phone number, an IP address, a private host name or a home directory' : undefined),
  },
  {
    id: 'no-mention',
    text: 'Never name or quote a person, and never mention one with @.',
    check: (d) => (MENTION.test(all(d)) ? 'it mentions a person with @' : undefined),
  },
  {
    id: 'no-hopper-label',
    text: 'Never suggest the label hopper, or a label that starts with hopper: or hopper@.',
    check: (d) => {
      const bad = (d.labels ?? []).filter((l) => HOPPER_LABEL.test(l.trim()));
      return bad.length ? `it has a label the hopper acts on: ${bad.join(', ')}` : undefined;
    },
  },
  {
    id: 'title-size',
    text: `Write a title of at most ${TITLE_MAX} characters.`,
    check: (d) => (d.title.trim() === '' ? 'it has no title' : d.title.length > TITLE_MAX ? `its title is longer than ${TITLE_MAX} characters` : undefined),
  },
  {
    id: 'body-size',
    text: `Write a body of at most ${BODY_MAX} characters.`,
    check: (d) => (d.body.length > BODY_MAX ? `its body is longer than ${BODY_MAX} characters` : undefined),
  },
];

/** What the draft breaks, one finding per constraint. */
export function checkDraft(d: DraftText): DraftFinding[] {
  return DRAFT_CONSTRAINTS.flatMap((c) => {
    const what = c.check(d);
    return what ? [{ constraint: c.id, what }] : [];
  });
}
