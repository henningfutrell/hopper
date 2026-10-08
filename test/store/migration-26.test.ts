// Migration 26 (issue #423): the update channels are dev, beta and stable. A hopper set to main or
// release, the two stable channels from before, is set to stable; dev and beta stay as they were.
import { describe, expect, it } from 'vitest';
import { openInstanceStore } from '../../src/store/index.ts';
import { fixedClock, useTempStore } from './helpers.ts';

const t = useTempStore();

const channelAfter = (before: string | undefined): string | undefined => {
  const url = t.url();
  const raw = t.at(url, 25);
  if (before !== undefined) raw.run("INSERT INTO settings (key, value) VALUES ('updateChannel', ?), ('autoUpdate', 'true')", before);
  raw.close();
  const instance = openInstanceStore({ url, clock: fixedClock() });
  const settings = instance.settings.getUpdateSettings();
  instance.close();
  if (before !== undefined) expect(settings.autoUpdate).toBe(true);
  return settings.channel;
};

describe('migration 26: the update channels dev, beta and stable', () => {
  it('main and release become stable', () => {
    expect(channelAfter('main')).toBe('stable');
    expect(channelAfter('release')).toBe('stable');
  });

  it('dev and beta stay', () => {
    expect(channelAfter('dev')).toBe('dev');
    expect(channelAfter('beta')).toBe('beta');
  });

  it('no channel set stays unset', () => {
    expect(channelAfter(undefined)).toBeUndefined();
  });
});
