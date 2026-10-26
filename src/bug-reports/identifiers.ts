// Every report loses the obvious identifiers before it is posted (issue #2818, design.md "Report a bug"), pure: email
// addresses, links off the hopper's repository, absolute file paths, host names and long ids. A person's report and a
// job's alike; a job's loses its private work first (`private-work.ts`). What was removed is listed by kind, never by value.
import { HOPPER_ROUTE, HOPPER_URL, keepTrailing, LONG_NUMBER, MASK, UUID, type HopperOwn, type RemovedKind, type Scrubbed } from './private-work.ts';

const URL_RE = /\b[a-z][\w+.-]*:\/\/[^\s<>()"'`\]]+/gi;
const EMAIL = /\b[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\b/g;
/** An absolute path: `/a/b`, `~/a`, or a Windows drive's `C:\a`. A `:line` after it goes with it. */
const ABSOLUTE_PATH = /(?<![\w./~:@-])(?:~?\/[\w.@-]+(?:\/[\w.@-]+)*\/?|[A-Za-z]:\\[^\s"'`<>]*)(?::\d+(?::\d+)?)?/g;
/**
 * A host name: dotted labels under a top-level domain people name hosts with. A list, not every letter pair: code names
 * (`job.queued`, `store.events`) and file names (`package.json`) are no host.
 */
const TLDS = 'com|net|org|io|dev|app|cloud|co|ai|info|biz|xyz|tech|site|online|us|uk|de|eu|fr|nl|ca|au|jp|ch|se|internal|local|lan|home|corp|intranet|private|localdomain|example';
const HOST = new RegExp(`(?<![\\w@.\\/-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${TLDS})(?![\\w-]|\\.\\w)`, 'gi');
/** Host names a report about the hopper may name. */
const PUBLIC_HOSTS = new Set(['github.com', 'api.github.com']);
/** Hex of sixteen digits or more with a digit and a letter, or letters and digits of twenty or more: a key or an id. */
const LONG_HEX = /\b[0-9a-f]{16,}\b/gi;
const LONG_TOKEN = /\b(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{20,}\b/g;

/** `text` with email addresses, links, absolute paths, host names and long ids removed, and the kinds removed. */
export function scrubIdentifiers(text: string, own: Pick<HopperOwn, 'commits'>): Scrubbed {
  const removed = new Set<RemovedKind>();
  const mask = (kind: RemovedKind): string => {
    removed.add(kind);
    return MASK[kind];
  };
  let t = text.replace(URL_RE, keepTrailing((u) => (HOPPER_URL.test(u) ? u : mask('link'))));
  t = t.replace(EMAIL, () => mask('email address'));
  t = t.replace(ABSOLUTE_PATH, keepTrailing((p) => (HOPPER_ROUTE.test(p.replace(/:\d+(?::\d+)?$/, '')) ? p : mask('file path'))));
  t = t.replace(HOST, (h) => (PUBLIC_HOSTS.has(h.toLowerCase()) ? h : mask('host name')));
  t = t.replace(UUID, () => mask('long id'));
  t = t.replace(LONG_HEX, (h) => (/\d/.test(h) && /[a-f]/i.test(h) && !own.commits.has(h.toLowerCase()) ? mask('long id') : h));
  t = t.replace(LONG_TOKEN, (x) => (own.commits.has(x.toLowerCase()) ? x : mask('long id')));
  t = t.replace(LONG_NUMBER, () => mask('long id'));
  return { text: t, removed: [...removed] };
}
