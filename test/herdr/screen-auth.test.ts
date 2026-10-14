// Issue #476: a job that waits on a login ends its turn with HOPPER_AUTH_PENDING and the login's fields. The
// screen reads it as a login, never as a question, and keeps its code out of the job's progress line.
import { describe, expect, it } from 'vitest';
import { PROTOCOL_LINES } from '../../src/job-rules/index.ts';
import { FOOTER_ANCHOR, readTurn } from '../../src/executors/herdr/screen.ts';

const ECHO = ['❯ Push the branch.', `  ${FOOTER_ANCHOR}`];
const AUTH = [
  '● Bash(gh auth login --web > /tmp/x 2>&1 &)',
  '  ⎿  Running in the background',
  '● gh needs a login: it shows a device code.',
  '  HOPPER_AUTH_PENDING',
  '  tool: gh',
  '  url: https://github.com/login/device',
  '  code: WDJB-MJHT',
  '  expires_in: 900',
];
const END = ['✻ Worked for 4s', '──────────────', '❯ ', '──────────────'];
const screen = (...parts: string[][]): string => parts.flat().join('\n');

describe('the login marker', () => {
  it('the protocol tells a job how to report a login, before the turn anchor', () => {
    expect(PROTOCOL_LINES.some((l) => l.includes('HOPPER_AUTH_PENDING') && l.includes('url:') && l.includes('code:'))).toBe(true);
    expect(FOOTER_ANCHOR).toContain('HOPPER_FAILED');
  });

  it('a turn that ends with it is a login, with its fields', () => {
    const turn = readTurn(screen(ECHO, AUTH, END), FOOTER_ANCHOR);
    expect(turn.lastMarker).toBe('auth');
    expect(turn.auth).toEqual({ tool: 'gh', url: 'https://github.com/login/device', code: 'WDJB-MJHT', expires_in: '900' });
  });

  it('its fields and its code never become the progress line', () => {
    const turn = readTurn(screen(ECHO, AUTH, END), FOOTER_ANCHOR);
    expect(turn.lastLine).toBe('gh needs a login: it shows a device code.');
    expect(turn.assistantText).not.toContain('WDJB-MJHT');
  });

  it('markdown around the marker and the field names, as an agent may write them, still reads', () => {
    const fancy = AUTH.map((l) => l.replace('HOPPER_AUTH_PENDING', '**HOPPER_AUTH_PENDING**').replace('  url:', '  - URL:'));
    expect(readTurn(screen(ECHO, fancy, END), FOOTER_ANCHOR).auth).toMatchObject({ tool: 'gh', url: 'https://github.com/login/device' });
  });

  it('once the job goes on and writes more, the old login is no marker: the turn is a status note, or its new marker', () => {
    const more = ['● The login went through; pushing now.'];
    expect(readTurn(screen(ECHO, AUTH, more, END), FOOTER_ANCHOR).lastMarker).toBeNull();
    expect(readTurn(screen(ECHO, AUTH, ['● Pushed.', '  HOPPER_DONE'], END), FOOTER_ANCHOR).lastMarker).toBe('done');
  });
});
