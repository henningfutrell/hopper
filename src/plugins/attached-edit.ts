// A machine edit (design.md "Machines from the UI", issue #18): add, edit or remove one entry of
// plugins.yaml `attachedMachines:`. The new text is spliced into the document at that entry's source
// range, so every other byte — other sections, other entries, comments — stays as written. The
// result is parsed and checked against the plugins.yaml schema before it replaces the document,
// against the version the edit was read at.
// The ssh target must be a detected one; herdrBin is resolved over ssh here, never sent.
import { isMap, isScalar, isSeq, parseDocument, stringify, type Document, type Node, type YAMLMap, type YAMLSeq } from 'yaml';
import type { ConfigDocuments } from '../domain/ports.ts';
import type { AttachedMachine, MachineEdit } from '../domain/types.ts';
import { BY_HAND, PLUGINS, pluginsFileProblem } from './plugins-file.ts';
import type { EditRefusal, EditResult } from './edit.ts';

export interface MachineEditContext {
  documents: ConfigDocuments;
  /** The machine source's instance name: an attached machine may not take it. */
  machineName: string;
  /** The configured executor instance names. */
  executors: readonly string[];
  sshTargets(): { targets: string[] };
  /** herdr's absolute path on that ssh target; rejects with the reason. */
  resolveHerdrBin(ssh: string): Promise<string>;
  /** Jobs that need the machine: on a busy or draining lane there, or parked in a pane there. */
  inUse(name: string): string[];
}

const KEY = 'attachedMachines';
const DEFAULT_EXECUTORS = ['herdr-claude'];

const refuse = (code: EditRefusal['code'], error: string): EditRefusal => ({ ok: false, code, error });

/** A plain value as one entry, flow (`{ name: x, … }`) or block lines indented to `indent`. */
function render(entry: Record<string, unknown>, flow: boolean, indent: number): string {
  if (flow) return stringify(entry, { collectionStyle: 'flow', lineWidth: 0 }).trimEnd();
  const lines = stringify(entry, { collectionStyle: 'block', lineWidth: 0 }).trimEnd().split('\n');
  return lines.map((l, i) => (i === 0 ? l : ' '.repeat(indent) + l)).join('\n');
}

const lineStart = (text: string, at: number): number => text.lastIndexOf('\n', at - 1) + 1;
/** Where a node's own text ends: a block node's range runs on over the newline after it. */
const endOf = (text: string, node: Node): number => {
  let end = node.range![1];
  while (end > node.range![0] && /\s/.test(text[end - 1]!)) end -= 1;
  return end;
};
const lineEnd = (text: string, at: number): number => {
  const nl = text.indexOf('\n', at);
  return nl < 0 ? text.length : nl + 1;
};

/** The entries as a block list written after `key:`, replacing whatever value was there. */
function asBlockList(text: string, doc: Document, entries: Record<string, unknown>[]): string {
  const pair = (doc.contents as YAMLMap).items.find((p) => isScalar(p.key) && p.key.value === KEY)!;
  const keyNode = pair.key as Node;
  const value = pair.value as Node | null;
  const from = text.indexOf(':', keyNode.range![1]) + 1;
  let to = value?.range ? value.range[1] : from;
  while (to > from && /\s/.test(text[to - 1]!)) to -= 1;
  const indent = keyNode.range![0] - lineStart(text, keyNode.range![0]) + 2;
  const body = entries.length
    ? entries.map((e) => `\n${' '.repeat(indent)}- ${render(e, true, 0)}`).join('')
    : ' []';
  return text.slice(0, from) + body + text.slice(to);
}

/** The whole file with `entry` added to the attached machines. */
function spliceAdd(text: string, doc: Document, entry: Record<string, unknown>): string {
  const seq = doc.get(KEY, true);
  if (!doc.has(KEY)) {
    return `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${KEY}:\n  - ${render(entry, true, 0)}\n`;
  }
  if (!isSeq(seq) || seq.flow || seq.items.length === 0) {
    return asBlockList(text, doc, [...(isSeq(seq) ? (seq.toJSON() as Record<string, unknown>[]) : []), entry]);
  }
  const first = seq.items[0] as Node;
  const last = seq.items.at(-1) as Node;
  const dashAt = lineStart(text, first.range![0]);
  const dashIndent = text.slice(dashAt).search(/\S/);
  const flow = isMap(first) && first.flow === true;
  const at = lineEnd(text, endOf(text, last) - 1);
  const head = at === text.length && !text.endsWith('\n') ? '\n' : '';
  return `${text.slice(0, at)}${head}${' '.repeat(dashIndent)}- ${render(entry, flow, dashIndent + 2)}\n${text.slice(at)}`;
}

/** The whole file with entry `at` replaced (`next`) or removed (`null`). */
function spliceEntry(text: string, doc: Document, seq: YAMLSeq, at: number, next: Record<string, unknown> | null): string {
  if (seq.flow) {
    const all = seq.toJSON() as Record<string, unknown>[];
    return asBlockList(text, doc, next ? all.map((e, i) => (i === at ? next : e)) : all.filter((_, i) => i !== at));
  }
  const node = seq.items[at] as Node;
  const start = node.range![0];
  const end = endOf(text, node);
  if (next) {
    const flow = isMap(node) && node.flow === true;
    return text.slice(0, start) + render(next, flow, start - lineStart(text, start)) + text.slice(end);
  }
  if (seq.items.length === 1) return asBlockList(text, doc, []);
  return text.slice(0, lineStart(text, start)) + text.slice(lineEnd(text, end - 1));
}

/** Plain fields, in the order the owner writes them; absent ones left out. */
function entryOf(m: Partial<Record<keyof AttachedMachine, unknown>>): Record<string, unknown> {
  const order = ['name', 'label', 'ssh', 'lanes', 'executors', 'session', 'herdrBin'] as const;
  return Object.fromEntries(order.filter((k) => m[k] !== undefined).map((k) => [k, m[k]]));
}

function unknownExecutors(list: readonly string[] | undefined, ctx: MachineEditContext): string | undefined {
  const missing = (list ?? DEFAULT_EXECUTORS).filter((x) => !ctx.executors.includes(x));
  if (missing.length === 0) return undefined;
  return `${missing.join(', ')}: not ${missing.length === 1 ? 'an executor instance' : 'executor instances'} in plugins.yaml (configured: ${ctx.executors.join(', ') || 'none'})`;
}

interface Read { text: string; doc: Document; seq: YAMLSeq | undefined; entries: Record<string, unknown>[] }

const CHANGED = `${PLUGINS} changed since it was read; reload and edit again`;

function readFile(ctx: MachineEditContext, version: string): Read | EditRefusal {
  const text = ctx.documents.read(PLUGINS);
  if (ctx.documents.version(PLUGINS) !== version) return refuse('conflict', CHANGED);
  if (text === undefined) return refuse('conflict', `${PLUGINS} is missing; restart the daemon to write it`);
  const doc = parseDocument(text);
  if (doc.errors.length) return refuse('conflict', `${PLUGINS} is not valid YAML; fix it by hand (${BY_HAND}): ${doc.errors[0]!.message}`);
  const problem = pluginsFileProblem(doc.toJS());
  if (problem) return refuse('conflict', `${PLUGINS} is invalid; fix it by hand (${BY_HAND}): ${problem}`);
  const seq = doc.get(KEY, true);
  return { text, doc, seq: isSeq(seq) ? seq : undefined, entries: isSeq(seq) ? (seq.toJSON() as Record<string, unknown>[]) : [] };
}

function writeChecked(ctx: MachineEditContext, text: string, version: string): EditResult {
  const problem = pluginsFileProblem(parseDocument(text).toJS());
  if (problem) return refuse('invalid', problem);
  if (!ctx.documents.write(PLUGINS, text, version)) return refuse('conflict', CHANGED);
  return { ok: true, changed: true };
}

export async function applyMachineEdit(e: MachineEdit, ctx: MachineEditContext): Promise<EditResult> {
  const r = readFile(ctx, e.version);
  if ('ok' in r) return r;
  const at = r.entries.findIndex((m) => m.name === e.name);

  if (e.action === 'add') {
    if (!ctx.sshTargets().targets.includes(e.ssh)) return refuse('invalid', `ssh target ${e.ssh} is not a Host alias in ~/.ssh/config; add it there first`);
    if (e.name === ctx.machineName) return refuse('invalid', `${e.name} is this machine; name an attached machine something else`);
    if (at >= 0) return refuse('conflict', `machine ${e.name} is already attached`);
    const bad = unknownExecutors(e.executors, ctx);
    if (bad) return refuse('invalid', bad);
    const draft = entryOf({ name: e.name, label: e.label, ssh: e.ssh, lanes: e.lanes, executors: e.executors });
    const early = pluginsFileProblem({ ...r.doc.toJS(), [KEY]: [...r.entries, draft] });
    if (early) return refuse('invalid', early);
    let herdrBin: string;
    try {
      herdrBin = await ctx.resolveHerdrBin(e.ssh);
    } catch (err) {
      return refuse('conflict', `cannot resolve herdr on ${e.ssh}, machine not added: ${err instanceof Error ? err.message : String(err)}`);
    }
    // The probe takes seconds: the document may have changed meanwhile.
    const again = readFile(ctx, e.version);
    if ('ok' in again) return again;
    return writeChecked(ctx, spliceAdd(again.text, again.doc, { ...draft, herdrBin }), e.version);
  }

  if (at < 0 || !r.seq) return refuse('not_found', `no attached machine named ${e.name}`);
  if (e.action === 'remove') {
    const jobs = ctx.inUse(e.name);
    if (jobs.length) return refuse('conflict', `${e.name} still has jobs (${jobs.join(', ')}): wait for them to end, or cancel them, then remove it`);
    return writeChecked(ctx, spliceEntry(r.text, r.doc, r.seq, at, null), e.version);
  }

  const bad = e.executors ? unknownExecutors(e.executors, ctx) : undefined;
  if (bad) return refuse('invalid', bad);
  const current = r.entries[at]!;
  const next: Record<string, unknown> = { ...current };
  if (e.lanes !== undefined) next.lanes = e.lanes;
  if (e.executors !== undefined) next.executors = e.executors;
  if (e.label === null) delete next.label;
  else if (e.label !== undefined) next.label = e.label;
  if (JSON.stringify(next) === JSON.stringify(current)) return { ok: true, changed: false };
  return writeChecked(ctx, spliceEntry(r.text, r.doc, r.seq, at, entryOf(next)), e.version);
}
