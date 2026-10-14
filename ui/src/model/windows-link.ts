// The Windows link (issue #712): what a WSL machine's client found when Windows opened the hopper at localhost, else at
// 127.0.0.1 — the line a machine card says, the fix for the networking mode found, and the machines the banner names, with
// the report of the keep-alive loop on Windows. Pure.
import type { ResourceReading, WindowsLink } from '../../../src/domain/types.ts';

const MODE: Record<string, string> = { nat: 'NAT', mirrored: 'mirrored' };
const WSLCONFIG = '.wslconfig, in your Windows user folder (%UserProfile%)';
const SHUTDOWN = 'Then run wsl --shutdown in PowerShell, and start the hopper again.';

/** The host and port Windows opened: `localhost:4790`, or `127.0.0.1:4790` when only it answered. */
const hostOf = (l: WindowsLink): string => new URL(l.url).host;
/** The same port at 127.0.0.1, which a browser on Windows can open in place of localhost. */
const loopbackOf = (l: WindowsLink): string => { const u = new URL(l.url); return `${u.protocol}//127.0.0.1${u.port ? `:${u.port}` : ''}`; };
const lower = (t: string): string => `${t.charAt(0).toLowerCase()}${t.slice(1)}`;
const modeText = (l: WindowsLink): string => (l.mode ? ` (${MODE[l.mode] ?? l.mode} mode)` : '');

/** What a machine card says of the Windows link. */
export function windowsLinkText(l: WindowsLink): string {
  if (!l.ok) return `Windows does not reach it at ${hostOf(l)}${modeText(l)}${l.error ? `: ${l.error}` : ''}`;
  if (new URL(l.url).hostname === '127.0.0.1') {
    return `Windows reaches it at ${hostOf(l)} only, not at localhost${modeText(l)}. Windows tries ::1 first for localhost: open ${loopbackOf(l)}`;
  }
  return `Windows reaches it at ${hostOf(l)}${modeText(l)}`;
}

/**
 * The fix, one step per line, by mode: NAT, localhost forwarding first, then mirrored networking or 127.0.0.1;
 * mirrored, 127.0.0.1 (mirrored networking is on already); no mode read, both.
 */
export function windowsLinkFix(l: WindowsLink): string[] {
  const forwarding = `In ${WSLCONFIG}, set localhostForwarding=true under [wsl2].`;
  const mirrored = `In ${WSLCONFIG}, set networkingMode=mirrored under [wsl2]`;
  const loopback = `Open ${loopbackOf(l)} in place of localhost.`;
  if (l.mode === 'nat') {
    return [
      forwarding,
      `If it is already set, ${lower(mirrored)} instead, or open ${loopbackOf(l)} in place of localhost.`,
      SHUTDOWN,
    ];
  }
  if (l.mode === 'mirrored') return [loopback, 'If it does not open either, run wsl --shutdown in PowerShell, and start the hopper again.'];
  return [loopback, `Or, in NAT mode: ${lower(forwarding)}`, `Or: ${lower(mirrored)}.`, SHUTDOWN];
}

/** The id and name the banner gives a report of the keep-alive loop on Windows (src/machines/windows-link-watch.ts). */
const REPORTER = { id: 'windows', name: 'Windows (the keep-alive loop)' };

/** Each online machine whose Windows link is broken, for the banner; then the keep-alive loop's report, when broken. */
export function brokenWindowsLinks(machines: readonly { id: string; label?: string; online: boolean; resources?: ResourceReading }[], reported?: WindowsLink): { id: string; name: string; link: WindowsLink }[] {
  const fromMachines = machines.flatMap((m) => {
    const link = m.online ? m.resources?.windowsLink : undefined;
    return link && !link.ok ? [{ id: m.id, name: m.label || m.id, link }] : [];
  });
  return reported && !reported.ok ? [...fromMachines, { ...REPORTER, link: reported }] : fromMachines;
}
