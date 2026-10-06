// Editing auth.yaml from Settings → Sign-in (design.md "Sign-in: realms", issue #185): one change to
// the document's text — a realm added or replaced from its YAML, removed, moved, turned on or off, or
// local sign-in and no sign-in set. Comments and everything else in the document are kept. Whether the
// result loads is the caller's check (loadAuthDocument), so one schema decides.
import { isMap, isScalar, isSeq, parse, parseDocument, stringify, YAMLSeq, type Document, type YAMLMap } from 'yaml';
import type { RealmType, RealmsEdit, RealmView, UiRole } from '../domain/types.ts';

export class AuthEditError extends Error {
  readonly status: 400 | 404;
  constructor(status: 400 | 404, message: string) { super(message); this.status = status; }
}

type Edit = RealmsEdit extends infer E ? E extends { version: string } ? Omit<E, 'version'> : never : never;

function documentOf(text: string | undefined): Document {
  const doc = parseDocument(text === undefined || text.trim() === '' ? 'version: 1\n' : text);
  if (doc.errors.length) throw new AuthEditError(400, `auth.yaml does not parse: ${doc.errors[0]!.message}`);
  if (!isMap(doc.contents)) throw new AuthEditError(400, 'auth.yaml is not a mapping');
  return doc;
}

function realmsOf(doc: Document): YAMLSeq {
  const seq = doc.get('realms', true);
  if (isSeq(seq)) return seq;
  if (seq !== undefined && seq !== null) throw new AuthEditError(400, 'auth.yaml realms is not a list');
  const fresh = new YAMLSeq();
  doc.set('realms', fresh);
  return fresh;
}

const nameOf = (item: unknown): string | undefined => {
  if (!isMap(item)) return undefined;
  const n = item.get('name');
  return typeof n === 'string' ? n : undefined;
};

function indexOf(seq: YAMLSeq, name: string): number {
  const i = seq.items.findIndex((x) => nameOf(x) === name);
  if (i < 0) throw new AuthEditError(404, `no realm ${name}`);
  return i;
}

/** One realm's YAML as a node of `doc`. */
function entryNode(doc: Document, entry: string): YAMLMap {
  let value: unknown;
  try { value = parse(entry); } catch (e) { throw new AuthEditError(400, `the realm does not parse as YAML: ${(e as Error).message}`); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new AuthEditError(400, 'a realm is a mapping: name, type and its settings');
  return doc.createNode(value) as YAMLMap;
}

/** auth.yaml's text with `edit` made. Throws AuthEditError. */
export function editAuthDocument(text: string | undefined, edit: Edit): string {
  const doc = documentOf(text);
  if (edit.action === 'settings') {
    if (edit.local !== undefined) doc.set('local', doc.createNode({ enabled: edit.local }, { flow: true }));
    if (edit.none !== undefined) {
      if (edit.none === null) doc.delete('none');
      else doc.set('none', doc.createNode({ role: edit.none }, { flow: true }));
    }
    return doc.toString({ lineWidth: 0 });
  }
  const seq = realmsOf(doc);
  if (edit.action === 'save') {
    const node = entryNode(doc, edit.entry);
    const name = nameOf(node);
    if (edit.name === undefined) {
      if (name !== undefined && seq.items.some((x) => nameOf(x) === name)) throw new AuthEditError(400, `a realm ${name} is already there`);
      seq.items.push(node);
    } else {
      const i = indexOf(seq, edit.name);
      // Its sign-ins are linked to users by name, and the identity provider holds its callback URL.
      if (name !== edit.name) throw new AuthEditError(400, `a realm's name stays ${edit.name}: remove it and add a new one to rename it`);
      seq.items[i] = node;
    }
  } else if (edit.action === 'remove') {
    seq.items.splice(indexOf(seq, edit.name), 1);
  } else if (edit.action === 'move') {
    const [item] = seq.items.splice(indexOf(seq, edit.name), 1);
    seq.items.splice(Math.min(edit.to, seq.items.length), 0, item);
  } else {
    const item = seq.items[indexOf(seq, edit.name)] as YAMLMap;
    // On is the default: the field is there only while the realm is off.
    if (edit.enabled) item.delete('enabled');
    else item.set('enabled', false);
  }
  return doc.toString({ lineWidth: 0 });
}

const ROLES: readonly string[] = ['viewer', 'operator', 'admin'];

/** auth.yaml's realms in order, each as its own YAML, and local sign-in and no sign-in, read leniently. */
export function realmsView(text: string | undefined): { local: boolean; none: UiRole | null; realms: Omit<RealmView, 'callback' | 'metadata'>[] } {
  const doc = documentOf(text);
  const local = doc.getIn(['local', 'enabled']);
  const none = doc.getIn(['none', 'role']);
  const seq = doc.get('realms', true);
  const realms = (isSeq(seq) ? seq.items : []).filter(isMap).map((item) => {
    const json = item.toJSON() as Record<string, unknown>;
    const name = String(json.name ?? '');
    const label = isScalar(item.get('label', true)) ? String(json.label) : name;
    return { name, label, type: String(json.type) as RealmType, enabled: json.enabled !== false, entry: stringify(json, { lineWidth: 0 }) };
  });
  return { local: local !== false, none: typeof none === 'string' && ROLES.includes(none) ? none as UiRole : null, realms };
}
