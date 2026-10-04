import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readGrokBotEnv } from '../../src/plugins/notifier/grokbot-routine/env-file.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'grokbot-env-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (text: string, mode = 0o600): string => {
  const p = join(dir, 'grokbot-webhook.env');
  writeFileSync(p, text, { mode });
  return p;
};

describe('readGrokBotEnv', () => {
  it('an absent file is absent, not an error', () => {
    expect(readGrokBotEnv(join(dir, 'nope.env'))).toEqual({ kind: 'absent' });
  });

  it('reads both variables', () => {
    expect(readGrokBotEnv(write('GROKBOT_WEBHOOK_URL=http://127.0.0.1:1/h\nGROKBOT_WEBHOOK_KEY="k e y"\n')))
      .toEqual({ kind: 'ready', url: 'http://127.0.0.1:1/h', key: 'k e y', looseMode: false });
  });

  it.each([
    ['URL', 'GROKBOT_WEBHOOK_KEY=k\n'],
    ['KEY', 'GROKBOT_WEBHOOK_URL=http://x/\n'],
    ['both', '# nothing\n'],
  ])('a file missing %s is invalid', (_n, text) => {
    const r = readGrokBotEnv(write(text));
    expect(r.kind).toBe('invalid');
  });

  it('an unreadable path (a directory) is invalid', () => {
    expect(readGrokBotEnv(dir).kind).toBe('invalid');
  });

  it('flags a mode readable by group or other, never reporting the key', () => {
    const r = readGrokBotEnv(write('GROKBOT_WEBHOOK_URL=http://x/\nGROKBOT_WEBHOOK_KEY=k\n', 0o644));
    expect(r).toMatchObject({ kind: 'ready', looseMode: true });
  });
});
