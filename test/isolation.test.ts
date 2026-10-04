// Tests never touch the owner's real config or send real webhooks: every worker gets its own HOME,
// and any request to a non-loopback host is refused. 2026-10-04: test daemons sent three
// question.escalated webhooks to the real Grok Bot routine from ~/.config/job-hopper.
import { userInfo, homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';

const REAL_HOME = userInfo().homedir; // from the passwd entry, not $HOME

describe('test isolation', () => {
  it('HOME is not the real home, so every ~/ default resolves to a throwaway dir', () => {
    if (process.env.JOB_HOPPER_REAL_HERDR === '1') return; // opt-in real test: Claude needs the real login
    expect(homedir()).not.toBe(REAL_HOME);
    const c = loadConfig({});
    for (const p of [c.grokbotWebhookFile, c.webhooksFile, c.pluginsFile, c.dbPath]) {
      expect(p.startsWith(`${REAL_HOME}/`)).toBe(false);
    }
  });

  it('a request to a non-loopback host is refused before it leaves the process', async () => {
    await expect(fetch('https://example.com/hook', { method: 'POST', body: '{}' })).rejects.toThrow(/non-loopback/);
  });
});
