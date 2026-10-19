// Migration 52 (issue #2039): the cloud link key is Ed25519, so it signs hopper.io's challenge. A link record from before
// names an X25519 key, which cannot sign; no connection ever used it. The record drops it and keeps everything else, so
// the next mint (Rotate key) gives the link an Ed25519 key.
import { describe, expect, it } from 'vitest';
import { openInstanceStore } from '../../src/store/index.ts';
import { fixedClock, useTempStore } from './helpers.ts';

const t = useTempStore();

const record = { installId: 'a1b2c3d4e5f60718', account: 'octo-cat', state: 'registered', linkedAt: '2026-10-17T08:00:00.000Z', registeredAt: '2026-10-17T09:00:00.000Z', by: 'admin' };
const x25519 = { secret: 'cloud-link.key', publicKey: 'b'.repeat(43), createdAt: '2026-10-17T08:00:00.000Z' };

describe('migration 52: the cloud link drops its X25519 key', () => {
  it('a link record with a key from before keeps its fields and drops the key', () => {
    const url = t.url();
    const raw = t.at(url, 51);
    raw.run("INSERT INTO settings (key, value) VALUES ('instanceId', 'a1b2c3d4e5f60718')");
    raw.run("INSERT INTO settings (key, value) VALUES ('cloudLink', ?)", JSON.stringify({ ...record, linkKey: x25519 }));
    raw.close();
    const instance = openInstanceStore({ url, clock: fixedClock() });
    try {
      expect(instance.settings.getCloudLink()).toEqual(record);
    } finally {
      instance.close();
    }
  });

  it('a link record with no key, and no link record, stay as they are', () => {
    const url = t.url();
    const raw = t.at(url, 51);
    raw.run("INSERT INTO settings (key, value) VALUES ('cloudLink', ?)", JSON.stringify(record));
    raw.close();
    const instance = openInstanceStore({ url, clock: fixedClock() });
    try {
      expect(instance.settings.getCloudLink()).toEqual(record);
    } finally {
      instance.close();
    }
    const none = t.url();
    t.at(none, 51).close();
    const empty = t.at(none, 52);
    expect(empty.get("SELECT value FROM settings WHERE key = 'cloudLink'")).toBeUndefined();
    empty.close();
  });
});
