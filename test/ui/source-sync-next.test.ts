// @vitest-environment happy-dom
// A source's next sync on its card (issue #812): counted down on the daemon's clock, not the browser's, and while a
// sync runs the card says so in place of a stale next time.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { boot, source, unmount } from './sources-daemon.ts';

afterEach(unmount);

const HOUR = 3_600_000;
const sync = () => document.querySelector('[data-source-sync="custom"]')?.textContent ?? '';

/** The daemon's clock an hour ahead of the browser's, as GET /api/logins answers it. */
const logins = () => ({ now: new Date(Date.now() + HOUR).toISOString(), settings: { onExpiry: 'hold', warnSec: 60 }, logins: [] });

describe('Sources view: next sync', () => {
  it('counts down to the next sync on the daemon\'s clock', async () => {
    const nextSyncAt = new Date(Date.now() + HOUR + 30_000).toISOString();
    await boot({ '/api/logins': logins(), '/api/sources': { sources: [{ ...source('custom', 'custom', 'ok', {}), nextSyncAt }] } });
    await vi.waitFor(() => expect(sync()).toMatch(/next in (29|30)s/));
  });

  it('a running sync shows as syncing, with no next time', async () => {
    await boot({ '/api/sources': { sources: [{ ...source('custom', 'custom', 'ok', {}), syncing: true }] } });
    await vi.waitFor(() => expect(sync()).toContain('syncing now'));
    expect(sync()).not.toContain('next');
  });
});
