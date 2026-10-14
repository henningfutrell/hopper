// Issue #659 requirement 6: a master key rotation seals every value the old keys sealed again under the new key, in
// every schema, in one transaction with the new fingerprint. A value no old key sealed (a KMS data key's, issue #586) is
// left as it is; one an old key sealed that does not open is counted, and left. Anything that fails changes nothing.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ADMIN_ID } from '../../src/domain/types.ts';
import { fingerprintOf } from '../../src/secrets/master-key.ts';
import { createSealer } from '../../src/secrets/sealer.ts';
import { createTokenBox } from '../../src/secrets/token-box.ts';
import { openDb } from '../../src/store/db.ts';
import { openInstanceStore } from '../../src/store/index.ts';
import { installFromBefore, testDatabaseUrl } from '../support/database.ts';

const OLD = randomBytes(32).toString('hex');
const OLDER = randomBytes(32).toString('hex');
const NEW = randomBytes(32).toString('hex');
const DATA_KEY = randomBytes(32).toString('hex');

const userUrl = (url: string): string => {
  const u = new URL(url);
  u.searchParams.set('schema', `${u.searchParams.get('schema')!}_u_admin`);
  return u.toString();
};

function seed(url: string): void {
  const old = createSealer(OLD, [OLDER]);
  const older = createSealer(OLDER);
  const user = openDb(userUrl(url));
  const instance = openDb(url);
  try {
    const add = (db: typeof user, id: string, sealed: string) => db.run('INSERT INTO vault_secrets (id, name, sealed, body) VALUES (?, ?, ?, ?)', id, id, sealed, '{}');
    add(user, 'u1', old.seal('value-u1', 'vault:u1/value'));
    add(user, 'u2', older.seal('value-u2', 'vault:u2/value'));
    add(user, 'kms', createSealer(DATA_KEY).seal('value-kms', 'vault:kms/value'));
    // Sealed under the old key for another place: an old key sealed it, and it does not open.
    add(user, 'moved', old.seal('value-moved', 'vault:elsewhere/value'));
    add(instance, 'i1', old.seal('value-i1', 'vault:i1/value'));
    user.run("INSERT INTO webhooks (id, url, events, active, created_at, name, secret_sealed) VALUES ('w1', 'http://127.0.0.1:1/h', '[]', 1, '2026-10-10', 'w1', ?)",
      old.seal('hook-secret', 'webhook:w1/signing-secret'));
    user.run('INSERT INTO connected_accounts (provider, body) VALUES (?, ?)', 'github',
      JSON.stringify({ provider: 'github', accessToken: createTokenBox(OLD).seal('gho_access'), refreshToken: createTokenBox(OLDER).seal('ghr_refresh') }));
  } finally {
    user.close();
    instance.close();
  }
}

const rows = (url: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const u of [url, userUrl(url)]) {
    const db = openDb(u);
    try {
      for (const r of db.all('SELECT id, sealed FROM vault_secrets')) out[String(r.id)] = String(r.sealed);
      if (u !== url) {
        out.w1 = String(db.get("SELECT secret_sealed FROM webhooks WHERE id = 'w1'")!.secret_sealed);
        out.github = String(db.get("SELECT body FROM connected_accounts WHERE provider = 'github'")!.body);
      }
    } finally { db.close(); }
  }
  return out;
};

const fingerprint = (url: string): string | undefined => {
  const db = openDb(url);
  try { return db.get("SELECT value FROM settings WHERE key = 'masterKeyFingerprint'")?.value as string | undefined; } finally { db.close(); }
};

/** The instance store, with the admin's schema made (as their runtime's start makes it). */
function store(url: string) {
  const s = openInstanceStore({ url: installFromBefore(url), clock: { now: () => new Date('2026-10-10T12:00:00.000Z') } });
  s.userStore(s.users.get(ADMIN_ID)!).close();
  return s;
}

describe('InstanceStore.rotateMasterKey', () => {
  it('seals every value the old keys sealed again under the new key, in every schema, with the new fingerprint', () => {
    const url = testDatabaseUrl();
    const s = store(url);
    try {
      s.settings.setMasterKeyFingerprint(fingerprintOf(OLD));
      seed(url);
      const r = s.rotateMasterKey({ from: { key: OLD, previous: [OLDER] }, to: NEW });
      expect(r).toEqual({ resealed: 6, unreadable: 1 });
      expect(fingerprint(url)).toBe(fingerprintOf(NEW));
      expect(s.settings.masterKeyRotation()).toEqual({ from: fingerprintOf(OLD), at: '2026-10-10T12:00:00.000Z' });

      const after = rows(url);
      const fresh = createSealer(NEW);
      expect(fresh.open(after.u1!, 'vault:u1/value')).toBe('value-u1');
      expect(fresh.open(after.u2!, 'vault:u2/value')).toBe('value-u2');
      expect(fresh.open(after.i1!, 'vault:i1/value')).toBe('value-i1');
      expect(fresh.open(after.w1!, 'webhook:w1/signing-secret')).toBe('hook-secret');
      const body = JSON.parse(after.github!) as { accessToken: string; refreshToken: string };
      expect(createTokenBox(NEW).open(body.accessToken)).toBe('gho_access');
      expect(createTokenBox(NEW).open(body.refreshToken)).toBe('ghr_refresh');
      expect(() => createTokenBox(OLD, [OLDER]).open(body.accessToken)).toThrow();
      // A KMS data key's value, and one that does not open, are left as they were.
      expect(createSealer(DATA_KEY).open(after.kms!, 'vault:kms/value')).toBe('value-kms');
      expect(after.moved!.split('.')[1]).toBe(createSealer(OLD).keyId);
      for (const id of ['u1', 'u2', 'i1', 'w1']) expect(() => createSealer(OLD, [OLDER]).open(after[id]!, id === 'w1' ? 'webhook:w1/signing-secret' : `vault:${id}/value`)).toThrow();
    } finally { s.close(); }
  });

  it('one transaction: an update that fails at the last table changes nothing, the fingerprint included', () => {
    const url = testDatabaseUrl();
    const s = store(url);
    try {
      s.settings.setMasterKeyFingerprint(fingerprintOf(OLD));
      seed(url);
      const before = rows(url);
      // The database refuses the last write a rotation makes: the connected account's row.
      const user = openDb(userUrl(url));
      try {
        user.exec(`CREATE FUNCTION refuse() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'disk full'; END $$ LANGUAGE plpgsql;
          CREATE TRIGGER refuse BEFORE UPDATE ON connected_accounts FOR EACH ROW EXECUTE FUNCTION refuse()`);
      } finally { user.close(); }
      expect(() => s.rotateMasterKey({ from: { key: OLD, previous: [OLDER] }, to: NEW })).toThrow('disk full');
      expect(rows(url)).toEqual(before);
      expect(fingerprint(url)).toBe(fingerprintOf(OLD));
      expect(s.settings.masterKeyRotation()).toBeUndefined();
    } finally { s.close(); }
  });
});
