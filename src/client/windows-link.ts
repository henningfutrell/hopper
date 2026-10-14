// The Windows link (issue #712, design.md "Machine resources over time" → "The Windows link"): a client in WSL that
// dials the hopper on a loopback address runs on the same PC as the hopper, so it tests whether Windows reaches the
// hopper too, at http://localhost:<the port it dials>, else at http://127.0.0.1:<that port> (Windows tries ::1 first for
// localhost). It reads WSL's networking mode (`wslinfo --networking-mode`: nat or mirrored) and asks Windows, through
// PowerShell over WSL interop, for the address check (`/job/address`: 204 to anyone the Host guard lets in, no session):
// any HTTP answer means the hopper answered, and the URL that answered is the result's. In the background, at most every 5 minutes, so a read never waits; a result
// older than 15 minutes is dropped. The test carries no token and only reads. Said in `/release` with the resources.
// Imports nothing of hopper: a client target runs it as a plain file.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { powershell as runPowerShell } from './resources.ts';

/** What the test found (the same shape as WindowsLink in src/domain/machine-history.ts). */
export interface WindowsLink {
  url: string;
  mode?: string;
  ok: boolean;
  status?: number;
  error?: string;
  at: string;
}

export interface WindowsLinkDeps {
  /** The hopper's URL, as this client dials it. */
  url: string;
  /** Where /proc is found; default `/`. */
  root?: string;
  now?: () => number;
  /** Runs a PowerShell script on Windows; default powershell.exe through interop. */
  powershell?: (script: string) => Promise<string | undefined>;
  /** WSL's networking mode; default `wslinfo --networking-mode`. */
  networkingMode?: () => Promise<string | undefined>;
}

const INTERVAL_MS = 5 * 60_000;
const STALE_MS = 15 * 60_000;
const MAX_ERROR = 200;
const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i;

/** The URLs Windows opens, in order: localhost, then 127.0.0.1, at the port this client dials; undefined unless it dials a loopback address. */
export function windowsLinkUrls(hopperUrl: string): [string, string] | undefined {
  let u: URL;
  try { u = new URL(hopperUrl); } catch { return undefined; }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !LOOPBACK.test(u.hostname)) return undefined;
  const at = (host: string): string => `${u.protocol}//${host}${u.port ? `:${u.port}` : ''}/job/address`;
  return [at('localhost'), at('127.0.0.1')];
}

/** The test, as PowerShell runs it: `status <n> <url>` for the first URL that answered (an error status too), else `error <why>` of the first. */
const script = (urls: readonly string[]): string => "$ProgressPreference = 'SilentlyContinue'; $a = $null; $e = $null; "
  + `foreach ($u in @(${urls.map((u) => `'${u}'`).join(', ')})) { `
  + 'try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 -Uri $u; $a = "status $([int]$r.StatusCode) $u" } '
  + 'catch { if ($_.Exception.Response) { $a = "status $([int]$_.Exception.Response.StatusCode) $u" } elseif (-not $e) { $e = $_.Exception.Message } }; '
  + 'if ($a) { break } }; if ($a) { $a } else { "error $e" }';

/** PowerShell's answer to the test: the URL that answered, one of `urls`, when the hopper answered. */
export function readWindowsLinkAnswer(stdout: string | undefined, urls: readonly string[]): Pick<WindowsLink, 'ok' | 'status' | 'error'> & { url?: string } {
  if (stdout === undefined) return { ok: false, error: 'PowerShell did not run through WSL interop' };
  const status = /^\s*status (\d{3}) (\S+)\s*$/.exec(stdout);
  if (status && urls.includes(status[2]!)) return { ok: true, status: Number(status[1]), url: status[2]! };
  const error = /^\s*error (.+?)\s*$/s.exec(stdout);
  if (error) return { ok: false, error: error[1]!.replace(/\s+/g, ' ').slice(0, MAX_ERROR) };
  return { ok: false, error: 'PowerShell gave no answer' };
}

const wslinfo = (): Promise<string | undefined> => new Promise((resolve) => {
  execFile('wslinfo', ['--networking-mode'], { timeout: 10_000 }, (err, stdout) => resolve(err ? undefined : String(stdout)));
});

/** A check: each call answers the last result, and starts a new test in the background when 5 minutes have gone. */
export function createWindowsLinkCheck(d: WindowsLinkDeps): () => WindowsLink | undefined {
  const urls = windowsLinkUrls(d.url);
  let wsl = false;
  try { wsl = /microsoft/i.test(readFileSync(join(d.root ?? '/', 'proc/version'), 'utf8')); } catch { /* not Linux */ }
  if (!urls || !wsl) return () => undefined;
  const now = d.now ?? Date.now;
  const ps = d.powershell ?? ((s: string) => runPowerShell(s, 30_000));
  const mode = d.networkingMode ?? wslinfo;
  let last: { at: number; link: WindowsLink } | undefined;
  let askedAt: number | undefined;
  let asking = false;
  const test = async (at: number): Promise<WindowsLink> => {
    const [m, answer] = await Promise.all([mode().catch(() => undefined), ps(script(urls)).catch(() => undefined)]);
    const name = m?.trim().toLowerCase();
    const { url = urls[0], ...found } = readWindowsLinkAnswer(answer, urls);
    return { url, ...(name && /^[a-z]{1,20}$/.test(name) ? { mode: name } : {}), ...found, at: new Date(at).toISOString() };
  };
  return () => {
    const at = now();
    if (!asking && (askedAt === undefined || at - askedAt >= INTERVAL_MS)) {
      asking = true;
      askedAt = at;
      test(at).then((link) => { last = { at, link }; }, () => {}).finally(() => { asking = false; });
    }
    return last && at - last.at <= STALE_MS ? last.link : undefined;
  };
}
