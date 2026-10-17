// A login's browser profile (issue #1249, design.md "Logins"): the browser profile a person opens a login's sign-in page in, one
// per machine and account, so the cookies of one machine's sign-in never sign another machine's tool in, nor as another account.
// Its name comes only from the machine id and the account: the same machine and account always give the same name, so a sign-in
// again opens the profile the last one used. A page cannot pick the browser's profile, so the card shows the name and gives the
// ways to open the page in it: a command that starts Chrome or Edge with the profile's own data dir, or a Firefox container link
// (the "Open external links in a container" add-on). Pure: the platform is passed in.
import type { LoginView } from './wire.ts';

/** The machine part of a login on no machine: the hopper's own sign-ins (the Claude sign-in for pods, issue #1287). */
export const NO_MACHINE = 'self';

const PART_MAX = 40;

/** A part of a profile name: lower case letters, digits and single dashes. */
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, PART_MAX).replace(/-+$/, '');

/** `hopper-<machine>-<account>`, or `hopper-<machine>` while no account is known on the machine. */
export function browserProfileName({ machineId, account }: { machineId?: string; account?: string }): string {
  const parts = ['hopper', slug(machineId ?? '') || NO_MACHINE];
  const a = account ? slug(account) : '';
  if (a) parts.push(a);
  return parts.join('-');
}

/**
 * The account a login's profile is for: the one the login names (the sign-in for pods names it; a tool may show one), else the
 * one its machine was last signed in as (issue #1269), else none.
 */
export const loginAccount = (l: Pick<LoginView, 'account' | 'lastAccount'>): string | undefined => l.account ?? l.lastAccount?.identity;

/** A login's browser profile name. */
export const loginProfileName = (l: Pick<LoginView, 'machineId' | 'account' | 'lastAccount'>): string =>
  browserProfileName({ ...(l.machineId ? { machineId: l.machineId } : {}), ...(loginAccount(l) ? { account: loginAccount(l) } : {}) });

export type ProfilePlatform = 'windows' | 'mac' | 'linux';
export type ProfileBrowser = 'chrome' | 'edge';

/** The platform of the browser that shows the card, from its user agent. */
export function platformOf(userAgent: string): ProfilePlatform {
  if (/windows/i.test(userAgent)) return 'windows';
  if (/macintosh|mac os x/i.test(userAgent)) return 'mac';
  return 'linux';
}

const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

const EXE: Record<ProfilePlatform, Record<ProfileBrowser, string>> = {
  windows: { chrome: 'chrome', edge: 'msedge' },
  mac: { chrome: 'Google Chrome', edge: 'Microsoft Edge' },
  linux: { chrome: 'google-chrome', edge: 'microsoft-edge' },
};

/**
 * The command that opens `url` in `browser` with the profile's own data dir (`--user-data-dir`): a profile apart from the
 * person's own, made at its first use and used again each time after. Windows: PowerShell, the dir under `%LOCALAPPDATA%`.
 */
export function profileCommand(o: { profile: string; url: string; browser: ProfileBrowser; platform: ProfilePlatform }): string {
  const exe = EXE[o.platform][o.browser];
  if (o.platform === 'windows') {
    return `Start-Process ${exe} -ArgumentList ('--user-data-dir="' + $env:LOCALAPPDATA + '\\hopper\\browser-profiles\\${o.profile}"'), ${psQuote(`"${o.url}"`)}`;
  }
  if (o.platform === 'mac') {
    return `open -na ${shQuote(exe)} --args --user-data-dir="$HOME/Library/Application Support/hopper/browser-profiles/${o.profile}" ${shQuote(o.url)}`;
  }
  return `${exe} --user-data-dir="$HOME/.local/share/hopper/browser-profiles/${o.profile}" ${shQuote(o.url)}`;
}

/** The link that opens `url` in the Firefox container named for the profile (the "Open external links in a container" add-on). */
export const containerLink = (profile: string, url: string): string => `ext+container:name=${encodeURIComponent(profile)}&url=${encodeURIComponent(url)}`;
