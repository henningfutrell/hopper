// Migration 45 (issue #465): the cloud link's `installId` is the instance id. A link made before took a random id of its
// own at each link, so a link after an unlink was a second instance at hopper.io; the record keeps its account, state and
// who linked it, and takes the instance id, the one a link makes from now on.
import { describe, expect, it } from 'vitest';
import { openInstanceStore } from '../../src/store/index.ts';
import { fixedClock, useTempStore } from './helpers.ts';

const t = useTempStore();

const record = { installId: '0f1e2d3c4b5a69788796a5b4c3d2e1f0', account: 'octo-cat', state: 'pending', linkedAt: '2026-10-17T08:00:00.000Z', by: 'admin' };

describe('migration 45: the cloud link takes the instance id', () => {
  it('a link record from before takes the instance id it has', () => {
    const url = t.url();
    const raw = t.at(url, 44);
    raw.run("INSERT INTO settings (key, value) VALUES ('instanceId', 'a1b2c3d4e5f60718')");
    raw.run("INSERT INTO settings (key, value) VALUES ('cloudLink', ?)", JSON.stringify(record));
    raw.close();
    const instance = openInstanceStore({ url, clock: fixedClock() });
    try {
      expect(instance.settings.getCloudLink()).toEqual({ ...record, installId: 'a1b2c3d4e5f60718' });
      expect(instance.settings.instanceId()).toBe('a1b2c3d4e5f60718');
    } finally {
      instance.close();
    }
  });

  it('a link record with no instance id yet makes the instance id and takes it', () => {
    const url = t.url();
    const raw = t.at(url, 44);
    raw.run("INSERT INTO settings (key, value) VALUES ('cloudLink', ?)", JSON.stringify(record));
    raw.close();
    const instance = openInstanceStore({ url, clock: fixedClock() });
    try {
      const id = instance.settings.instanceId();
      expect(id).toMatch(/^[0-9a-f]{16}$/);
      expect(instance.settings.getCloudLink()).toEqual({ ...record, installId: id });
    } finally {
      instance.close();
    }
  });

  it('no link record stays none, and makes no instance id', () => {
    const url = t.url();
    t.at(url, 44).close();
    const instance = openInstanceStore({ url, clock: fixedClock() });
    try {
      expect(instance.settings.getCloudLink()).toBeUndefined();
    } finally {
      instance.close();
    }
    const raw = t.at(url, 45);
    expect(raw.get("SELECT value FROM settings WHERE key = 'instanceId'")).toBeUndefined();
    raw.close();
  });
});
