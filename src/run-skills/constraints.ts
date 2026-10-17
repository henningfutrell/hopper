// What a drafted issue may hold (issues #472, #475, design.md "Run skills" and "Draft constraints"), as one list: each
// constraint's text goes into the file-issue skill's prompt, and its check is what the hopper runs on a draft and on the
// text the user edited, before anything goes to GitHub. One list, so the skill and the check cannot drift. The draft is
// masked before the user sees it (`maskDraft`), every change named by its constraint and never by its value; the
// context the user attaches is masked the same way before it is sent (`maskContext`); a request or a draft over a size
// limit is refused with the reason, never cut. Pure.
import { cleanText, scanText } from '../promotions/scan.ts';
import { maskSecrets } from '../secrets/mask.ts';

/** A draft as the check reads it: the model's, or the user's edit of it, with the repository the user chose. */
export interface DraftText { repo: string; title: string; body: string; labels?: readonly string[] }

/**
 * What one user's drafts are checked against (issue #475), given by the caller: never the model's to choose.
 * `repos`: the repositories a draft may target, the user's job repositories. `known`: names that must not appear —
 * the user's machine and host names, their connected GitHub logins, their display name and email —, matched as words,
 * case-insensitive. `secrets`: the values of secrets the hopper holds, matched by value; a finding never shows one.
 */
export interface DraftScope { repos: readonly string[]; known?: readonly string[]; secrets?: readonly string[] }

export interface DraftConstraint {
  id: string;
  /** The line the skill's prompt carries. */
  text: string;
  /** What the draft breaks; undefined: nothing. */
  check(d: DraftText, scope: DraftScope): string | undefined;
}

export interface DraftFinding { constraint: string; what: string }

/** What a mask changed: the constraint and how many times, never the value. */
export interface DraftMask { constraint: string; count: number }

export const TITLE_MAX = 120;
export const BODY_MAX = 8000;
/** The most of the user's own text one draft takes. */
export const TEXT_MAX = 10_000;
/** The most attached context one draft sends to the model. */
export const CONTEXT_MAX = 20_000;
/** The labels a draft may suggest. Never one the hopper acts on. */
export const SUGGESTED_LABELS = ['bug', 'enhancement', 'documentation', 'question'] as const;

/** A known name shorter than this is no finding: it would match common words. */
const KNOWN_MIN = 3;
/** A held secret shorter than this is no finding: it would match ordinary text. */
const SECRET_MIN = 8;

const all = (d: DraftText): string => `${d.title}\n${d.body}`;
/** `@login`, not part of an email address or a code span word. */
const MENTION = /(?<![\w.+`-])@[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?![\w@-])/g;
const HOPPER_LABEL = /^hopper(?:$|[:@])/i;
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const knownOf = (scope: DraftScope): string[] => [...new Set((scope.known ?? []).map((k) => k.trim()).filter((k) => k.length >= KNOWN_MIN))];
const secretsOf = (scope: DraftScope): string[] => [...new Set((scope.secrets ?? []).filter((s) => s.length >= SECRET_MIN))];
/** A known name as a word: not inside a longer name. */
const knownPattern = (k: string): RegExp => new RegExp(`(?<![\\w.-])${escape(k)}(?![\\w-]|\\.\\w)`, 'gi');
const sameRepo = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Why a draft may not target `repo`: it is not one of the scope's; undefined: it may. */
export const repoRefusal = (repo: string, scope: DraftScope): string | undefined =>
  (scope.repos.some((r) => sameRepo(r, repo)) ? undefined : `${repo} is not one of your job repositories: pick one of them`);

export const DRAFT_CONSTRAINTS: readonly DraftConstraint[] = [
  {
    id: 'repo-allowed',
    text: 'Write the issue for the target repository below only. Do not name another repository as the target.',
    check: (d, s) => repoRefusal(d.repo, s),
  },
  {
    id: 'no-secret',
    text: 'Never include a secret: a token, a key, a password or a private key.',
    check: (d, s) => (scanText(all(d)).some((f) => f.kind === 'secret') || secretsOf(s).some((v) => all(d).includes(v))
      ? 'it holds a secret: a token or a key' : undefined),
  },
  {
    id: 'no-personal-data',
    text: 'Never include personal or machine details: email addresses, phone numbers, IP addresses, host names or home directory paths.',
    check: (d) => (scanText(all(d)).some((f) => f.kind === 'personal') ? 'it holds personal data: an email address, a phone number, an IP address, a private host name or a home directory' : undefined),
  },
  {
    id: 'no-known-name',
    text: 'Never name the user, their accounts, their machines or their host names.',
    check: (d, s) => (knownOf(s).some((k) => knownPattern(k).test(all(d))) ? 'it names the user, one of their accounts, machines or host names' : undefined),
  },
  {
    // The model's mentions are removed; one the user adds when they edit the draft is refused at filing (issue #471).
    id: 'no-mention',
    text: 'Never name or quote a person, and never mention one with @.',
    check: (d) => (new RegExp(MENTION.source).test(all(d)) ? 'it mentions a person with @' : undefined),
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
    id: 'label-allowed',
    text: `Suggest labels only from this list: ${SUGGESTED_LABELS.join(', ')}.`,
    check: (d) => {
      const bad = (d.labels ?? []).filter((l) => !HOPPER_LABEL.test(l.trim()) && !(SUGGESTED_LABELS as readonly string[]).includes(l.trim()));
      return bad.length ? `it has a label not in the list: ${bad.join(', ')}` : undefined;
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

/** What the draft breaks, one finding per constraint. Run it on the model's draft and again on the text the user files. */
export function checkDraft(d: DraftText, scope: DraftScope): DraftFinding[] {
  return DRAFT_CONSTRAINTS.flatMap((c) => {
    const what = c.check(d, scope);
    return what ? [{ constraint: c.id, what }] : [];
  });
}

/** Why a request may not be sent to the model: the user's text or the context is over its limit; undefined: it may. */
export function checkRequest(r: { text: string; context?: string }): string | undefined {
  if (r.text.trim() === '') return 'say what the issue is about';
  if (r.text.length > TEXT_MAX) return `your text is longer than ${TEXT_MAX} characters: shorten it`;
  if ((r.context?.length ?? 0) > CONTEXT_MAX) return `the context is longer than ${CONTEXT_MAX} characters: attach less`;
  return undefined;
}

/** How many masks `text` holds: each mask the scan writes ends `masked]` or `(masked)`. */
const marks = (text: string): number => text.match(/masked[\])]/g)?.length ?? 0;

/** `text` with every match of `re` replaced, and how many there were. */
function replaced(text: string, re: RegExp, by: string | ((m: string) => string)): [string, number] {
  let n = 0;
  const out = text.replace(re, (m) => { n += 1; return typeof by === 'string' ? by : by(m); });
  return [out, n];
}

/**
 * `text` cleaned of what the constraints forbid in prose: held secrets by value, then secret patterns and personal data
 * (the promotion scan), known names as words, and, with `mentions`, every `@` mention. Each change is counted by the
 * constraint it serves.
 */
function maskText(text: string, scope: DraftScope, mentions: boolean): [string, Map<string, number>] {
  const counts = new Map<string, number>();
  const add = (id: string, n: number) => { if (n) counts.set(id, (counts.get(id) ?? 0) + n); };
  let out = text;
  for (const v of secretsOf(scope)) {
    const parts = out.split(v);
    add('no-secret', parts.length - 1);
    out = parts.join('[secret, masked]');
  }
  const before = marks(out);
  const unsecret = maskSecrets(out);
  const clean = cleanText(unsecret);
  add('no-secret', marks(unsecret) - before);
  add('no-personal-data', marks(clean) - marks(unsecret));
  out = clean;
  for (const k of knownOf(scope)) {
    const [next, n] = replaced(out, knownPattern(k), '[name, masked]');
    add('no-known-name', n);
    out = next;
  }
  if (mentions) {
    const [next, n] = replaced(out, MENTION, '[mention, removed]');
    add('no-mention', n);
    out = next;
  }
  return [out, counts];
}

const listOf = (counts: Map<string, number>): DraftMask[] => [...counts].map(([constraint, count]) => ({ constraint, count }));

/**
 * The model's draft as the user first sees it (issue #475, enforcement: mask and show): secrets, personal data, known
 * names and `@` mentions masked in its title and body, and every label it may not suggest dropped. `masks` names
 * each change by its constraint, never its value, so the review step and the record can show it. The repository and the
 * size are not masked: `checkDraft` still finds them, and the draft is refused, not cut.
 */
export function maskDraft<D extends DraftText>(d: D, scope: DraftScope): { draft: D; masks: DraftMask[] } {
  const [title, t] = maskText(d.title, scope, true);
  const [body, b] = maskText(d.body, scope, true);
  for (const [id, n] of t) b.set(id, (b.get(id) ?? 0) + n);
  const kept = (d.labels ?? []).filter((l) => (SUGGESTED_LABELS as readonly string[]).includes(l.trim()));
  const dropped = (d.labels ?? []).length - kept.length;
  const hopper = (d.labels ?? []).filter((l) => HOPPER_LABEL.test(l.trim())).length;
  if (hopper) b.set('no-hopper-label', hopper);
  if (dropped - hopper) b.set('label-allowed', dropped - hopper);
  return { draft: { ...d, title, body, ...(d.labels ? { labels: kept } : {}) }, masks: listOf(b) };
}

/**
 * What the user attached, cleaned before it goes to the model (issue #475, "What the run may read"): the same masks as a
 * draft's, `@` mentions kept (they are the context's, and the draft's own are removed after). The user sees it so.
 */
export function maskContext(context: string, scope: DraftScope): { text: string; masks: DraftMask[] } {
  const [text, counts] = maskText(context, scope, false);
  return { text, masks: listOf(counts) };
}
