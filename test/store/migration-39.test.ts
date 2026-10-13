// Migration 39 (issue #968): remote access names its provider. A record from before is ngrok's, and its domain is the one
// its tunnel runs at, with the authtoken given by hand: kept as `provisioned`, so remote access goes on running.
import { describe, expect, it } from 'vitest';
import { openInstanceStore } from '../../src/store/index.ts';
import { fixedClock, useTempStore } from './helpers.ts';

const t = useTempStore();

const after = (before: object | undefined) => {
  const url = t.url();
  const raw = t.at(url, 38);
  if (before !== undefined) raw.run("INSERT INTO settings (key, value) VALUES ('remoteAccess', ?)", JSON.stringify(before));
  raw.close();
  const instance = openInstanceStore({ url, clock: fixedClock() });
  const settings = instance.settings.getRemoteAccess();
  instance.close();
  return settings;
};

describe('migration 39: remote access names its provider', () => {
  it('a record from before is ngrok\'s, its domain the one its tunnel runs at', () => {
    expect(after({ enabled: true, domain: 'h.example.ngrok.app', restartedAt: '2026-10-12T00:00:00.000Z' })).toEqual({
      enabled: true, provider: 'ngrok', domain: 'h.example.ngrok.app', restartedAt: '2026-10-12T00:00:00.000Z',
      provisioned: { provider: 'ngrok', domain: 'h.example.ngrok.app' },
    });
    expect(after({ enabled: false })).toEqual({ enabled: false, provider: 'ngrok' });
  });

  it('no record stays none', () => {
    expect(after(undefined)).toBeUndefined();
  });
});
