// Instance migration 15 (issue #74): attached machines are machine-source instances. Moved out of
// migrations.ts, which holds the list, to keep that file within its size.
import { YAMLSeq, isMap, isSeq, parseDocument, type Document, type Node } from 'yaml';
import type { Db } from './db.ts';

/** An `attachedMachines:` entry as the instance of the plugin its connection names, its other fields its options. */
function attachedInstance(doc: Document, item: unknown): Node {
  const entry = (isMap(item) ? item.toJSON() : {}) as Record<string, unknown>;
  const { name, ...rest } = entry;
  const plugin = 'docker' in rest ? 'docker' : 'client' in rest ? 'client' : 'ssh';
  const options = Object.fromEntries(Object.entries(rest).flatMap(([k, v]): [string, unknown][] => (
    k === 'client' ? [['tokenEnv', (v as { tokenEnv?: unknown } | null)?.tokenEnv]] : [[k, v]])));
  const node = doc.createNode({ name, plugin, options }) as Node & { flow?: boolean };
  node.flow = true;
  if (isMap(item)) {
    node.commentBefore = item.commentBefore;
    node.comment = item.comment;
  }
  return node;
}

/**
 * plugins.yaml with `machines:` as a list: the machine source's instance — the built-in `local` (as
 * it was in issue #74) when the section was absent — then each attached machine as an `ssh`, `docker`
 * or `client` instance. Comments and other sections stay. A document that does not parse is left for
 * the owner (the daemon reports it as before).
 */
export function attachedMachinesToInstances(db: Db): void {
  const row = db.get("SELECT text FROM config_documents WHERE name = 'plugins.yaml'");
  if (!row) return;
  const doc = parseDocument(String(row.text));
  if (doc.errors.length > 0) return;
  const machines = doc.get('machines', true);
  const attached = doc.get('attachedMachines', true);
  if (!isMap(machines) && !doc.has('attachedMachines')) return;
  const first = isMap(machines) ? machines : doc.createNode({ name: 'local', plugin: 'local', options: { lanes: 4 } }, { flow: true });
  const list = new YAMLSeq<unknown>();
  const instances = isSeq(attached) ? attached.items.map((item) => attachedInstance(doc, item)) : [];
  // A comment above the first entry is the list's own; it stays above that entry.
  if (isSeq(attached) && attached.commentBefore && instances[0]) instances[0].commentBefore = attached.commentBefore;
  list.items.push(first, ...instances);
  if (isMap(first)) first.flow = true;
  doc.set('machines', list);
  doc.delete('attachedMachines');
  db.run("UPDATE config_documents SET text = ?, updated_at = ? WHERE name = 'plugins.yaml'", doc.toString({ lineWidth: 0 }), new Date().toISOString());
}
