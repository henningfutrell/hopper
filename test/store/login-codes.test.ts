// One-time UI login codes (design.md "UI session and mutations"): only the code's SHA-256 is kept,
// with an expiry; a code works once.
import { describe, expect, it } from 'vitest';
import { fixedClock, useTempStore } from './helpers.ts';

const t = useTempStore();

describe('login codes', () => {
  it('a stored code is taken once, before it expires', () => {
    const s = t.open(t.url());
    s.loginCodes.create('h1', '2026-10-02T10:10:00.000Z');
    expect(s.loginCodes.take('h1', '2026-10-02T10:05:00.000Z')).toBe(true);
    expect(s.loginCodes.take('h1', '2026-10-02T10:05:00.000Z')).toBe(false);
    s.close();
  });

  it('an expired or unknown code is refused, and expired ones are dropped', () => {
    const s = t.open(t.url(), fixedClock());
    s.loginCodes.create('old', '2026-10-02T10:00:00.000Z');
    s.loginCodes.create('new', '2026-10-02T11:00:00.000Z');
    expect(s.loginCodes.take('old', '2026-10-02T10:00:00.000Z')).toBe(false);
    expect(s.loginCodes.take('nope', '2026-10-02T10:00:00.000Z')).toBe(false);
    expect(s.loginCodes.take('new', '2026-10-02T10:30:00.000Z')).toBe(true);
    s.close();
  });

  it('a code is live until it is taken or expires; asking does not spend it (issue #95)', () => {
    const s = t.open(t.url());
    s.loginCodes.create('h3', '2026-10-02T10:10:00.000Z');
    expect(s.loginCodes.live('h3', '2026-10-02T10:05:00.000Z')).toBe(true);
    expect(s.loginCodes.live('h3', '2026-10-02T10:05:00.000Z')).toBe(true);
    expect(s.loginCodes.live('h3', '2026-10-02T10:10:00.000Z')).toBe(false);
    expect(s.loginCodes.live('nope', '2026-10-02T10:05:00.000Z')).toBe(false);
    expect(s.loginCodes.take('h3', '2026-10-02T10:05:00.000Z')).toBe(true);
    expect(s.loginCodes.live('h3', '2026-10-02T10:05:00.000Z')).toBe(false);
    s.close();
  });

  it('a code minted by one store (the CLI) is taken by another (the daemon)', () => {
    const url = t.url();
    const cli = t.open(url);
    const daemon = t.open(url);
    cli.loginCodes.create('h2', '2099-01-01T00:00:00.000Z');
    cli.close();
    expect(daemon.loginCodes.take('h2', '2026-10-02T10:00:00.000Z')).toBe(true);
    daemon.close();
  });
});
