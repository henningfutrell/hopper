// The hopper's own `claude setup-token` (issue #1287, design.md "The hopper's Claude sign-in for pods"): run in a
// pseudo-terminal, as the real CLI prints nothing without one; its URL read from its OSC 8 link; the code written with
// Enter; the token read from what it printed. Each run has a home of its own, removed when it ends. The pty is real
// (`script`); claude is the fake.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupTokenIn, startSetupToken } from '../../src/logins/setup-token.ts';

const CLAUDE = join(import.meta.dirname, 'fake-claude-setup-token.mjs');
const URL = 'https://claude.com/cai/oauth/authorize?code=true&client_id=fake&response_type=code&state=fake-state';
const TOKEN = 'sk-ant-oat01-FakeSetupToken_0123456789abcdefABCDEF-xyz';

let control: string;
let dir: string;
const saved = process.env.CLAUDE_CODE_OAUTH_TOKEN;
beforeEach(() => {
  control = mkdtempSync(join(tmpdir(), 'jh-setup-token-'));
  dir = mkdtempSync(join(tmpdir(), 'jh-setup-token-work-'));
  // The hopper's own environment never reaches the run.
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-TheHoppersOwnTokenNeverPassed';
});
afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN; else process.env.CLAUDE_CODE_OAUTH_TOKEN = saved;
  rmSync(control, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

const calls = () => readFileSync(join(control, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { argv: string[]; home: string; columns: number | null; tty: boolean; oauthToken: boolean });
const start = () => startSetupToken({ file: CLAUDE, dir, env: { FAKE_SETUP_DIR: control } });

describe('startSetupToken: claude setup-token in a pseudo-terminal', () => {
  it('answers the URL of its link; the right code answers the token it printed; its home is gone after', async () => {
    const run = await start();
    expect(run.url).toBe(URL);
    expect(await run.paste('good-code')).toEqual({ ok: true, token: TOKEN });
    const [call] = calls();
    expect(call).toMatchObject({ argv: ['setup-token'], tty: true, oauthToken: false });
    // Wide, so the token is on one line.
    expect(call!.columns).toBeGreaterThanOrEqual(200);
    expect(call!.home.startsWith(dir)).toBe(true);
    expect(existsSync(call!.home)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('a wrong code: why, without the code; nothing kept', async () => {
    const run = await start();
    const end = await run.paste('bad-code-123');
    expect(end).toEqual({ ok: false, reason: expect.stringContaining('OAuth error') });
    expect(JSON.stringify(end)).not.toContain('bad-code-123');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('a run that ends with no token printed: why, and never a token; cancel removes its home', async () => {
    writeFileSync(join(control, 'token'), 'not-a-token');
    const run = await start();
    const end = await run.paste('good-code');
    expect(end).toEqual({ ok: false, reason: 'claude setup-token ended with no token' });
    const again = await start();
    again.cancel();
    await new Promise((r) => setTimeout(r, 300));
    expect(readdirSync(dir)).toEqual([]);
  });

  it('a binary that is not there: the start says so', async () => {
    await expect(startSetupToken({ file: join(control, 'no-claude'), dir, urlMs: 3000 })).rejects.toThrow(/before it showed its URL|showed no URL/);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('setupTokenIn', () => {
  it('reads the token out of colours and line ends; none, undefined', () => {
    expect(setupTokenIn(`Your OAuth token:\r\n\r\n\x1b[33m${TOKEN}\x1b[0m\r\n`)).toBe(TOKEN);
    expect(setupTokenIn('OAuth error')).toBeUndefined();
    expect(setupTokenIn('sk-ant-ort01-ARefreshTokenIsNoSetupToken')).toBeUndefined();
  });
});
