// Issue #476: each CLI's real device-code output (captured from the CLI itself, the code replaced by one of
// the same shape) is recognised as a device login, and its code can be hidden wherever the output goes.
import { describe, expect, it } from 'vitest';
import { hideCodes, recogniseDeviceCode } from '../../src/logins/recognise.ts';

/** `gh auth login --web`, gh 2.102.0, stdin not a terminal: what it prints while it polls. */
const GH = [
  '',
  '! Failed to copy one-time code to clipboard',
  '  No clipboard utilities available. Please install xsel, xclip, wl-clipboard or Termux:API add-on for termux-clipboard-get/set.',
  '! First copy your one-time code: WDJB-MJHT',
  'Open this URL to continue in your web browser: https://github.com/login/device',
].join('\n');

/** The same, on a terminal: gh waits for Enter before it opens the browser. */
const GH_TTY = [
  '! First copy your one-time code: WDJB-MJHT',
  'Press Enter to open https://github.com/login/device in your browser... ',
].join('\n');

/** `codex login --device-auth`, codex-cli 0.161.0, with its colours. */
const CODEX = [
  'Welcome to Codex [v\x1b[90m0.161.0\x1b[0m]',
  '\x1b[90mOpenAI\'s command-line coding agent\x1b[0m',
  '',
  'Follow these steps to sign in with ChatGPT using device code authorization:',
  '',
  '1. Open this link in your browser and sign in to your account',
  '   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m',
  '',
  '2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m',
  '   \x1b[94mABCD-EFGHJ\x1b[0m',
  '',
  '\x1b[90mContinue only if you started this login in Codex. If a website or another person gave you this code, cancel.\x1b[0m',
].join('\n');

describe('device-code recognisers', () => {
  it("recognises gh's device code, its URL, and GitHub's 15 minutes", () => {
    expect(recogniseDeviceCode(GH)).toEqual({ tool: 'gh', verificationUrl: 'https://github.com/login/device', userCode: 'WDJB-MJHT', expiresInSec: 900 });
    expect(recogniseDeviceCode(GH_TTY)).toEqual({ tool: 'gh', verificationUrl: 'https://github.com/login/device', userCode: 'WDJB-MJHT', expiresInSec: 900 });
  });

  it("recognises codex's device code, its URL and the expiry it prints, colours removed", () => {
    expect(recogniseDeviceCode(CODEX)).toEqual({ tool: 'codex', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGHJ', expiresInSec: 900 });
  });

  it('a GitHub Enterprise host keeps its own URL', () => {
    expect(recogniseDeviceCode(GH.replace('https://github.com', 'https://ghe.example.com'))?.verificationUrl).toBe('https://ghe.example.com/login/device');
  });

  it('the last prompt counts: a code asked for again replaces the first', () => {
    expect(recogniseDeviceCode(`${GH}\n${GH.replace('WDJB-MJHT', 'QRST-2345')}`)?.userCode).toBe('QRST-2345');
  });

  it('recognises nothing in ordinary output, or in half a prompt', () => {
    expect(recogniseDeviceCode('Compiling…\nPROJ-1234 fixed\nhttps://github.com/login/device')).toBeUndefined();
    expect(recogniseDeviceCode('! First copy your one-time code: WDJB-MJHT')).toBeUndefined();
    expect(recogniseDeviceCode('Follow these steps to sign in with ChatGPT using device code authorization:\n1. Open this link')).toBeUndefined();
  });

  it('hides the codes the output shows, and nothing else', () => {
    expect(hideCodes('copy WDJB-MJHT now; PROJ-1234 stays', GH)).toBe('copy [code hidden] now; PROJ-1234 stays');
    expect(hideCodes('   ABCD-EFGHJ', CODEX)).toBe('   [code hidden]');
    expect(hideCodes('PROJ-1234', 'no prompt here')).toBe('PROJ-1234');
  });
});
