// No config files and no YAML (issue #198, design.md "Config in the database"): the config documents
// — YAML and markdown texts — become config records, JSON values, and the document table goes. Instance
// migration 19 moves auth.yaml to `sign-in`; tenant migration 4 moves plugins.yaml to `plugins` and
// rules.md to `rules`. Persisted state is the user's: a YAML document that does not parse stops the
// migration, nothing changed, rather than being dropped (its comments are not kept: JSON has none).
import { parseDocument } from 'yaml';
import type { Db } from './db.ts';

const CREATE = 'CREATE TABLE config (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)';

/** Each document `from` names becomes the record it maps to: a `.yaml` its value, any other its text. */
export function documentsToRecords(db: Db, from: Record<string, string>): void {
  db.exec(CREATE);
  for (const [document, record] of Object.entries(from)) {
    const row = db.get('SELECT text, updated_at FROM config_documents WHERE name = ?', document);
    if (!row) continue;
    const text = String(row.text);
    let value: unknown = text;
    if (document.endsWith('.yaml')) {
      const doc = parseDocument(text);
      if (doc.errors.length > 0) {
        throw new Error(`${document} does not parse, so it cannot become the config record ${record}; nothing was changed. Fix it in the config_documents table and start again: ${doc.errors[0]!.message}`);
      }
      value = doc.toJS();
      // An empty document (or comments only) held nothing: no record, as if there were none.
      if (value === null || value === undefined) continue;
    }
    db.run('INSERT INTO config (name, value, updated_at) VALUES (?, ?, ?)', record, JSON.stringify(value), String(row.updated_at));
  }
  db.exec('DROP TABLE config_documents');
}
