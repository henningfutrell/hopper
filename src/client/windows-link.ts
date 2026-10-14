// The Windows link (issue #712, design.md "Machine resources over time" → "The Windows link"): a client in WSL that
// dials the hopper on a loopback address runs on the same PC as the hopper, so it tests whether Windows reaches the
// hopper too, at http://localhost:<the port it dials>/api/health. It reads WSL's networking mode (`wslinfo
// --networking-mode`: nat or mirrored) and asks Windows, through PowerShell over WSL interop, for that health route:
// any HTTP answer means the hopper answered. In the background, at most every 5 minutes, so a read never waits; a result
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

/** The health URL Windows opens: localhost at the port this client dials; undefined unless it dials a loopback address. */
export function windowsLinkUrl(hopperUrl: string): string | undefined {
  let u: URL;
  try { u = new URL(hopperUrl); } catch { return undefined; }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !LOOPBACK.test(u.hostname)) return undefined;
  return `${u.protocol}//localhost${u.port ? `:${u.port}` : ''}/api/health`;
}

/** The test, as PowerShell runs it: `status <n>` when the hopper answered (an error status too), else `error <why>`. */
const script = (url: string): string => "$ProgressPreference = 'SilentlyContinue'; "
  + `try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 -Uri '${url}'; "status $([int]$r.StatusCode)" } `
  + 'catch { if ($_.Exception.Response) { "status $([int]$_.Exception.Response.StatusCode)" } else { "error $($_.Exception.Message)" } }';

/** PowerShell's answer to the test. */
export function readWindowsLinkAnswer(stdout: string | undefined): Pick<WindowsLink, 'ok' | 'status' | 'error'> {
  if (stdout === undefined) return { ok: false, error: 'PowerShell did not run through WSL interop' };
  const status = /^\s*status (\d{3})\s*$/.exec(stdout);
  if (status) return { ok: true, status: Number(status[1]) };
  const error = /^\s*error (.+?)\s*$/s.exec(stdout);
  if (error) return { ok: false, error: error[1]!.replace(/\s+/g, ' ').slice(0, MAX_ERROR) };
  return { ok: false, error: 'PowerShell gave no answer' };
}

const wslinfo = (): Promise<string | undefined> => new Promise((resolve) => {
  execFile('wslinfo', ['--networking-mode'], { timeout: 10_000 }, (err, stdout) => resolve(err ? undefined : String(stdout)));
});

/** A check: each call answers the last result, and starts a new test in the background when 5 minutes have gone. */
export function createWindowsLinkCheck(d: WindowsLinkDeps): () => WindowsLink | undefined {
  const url = windowsLinkUrl(d.url);
  let wsl = false;
  try { wsl = /microsoft/i.test(readFileSync(join(d.root ?? '/', 'proc/version'), 'utf8')); } catch { /* not Linux */ }
  if (!url || !wsl) return () => undefined;
  const now = d.now ?? Date.now;
  const ps = d.powershell ?? ((s: string) => runPowerShell(s, 30_000));
  const mode = d.networkingMode ?? wslinfo;
  let last: { at: number; link: WindowsLink } | undefined;
  let askedAt: number | undefined;
  let asking = false;
  const test = async (at: number): Promise<WindowsLink> => {
    const [m, answer] = await Promise.all([mode().catch(() => undefined), ps(script(url)).catch(() => undefined)]);
    const name = m?.trim().toLowerCase();
    return { url, ...(name && /^[a-z]{1,20}$/.test(name) ? { mode: name } : {}), ...readWindowsLinkAnswer(answer), at: new Date(at).toISOString() };
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
