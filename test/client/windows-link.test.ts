// The Windows link (issue #712): a client in WSL that dials the hopper on a loopback address is on the same PC as the
// hopper, so it tests whether Windows reaches the hopper at http://localhost:<port>. It reads WSL's networking mode
// (wslinfo) and asks Windows, through PowerShell, for the health route; in the background, so a read never waits. A
// client that is not in WSL, or dials the hopper elsewhere, tests nothing. Fake root, fake PowerShell and wslinfo here.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWindowsLinkCheck, readWindowsLinkAnswer, windowsLinkUrls } from '../../src/client/windows-link.ts';

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
  const state = { answer: 'answer' in o ? o.answer : 'status 204 http://localhost:4790/job/address', mode: 'mode' in o ? o.mode : 'nat\n', scripts: [] as string[], hang: false };
  const read = createWindowsLinkCheck({
    url, root, now: () => t,
    powershell: (script) => { state.scripts.push(script); return state.hang ? new Promise<string | undefined>(() => {}) : Promise.resolve(state.answer); },
    networkingMode: async () => state.mode,
  });
  return { read, state, advance(ms: number) { t += ms; } };
}

describe('the Windows link', () => {
  it('the URLs Windows opens: localhost, then 127.0.0.1, at the port the client dials; none unless the client dials a loopback address', () => {
    const at = (base: string) => [`${base}/job/address`, `${base.replace('localhost', '127.0.0.1')}/job/address`];
    expect(windowsLinkUrls('http://127.0.0.1:4790')).toEqual(at('http://localhost:4790'));
    expect(windowsLinkUrls('http://localhost:4790/')).toEqual(at('http://localhost:4790'));
    expect(windowsLinkUrls('http://[::1]:4790')).toEqual(at('http://localhost:4790'));
    expect(windowsLinkUrls('https://127.0.0.1')).toEqual(at('https://localhost'));
    expect(windowsLinkUrls('http://hopper:4790')).toBeUndefined();
    expect(windowsLinkUrls('https://hopper.example.org')).toBeUndefined();
    expect(windowsLinkUrls('not a url')).toBeUndefined();
  });

  it('PowerShell\'s answer: any HTTP status at a URL tried means the hopper answered there; else the reason, short', () => {
    const urls = ['http://localhost:4790/job/address', 'http://127.0.0.1:4790/job/address'];
    expect(readWindowsLinkAnswer('status 204 http://localhost:4790/job/address\r\n', urls)).toEqual({ ok: true, status: 204, url: urls[0] });
    expect(readWindowsLinkAnswer('status 204 http://127.0.0.1:4790/job/address', urls)).toEqual({ ok: true, status: 204, url: urls[1] });
    expect(readWindowsLinkAnswer('status 421 http://localhost:4790/job/address', urls)).toEqual({ ok: true, status: 421, url: urls[0] });
    expect(readWindowsLinkAnswer('status 204 http://example.org/job/address', urls)).toEqual({ ok: false, error: 'PowerShell gave no answer' });
    expect(readWindowsLinkAnswer('error Unable to connect to the remote server\r\n', urls)).toEqual({ ok: false, error: 'Unable to connect to the remote server' });
    expect(readWindowsLinkAnswer(`error ${'x'.repeat(500)}`, urls).error).toHaveLength(200);
    expect(readWindowsLinkAnswer(undefined, urls)).toEqual({ ok: false, error: 'PowerShell did not run through WSL interop' });
    expect(readWindowsLinkAnswer('garbage', urls)).toEqual({ ok: false, error: 'PowerShell gave no answer' });
  });

  it('in WSL, dialling on loopback: the next read carries the result and the mode; tested again after five minutes', async () => {
    put('proc/version', WSL);
    const c = check('http://127.0.0.1:4790');
    expect(c.read()).toBeUndefined();
    await tick();
    expect(c.read()).toEqual({ url: 'http://localhost:4790/job/address', mode: 'nat', ok: true, status: 204, at: '2026-10-13T10:00:00.000Z' });
    expect(c.state.scripts).toHaveLength(1);
    expect(c.state.scripts[0]).toContain("@('http://localhost:4790/job/address', 'http://127.0.0.1:4790/job/address')");
    expect(c.state.scripts[0]).toContain('Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 -Uri $u');
    c.advance(60_000);
    c.read();
    await tick();
    expect(c.state.scripts).toHaveLength(1);
    c.state.answer = 'error Unable to connect to the remote server';
    c.state.mode = 'mirrored';
    c.advance(5 * 60_000);
    c.read();
    await tick();
    expect(c.read()).toMatchObject({ url: 'http://localhost:4790/job/address', mode: 'mirrored', ok: false, error: 'Unable to connect to the remote server' });
    expect(c.state.scripts).toHaveLength(2);
  });

  it('only 127.0.0.1 answers: the link works, at the URL that answered', async () => {
    put('proc/version', WSL);
    const c = check('http://localhost:4790', { answer: 'status 204 http://127.0.0.1:4790/job/address' });
    c.read();
    await tick();
    expect(c.read()).toMatchObject({ url: 'http://127.0.0.1:4790/job/address', ok: true, status: 204 });
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
