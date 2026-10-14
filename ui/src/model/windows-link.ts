// The Windows link (issue #712): what a WSL machine's client found when Windows opened the hopper at localhost — the
// line a machine card says, the fix for the networking mode found, and the machines the banner names. Pure.
import type { ResourceReading, WindowsLink } from '../../../src/domain/types.ts';

const MODE: Record<string, string> = { nat: 'NAT', mirrored: 'mirrored' };
const WSLCONFIG = '.wslconfig, in your Windows user folder (%UserProfile%)';
const SHUTDOWN = 'Then run wsl --shutdown in PowerShell, and start the hopper again.';

/** The host and port Windows opened: `localhost:4790`. */
const hostOf = (l: WindowsLink): string => new URL(l.url).host;
/** The same port at 127.0.0.1, which a browser on Windows can open in place of localhost. */
const loopbackOf = (l: WindowsLink): string => { const u = new URL(l.url); return `${u.protocol}//127.0.0.1${u.port ? `:${u.port}` : ''}`; };
const modeText = (l: WindowsLink): string => (l.mode ? ` (${MODE[l.mode] ?? l.mode} mode)` : '');

/** What a machine card says of the Windows link. */
export function windowsLinkText(l: WindowsLink): string {
  return l.ok
    ? `Windows reaches it at ${hostOf(l)}${modeText(l)}`
    : `Windows does not reach it at ${hostOf(l)}${modeText(l)}${l.error ? `: ${l.error}` : ''}`;
}

/** The fix, one step per line: in NAT mode localhost forwarding first; else 127.0.0.1 or mirrored networking. */
export function windowsLinkFix(l: WindowsLink): string[] {
  const mirrored = `In ${WSLCONFIG}, set networkingMode=mirrored under [wsl2]`;
  if (l.mode === 'nat') {
    return [
      `In ${WSLCONFIG}, set localhostForwarding=true under [wsl2].`,
      `If it is already set, ${mirrored.charAt(0).toLowerCase()}${mirrored.slice(1)} instead, or open ${loopbackOf(l)} in place of localhost.`,
      SHUTDOWN,
    ];
  }
  return [`Open ${loopbackOf(l)} in place of localhost.`, `Or: ${mirrored}.`, SHUTDOWN];
}

/** Each online machine whose Windows link is broken, for the banner. */
export function brokenWindowsLinks(machines: readonly { id: string; label?: string; online: boolean; resources?: ResourceReading }[]): { id: string; name: string; link: WindowsLink }[] {
  return machines.flatMap((m) => {
    const link = m.online ? m.resources?.windowsLink : undefined;
    return link && !link.ok ? [{ id: m.id, name: m.label || m.id, link }] : [];
  });
}
