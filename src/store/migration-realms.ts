// Instance migration 18 (issue #185, design.md "Sign-in: realms"): sign-in is realms. auth.yaml's
// `password` section becomes the first realm, `password`, and its `providers` follow as realms in their
// order, comments kept; stored sessions and identity links name their realm where they named a
// provider. A password sign-in's identity named `password` before, and the realm keeps that name, so
// every session and link keeps working. A document that does not parse is left for the owner (the
// daemon reports it as before).
import { isMap, isSeq, parseDocument, YAMLSeq, type YAMLMap } from 'yaml';
import type { Db } from './db.ts';

function authDocumentToRealms(db: Db): void {
  const row = db.get("SELECT text FROM config_documents WHERE name = 'auth.yaml'");
  if (!row) return;
  const doc = parseDocument(String(row.text));
  if (doc.errors.length || !isMap(doc.contents)) return;
  const password = doc.get('password', true);
  const providers = doc.get('providers', true);
  if (password === undefined && providers === undefined) return;
  const realms = new YAMLSeq();
  if (isMap(password)) {
    const realm = doc.createNode({ name: 'password', label: 'Password', type: 'password', users: [] }) as YAMLMap;
    realm.set('users', password.get('users', true) ?? new YAMLSeq());
    realms.items.push(realm);
  }
  if (isSeq(providers)) {
    realms.items.push(...providers.items);
    realms.commentBefore = providers.commentBefore;
  }
  doc.delete('password');
  doc.delete('providers');
  doc.set('realms', realms);
  db.run("UPDATE config_documents SET text = ?, updated_at = ? WHERE name = 'auth.yaml'", doc.toString({ lineWidth: 0 }), new Date().toISOString());
}

function identitiesNameTheirRealm(db: Db): void {
  db.exec(`
    ALTER TABLE user_identities RENAME COLUMN provider TO realm;
    ALTER TABLE ui_sessions ALTER COLUMN identity SET DEFAULT '{"realm":"local","subject":"local","name":"login code","groups":[]}';
  `);
  for (const r of db.all('SELECT token_hash, identity FROM ui_sessions')) {
    const { provider, ...rest } = JSON.parse(String(r.identity)) as Record<string, unknown>;
    db.run('UPDATE ui_sessions SET identity = ? WHERE token_hash = ?', JSON.stringify({ realm: provider, ...rest }), String(r.token_hash));
  }
}

/** Migration 18. */
export function signInRealms(db: Db): void {
  authDocumentToRealms(db);
  identitiesNameTheirRealm(db);
}
