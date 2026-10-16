// Migration 43 (issue #1380, identity keyed by email): a user keeps the verified email it is known by. A user a local
// account signed in as takes that account's email, its subject; a user of any other identity has none until its next
// sign-in with an email its realm vouches for.
import { describe, expect, it } from 'vitest';
import { openInstanceStore } from '../../src/store/index.ts';
import { fixedClock, useTempStore } from './helpers.ts';

const t = useTempStore();

describe('migration 43: a user keeps its email', () => {
  it('a user a local account signed in as takes its email; a user of a GitHub identity has none yet', () => {
    const url = t.url();
    const raw = t.at(url, 42);
    raw.run("INSERT INTO user_identities (realm, subject, user_id) VALUES ('local-accounts', 'ada@example.com', 'admin')");
    raw.run("INSERT INTO user_identities (realm, subject, user_id) VALUES ('github', '42', 'admin')");
    raw.close();

    const instance = openInstanceStore({ url, clock: fixedClock() });
    try {
      expect(instance.users.get('admin')?.email).toBe('ada@example.com');
      expect(instance.users.byEmail('ADA@example.com')?.id).toBe('admin');
      expect(instance.users.byEmail('bea@example.com')).toBeUndefined();
    } finally {
      instance.close();
    }
  });

  it('a user with no local account has no email', () => {
    const url = t.url();
    t.at(url, 42).close();
    const instance = openInstanceStore({ url, clock: fixedClock() });
    try {
      expect(instance.users.get('admin')?.email).toBeUndefined();
    } finally {
      instance.close();
    }
  });
});
