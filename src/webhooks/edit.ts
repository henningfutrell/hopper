// A UI edit of webhooks.yaml (design.md "Webhook subscriptions in the UI", issue #18): add, edit or
// remove one entry. The document stays the source of truth: each edit rewrites only that entry's part
// of it (comments and every other entry as written), against the document's version, then reloads it
// into the store before answering. No secret passes through here (issue #56): an added entry names
// the `WEBHOOK_SECRET_*` variable the runtime gives its secret in.
import { isDeepStrictEqual } from 'node:util';
import { isMap, isScalar, isSeq, parse, parseDocument, stringify, type Document, type Scalar, type YAMLMap } from 'yaml';
import type { ConfigDocuments } from '../domain/ports.ts';
import type { WebhooksEdit } from '../domain/types.ts';
import { UI_SECRET_ENV } from '../domain/webhooks.ts';
import { WEBHOOKS, webhooksFileProblem } from './config.ts';

export type WebhooksEditRefusal = { ok: false; code: 'invalid' | 'not_found' | 'conflict'; error: string };
export type WebhooksEditResult = { ok: true } | WebhooksEditRefusal;

export interface WebhooksEditor {
  edit(e: WebhooksEdit): WebhooksEditResult;
}

const refuse = (code: WebhooksEditRefusal['code'], error: string): WebhooksEditRefusal => ({ ok: false, code, error });

/** One change to webhooks.yaml, applied to the parsed Document (the meaning) and spliced into the text (the bytes). */
type Change =
  | { kind: 'append'; entry: Record<string, unknown> }
  | { kind: 'set'; at: number; key: string; value: unknown }
  | { kind: 'delete'; at: number };

/** A value as YAML text on one line: a scalar as yaml writes it, a list in flow style. */
const inline = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(', ')}]` : stringify(v).trimEnd();

const lineStart = (text: string, pos: number): number => text.lastIndexOf('\n', pos - 1) + 1;
const insertAt = (text: string, pos: number, lines: string): string =>
  text.slice(0, pos) + (pos > 0 && text[pos - 1] !== '\n' ? '\n' : '') + lines + text.slice(pos);

/** The entry's map, the `webhooks` sequence's item `at`. */
const entryMap = (doc: Document, at: number): YAMLMap => doc.getIn(['webhooks', at], true) as YAMLMap;

function applyToDocument(doc: Document, c: Change): void {
  if (c.kind === 'append') {
    const seq = doc.get('webhooks', true);
    if (isSeq(seq) && seq.items.length === 0) seq.flow = false;
    const node = doc.createNode(c.entry) as YAMLMap;
    const events = node.get('events', true);
    if (isSeq(events)) events.flow = true;
    doc.addIn(['webhooks'], node);
  } else if (c.kind === 'set') {
    const node = doc.createNode(c.value);
    if (isSeq(node)) node.flow = true;
    doc.setIn(['webhooks', c.at, c.key], node);
  } else {
    doc.deleteIn(['webhooks', c.at]);
  }
}

/**
 * The text with only the changed entry's bytes rewritten, or undefined for a layout this does not
 * splice (a flow or empty `webhooks` list). Everything outside the change stays as written.
 */
function splice(text: string, doc: Document, c: Change): string | undefined {
  const seq = doc.get('webhooks', true);
  if (!isSeq(seq) || seq.flow || seq.items.length === 0 || !seq.range) return undefined;
  const first = seq.items[0];
  if (!isMap(first) || first.flow || !first.range) return undefined;
  // "  - " before the first key: the item prefix; its width is the indent of the other keys.
  const prefix = text.slice(lineStart(text, first.range[0]), first.range[0]);
  if (!/^ *- +$/.test(prefix)) return undefined;
  const indent = ' '.repeat(prefix.length);
  if (c.kind === 'append') {
    const lines = Object.entries(c.entry).map(([k, v], i) => `${i === 0 ? prefix : indent}${k}: ${inline(v)}\n`).join('');
    return insertAt(text, seq.range[1], lines);
  }
  const map = entryMap(doc, c.at);
  if (map.flow || !map.range) return undefined;
  if (c.kind === 'delete') return text.slice(0, lineStart(text, map.range[0])) + text.slice(map.range[1]);
  const pair = map.items.find((p) => isScalar(p.key) && p.key.value === c.key);
  if (!pair) return insertAt(text, map.range[1], `${indent}${c.key}: ${inline(c.value)}\n`);
  const key = pair.key as Scalar;
  const value = pair.value as { range?: [number, number, number] } | null;
  if (!key.range || !value?.range) return undefined;
  return text.slice(0, key.range[1]) + `: ${inline(c.value)}` + text.slice(value.range[1]);
}

/** True when `text` parses to exactly `js`. */
function means(text: string, js: unknown): boolean {
  try { return isDeepStrictEqual(parse(text), js); } catch { return false; }
}

/** The `webhooks` sequence's entry named `name`, by index, or -1. */
function indexOf(doc: Document, name: string): number {
  const seq = doc.get('webhooks', true);
  return isSeq(seq) ? seq.items.findIndex((item) => isMap(item) && item.get('name') === name) : -1;
}

const CHANGED = `${WEBHOOKS} changed since it was read; reload and edit again`;
const BY_HAND = 'job-hopper config edit webhooks.yaml';

export function createWebhooksEditor(o: {
  documents: ConfigDocuments;
  /** Re-read the document into the store; runs after every write, before the answer. */
  reload(): void;
}): WebhooksEditor {
  const path = WEBHOOKS;

  function edit(e: WebhooksEdit): WebhooksEditResult {
    const original = o.documents.read(WEBHOOKS);
    if (o.documents.version(WEBHOOKS) !== e.version) return refuse('conflict', CHANGED);
    let doc = parseDocument(original ?? 'version: 1\nwebhooks: []\n');
    if (doc.errors.length) return refuse('conflict', `${path} is not valid YAML; fix it by hand (${BY_HAND}): ${doc.errors[0]!.message}`);
    const before = webhooksFileProblem(doc.toJS());
    if (before) return refuse('conflict', `${path} is invalid; fix it by hand (${BY_HAND}): ${before}`);

    const at = indexOf(doc, e.name);
    const changes: Change[] = [];
    if (e.action === 'add') {
      if (!UI_SECRET_ENV.test(e.secretEnv)) return refuse('invalid', `secretEnv: from the UI, a WEBHOOK_SECRET_* variable (A-Z, 0-9, _); ${BY_HAND} names any other`);
      if (at >= 0) return refuse('conflict', `webhook "${e.name}" is already in ${path}`);
      changes.push({ kind: 'append', entry: { name: e.name, url: e.url, events: e.events, secretEnv: e.secretEnv, active: e.active ?? true } });
    } else {
      if (at < 0) return refuse('not_found', `no webhook "${e.name}" in ${path}`);
      if (e.action === 'edit') {
        for (const key of ['url', 'events', 'active'] as const) {
          if (e[key] !== undefined) changes.push({ kind: 'set', at, key, value: e[key] });
        }
      } else {
        changes.push({ kind: 'delete', at });
      }
    }

    // Splice each change into the text; the Document says what the result must mean. A layout the
    // splice does not handle, or a splice that means anything else, is written from the Document
    // instead: comments kept, spacing normalised.
    let text: string | undefined = original;
    for (const c of changes) {
      text = text === undefined ? undefined : splice(text, doc, c);
      applyToDocument(doc, c);
      if (text !== undefined && !means(text, doc.toJS())) text = undefined;
      if (text !== undefined) doc = parseDocument(text);
    }
    const problem = webhooksFileProblem(doc.toJS());
    if (problem) return refuse('invalid', problem);
    // lineWidth 0: never refold lines the owner wrote long.
    if (!o.documents.write(WEBHOOKS, text ?? doc.toString({ lineWidth: 0 }), e.version)) return refuse('conflict', CHANGED);
    o.reload();
    return { ok: true };
  }

  return { edit };
}
