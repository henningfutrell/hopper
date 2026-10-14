// The Windows link (issue #712): a client in WSL that dials the hopper on a loopback address is on the same PC as the
// hopper, so it tests whether Windows reaches the hopper at http://localhost:<port>. It reads WSL's networking mode
// (wslinfo) and asks Windows, through PowerShell, for the health route; in the background, so a read never waits. A
// client that is not in WSL, or dials the hopper elsewhere, tests nothing. Fake root, fake PowerShell and wslinfo here.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWindowsLinkCheck, readWindowsLinkAnswer, windowsLinkUrl } from '../../src/client/windows-link.ts';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'jh-wlink-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const put = (path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const tick = () => new Promise((r) => setTimeout(r, 0));
const WSL = 'Linux version 6.6.87.2-microsoft-standard-WSL2 (gcc) #1 SMP\n';

/** A check over a fake root: PowerShell answers what `answer` says, wslinfo what `mode` says; the clock moves as the test says. */
function check(url: string, o: { answer?: string | undefined; mode?: string | undefined } = {}) {
  let t = Date.parse('2026-10-13T10:00:00.000Z');
  const state = { answer: 'answer' in o ? o.answer : 'status 200', mode: 'mode' in o ? o.mode : 'nat\n', scripts: [] as string[], hang: false };
  const read = createWindowsLinkCheck({
    url, root, now: () => t,
    powershell: (script) => { state.scripts.push(script); return state.hang ? new Promise<string | undefined>(() => {}) : Promise.resolve(state.answer); },
    networkingMode: async () => state.mode,
  });
  return { read, state, advance(ms: number) { t += ms; } };
}

describe('the Windows link', () => {
  it('the URL Windows opens: localhost, at the port the client dials; none unless the client dials a loopback address', () => {
    expect(windowsLinkUrl('http://127.0.0.1:4790')).toBe('http://localhost:4790/api/health');
    expect(windowsLinkUrl('http://localhost:4790/')).toBe('http://localhost:4790/api/health');
    expect(windowsLinkUrl('http://[::1]:4790')).toBe('http://localhost:4790/api/health');
    expect(windowsLinkUrl('https://127.0.0.1')).toBe('https://localhost/api/health');
    expect(windowsLinkUrl('http://hopper:4790')).toBeUndefined();
    expect(windowsLinkUrl('https://hopper.example.org')).toBeUndefined();
    expect(windowsLinkUrl('not a url')).toBeUndefined();
  });

  it('PowerShell\'s answer: any HTTP status means the hopper answered; else the reason, short', () => {
    expect(readWindowsLinkAnswer('status 200\r\n')).toEqual({ ok: true, status: 200 });
    expect(readWindowsLinkAnswer('status 421')).toEqual({ ok: true, status: 421 });
    expect(readWindowsLinkAnswer('error Unable to connect to the remote server\r\n')).toEqual({ ok: false, error: 'Unable to connect to the remote server' });
    expect(readWindowsLinkAnswer(`error ${'x'.repeat(500)}`).error).toHaveLength(200);
    expect(readWindowsLinkAnswer(undefined)).toEqual({ ok: false, error: 'PowerShell did not run through WSL interop' });
    expect(readWindowsLinkAnswer('garbage')).toEqual({ ok: false, error: 'PowerShell gave no answer' });
  });

  it('in WSL, dialling on loopback: the next read carries the result and the mode; tested again after five minutes', async () => {
    put('proc/version', WSL);
    const c = check('http://127.0.0.1:4790');
    expect(c.read()).toBeUndefined();
    await tick();
    expect(c.read()).toEqual({ url: 'http://localhost:4790/api/health', mode: 'nat', ok: true, status: 200, at: '2026-10-13T10:00:00.000Z' });
    expect(c.state.scripts).toHaveLength(1);
    expect(c.state.scripts[0]).toContain("Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 -Uri 'http://localhost:4790/api/health'");
    c.advance(60_000);
    c.read();
    await tick();
    expect(c.state.scripts).toHaveLength(1);
    c.state.answer = 'error Unable to connect to the remote server';
    c.state.mode = 'mirrored';
    c.advance(5 * 60_000);
    c.read();
    await tick();
    expect(c.read()).toMatchObject({ mode: 'mirrored', ok: false, error: 'Unable to connect to the remote server' });
    expect(c.state.scripts).toHaveLength(2);
  });

  it('no interop: the link is broken, said so; no wslinfo: no mode', async () => {
    put('proc/version', WSL);
    const c = check('http://localhost:4790', { answer: undefined, mode: undefined });
    c.read();
    await tick();
    const r = c.read();
    expect(r).toMatchObject({ ok: false, error: 'PowerShell did not run through WSL interop' });
    expect(r).not.toHaveProperty('mode');
  });

  it('a result older than fifteen minutes is dropped: a test that never ends does not keep it', async () => {
    put('proc/version', WSL);
    const c = check('http://127.0.0.1:4790');
    c.read();
    await tick();
    expect(c.read()?.ok).toBe(true);
    c.state.hang = true;
    c.advance(10 * 60_000);
    expect(c.read()?.ok).toBe(true);
    c.advance(6 * 60_000);
    await tick();
    expect(c.read()).toBeUndefined();
  });

  it('not WSL, or dialling the hopper elsewhere: nothing is tested', async () => {
    put('proc/version', 'Linux version 6.8.0-45-generic\n');
    const linux = check('http://127.0.0.1:4790');
    expect(linux.read()).toBeUndefined();
    put('proc/version', WSL);
    const far = check('https://hopper.example.org');
    expect(far.read()).toBeUndefined();
    await tick();
    expect(linux.read()).toBeUndefined();
    expect(far.read()).toBeUndefined();
    expect(linux.state.scripts).toHaveLength(0);
    expect(far.state.scripts).toHaveLength(0);
  });
});
