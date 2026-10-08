// A failure's signature (issue #509): its error text normalised — colour codes, URLs, times, ids, paths and
// numbers stripped, case and spaces folded — and hashed. One cause on many jobs is one signature. Pure.
import { createHash } from 'node:crypto';

const MAX = 400;

/** In order: each runs on what the ones before left. */
const STRIP: readonly [RegExp, string][] = [
  // eslint-disable-next-line no-control-regex
  [/\u001b\[[0-9;?]*[A-Za-z]/g, ''],
  [/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>'],
  [/(~|\.{1,2})?(\/[^\s/'"`,;:()[\]{}<>]+)+\/?/g, '<path>'],
  [/\b\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(z|[+-]\d{2}:?\d{2})?/gi, '<time>'],
  [/\b\d{1,2}:\d{2}(:\d{2})?\b/g, '<time>'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>'],
  // A hex run with a digit in it: a hash or an id, never a word.
  [/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/gi, '<id>'],
  [/\d+(\.\d+)?/g, '<n>'],
];

/** The error text with what varies between jobs stripped; at most 400 characters. */
export function normalise(text: string): string {
  let out = text;
  for (const [re, to] of STRIP) out = out.replace(re, to);
  return out.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, MAX);
}

/** The normalised text and its signature: the first 12 hex digits of its SHA-256. */
export function signatureOf(text: string): { normalised: string; signature: string } {
  const normalised = normalise(text);
  return { normalised, signature: createHash('sha256').update(normalised).digest('hex').slice(0, 12) };
}
