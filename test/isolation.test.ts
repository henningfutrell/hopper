// Tests never touch the owner's real config or send real webhooks: every worker gets its own HOME,
// and any request to a non-loopback host is refused. 2026-10-04: test daemons sent three
// question.escalated webhooks to the real Grok Bot routine from ~/.config/job-hopper.
import { execFileSync } from 'node:child_process';
import { userInfo, homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { dirname } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { builtinInstances } from '../src/plugins/migrate.ts';
import grokbotRoutine from '../src/plugins/notifier/grokbot-routine/index.ts';
import { parseOptions } from '../src/plugins/options.ts';
import { expandHome } from '../src/plugins/expand-home.ts';

const REAL_HOME = userInfo().homedir; // from the passwd entry, not $HOME

describe('test isolation', () => {
  it('HOME is not the real home, so every ~/ default resolves to a throwaway dir', () => {
    if (process.env.JOB_HOPPER_REAL_HERDR === '1') return; // opt-in real test: Claude needs the real login
    expect(homedir()).not.toBe(REAL_HOME);
    const c = loadConfig({});
    // The Grok Bot env file: the built-in grok-bot instance's (beside plugins.yaml) and the plugin's own default.
    const builtinEnvFile = String(builtinInstances(dirname(c.pluginsFile)).notifiers[0]!.options!.envFile);
    const parsed = parseOptions(grokbotRoutine, {});
    const defaultEnvFile = expandHome(String(parsed.ok ? parsed.options.envFile : ''));
    for (const p of [builtinEnvFile, defaultEnvFile, c.webhooksFile, c.pluginsFile, c.dbPath]) {
      expect(p.startsWith(`${REAL_HOME}/`)).toBe(false);
    }
  });

  it('the real claude never runs: `claude` on PATH is the isolation guard, which answers --version and refuses the rest', () => {
    if (process.env.JOB_HOPPER_REAL_HERDR === '1') return;
    expect(execFileSync('claude', ['--version'], { encoding: 'utf8' })).toMatch(/test isolation/);
    expect(() => execFileSync('claude', ['-p', '/usage', '--output-format', 'json'], { stdio: 'pipe' })).toThrow(/test isolation/);
  });

  it('a request to a non-loopback host is refused before it leaves the process', async () => {
    await expect(fetch('https://example.com/hook', { method: 'POST', body: '{}' })).rejects.toThrow(/non-loopback/);
  });
});
