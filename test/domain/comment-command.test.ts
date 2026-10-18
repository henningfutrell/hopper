// Issue #655, part 21: the nomination by a comment command (Decision N3), `/hopper run|research|propose`.
import { describe, expect, it } from 'vitest';
import { commandOf, isCommand, parseCommand } from '../../src/domain/comment-command.ts';

const comment = (id: number, author: string, body: string, more: { updatedAt?: string; viaApp?: string } = {}) => ({
  id, author, body, createdAt: `2026-10-17T0${id}:00:00Z`, url: `https://github.com/o/r/issues/7#issuecomment-${id}`, updatedAt: `2026-10-17T0${id}:00:00Z`, ...more,
});

describe('parseCommand (issue #655, part 21)', () => {
  it('reads the verb of a first line /hopper run, research or propose, in any case, with spaces around', () => {
    expect(parseCommand('/hopper run')).toBe('run');
    expect(parseCommand('  /Hopper   RESEARCH  \nWhy: the plan is not clear.')).toBe('research');
    expect(parseCommand('\n\n/hopper propose\r\n')).toBe('propose');
  });

  it('reads no other text: another verb, words after the verb, a quote, a command not on the first line', () => {
    for (const body of ['/hopper merge', '/hopper run now', '> /hopper run', 'Please /hopper run', 'Note.\n/hopper run', '/hopperrun', '`/hopper run`', '']) {
      expect(parseCommand(body)).toBeUndefined();
    }
  });

  it('isCommand says whether a text is one', () => {
    expect(isCommand('/hopper run')).toBe(true);
    expect(isCommand('/hopper research\nmore')).toBe(true);
    expect(isCommand('run it')).toBe(false);
  });
});

describe('commandOf (issue #655, part 21)', () => {
  it('is the newest command the login wrote, with its comment', () => {
    const c = commandOf([comment(1, 'me', '/hopper research'), comment(2, 'Me', 'Thanks.'), comment(3, 'ME', '/hopper run')], 'me');
    expect(c).toEqual({ verb: 'run', login: 'ME', at: '2026-10-17T03:00:00Z', url: 'https://github.com/o/r/issues/7#issuecomment-3' });
  });

  it('reads no command of another login', () => {
    expect(commandOf([comment(1, 'stranger', '/hopper run')], 'me')).toBeUndefined();
  });

  it('reads no command edited after it was written: anyone who can edit a comment could have written it', () => {
    expect(commandOf([comment(1, 'me', '/hopper run', { updatedAt: '2026-10-17T05:00:00Z' })], 'me')).toBeUndefined();
    expect(commandOf([comment(1, 'me', '/hopper run'), comment(2, 'me', '/hopper propose', { updatedAt: '2026-10-17T05:00:00Z' })], 'me')?.verb).toBe('run');
  });

  it('reads no command when it is not known whether the comment was edited', () => {
    const { updatedAt: _u, ...unknown } = comment(1, 'me', '/hopper run');
    expect(commandOf([unknown], 'me')).toBeUndefined();
  });

  it('keeps the app a command was written through, so the origin says it is no trusted act', () => {
    expect(commandOf([comment(1, 'me', '/hopper run', { viaApp: 'cursor' })], 'me')).toMatchObject({ verb: 'run', app: 'cursor' });
  });
});
