// A login's browser profile (issue #1249): one per machine and account, its name only from them, so two machines signed in
// back to back get two profiles and a sign-in again on the same machine and account opens the same one. The commands open the
// page in Chrome or Edge with the profile's own data dir; the Firefox link names the container.
import { describe, expect, it } from 'vitest';
import { browserProfileName, containerLink, loginProfileName, platformOf, profileCommand } from '../../ui/src/model/browser-profile.ts';
import type { LoginView } from '../../ui/src/model/wire.ts';

const URL = "https://claude.ai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback&state=a'b";

/** A tool sign-in on `machineId`, its machine last signed in as `identity`. */
const signIn = (machineId: string, identity?: string, over: Partial<LoginView> = {}): LoginView => ({
  id: `l-${machineId}`, kind: 'paste_code', tool: 'claude', status: 'pending', expiresAt: '2026-10-15T12:15:00.000Z', machineId, run: 'sign-in',
  renewable: false, createdAt: '2026-10-15T12:00:00.000Z', updatedAt: '2026-10-15T12:00:00.000Z', codeKept: true, verificationUrl: URL,
  lastAccount: identity ? { machineId, service: 'claude', identity, capturedAt: '2026-10-14T09:00:00.000Z' } : null, ...over,
});

describe('a login\'s browser profile', () => {
  it('two machines signed in back to back get separate profiles', () => {
    const l4 = loginProfileName(signIn('fleet-l4', 'one@example.com'));
    const l1 = loginProfileName(signIn('fleet-l1', 'one@example.com'));
    expect(l4).toBe('hopper-fleet-l4-one-example-com');
    expect(l1).toBe('hopper-fleet-l1-one-example-com');
    expect(l4).not.toBe(l1);
  });

  it('one machine signed in as two accounts gets two profiles', () => {
    expect(loginProfileName(signIn('fleet-l4', 'one@example.com'))).not.toBe(loginProfileName(signIn('fleet-l4', 'two@example.com')));
  });

  it('a sign-in again on the same machine and account gives the same profile, whatever else the login holds', () => {
    const first = signIn('fleet-l4', 'one@example.com');
    const again = signIn('fleet-l4', 'one@example.com', { id: 'l-other', createdAt: '2026-10-16T08:00:00.000Z', verificationUrl: 'https://claude.ai/other' });
    expect(loginProfileName(again)).toBe(loginProfileName(first));
  });

  it('the account the login names wins over the last account; with none known, the machine only', () => {
    expect(loginProfileName(signIn('fleet-l4', 'one@example.com', { account: 'two@example.com' }))).toBe('hopper-fleet-l4-two-example-com');
    expect(loginProfileName(signIn('fleet-l4'))).toBe('hopper-fleet-l4');
    // The Claude sign-in for pods is on no machine.
    const { machineId: _, ...pods } = signIn('x', undefined, { account: 'pods@example.com' });
    expect(loginProfileName(pods)).toBe('hopper-self-pods-example-com');
  });

  it('a name holds only lower case letters, digits and single dashes, each part at most 40 characters', () => {
    const name = browserProfileName({ machineId: 'Desk PC (Win)', account: `${'a'.repeat(60)}@Example.COM` });
    expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(name).toBe(`hopper-desk-pc-win-${'a'.repeat(40)}`);
  });
});

describe('opening the page in the profile', () => {
  it('the platform is read from the user agent', () => {
    expect(platformOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0')).toBe('windows');
    expect(platformOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('mac');
    expect(platformOf('Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux');
  });

  it('Windows: a PowerShell command that starts Chrome or Edge with the profile\'s data dir under LOCALAPPDATA, the URL quoted', () => {
    const cmd = profileCommand({ profile: 'hopper-fleet-l4', url: URL, browser: 'edge', platform: 'windows' });
    expect(cmd).toBe(`Start-Process msedge -ArgumentList ('--user-data-dir="' + $env:LOCALAPPDATA + '\\hopper\\browser-profiles\\hopper-fleet-l4"'), '"${URL.replace("'", "''")}"'`);
    expect(profileCommand({ profile: 'hopper-fleet-l4', url: URL, browser: 'chrome', platform: 'windows' })).toMatch(/^Start-Process chrome /);
  });

  it('macOS and Linux: a shell command, the URL in single quotes', () => {
    expect(profileCommand({ profile: 'p', url: "https://x/?a=1&b='", browser: 'chrome', platform: 'mac' }))
      .toBe(`open -na 'Google Chrome' --args --user-data-dir="$HOME/Library/Application Support/hopper/browser-profiles/p" 'https://x/?a=1&b='\\'''`);
    expect(profileCommand({ profile: 'p', url: 'https://x/', browser: 'edge', platform: 'linux' }))
      .toBe(`microsoft-edge --user-data-dir="$HOME/.local/share/hopper/browser-profiles/p" 'https://x/'`);
  });

  it('the Firefox container link names the profile and carries the URL encoded', () => {
    const link = containerLink('hopper-fleet-l4', URL);
    expect(link.startsWith('ext+container:name=hopper-fleet-l4&url=')).toBe(true);
    expect(decodeURIComponent(link.slice(link.indexOf('&url=') + 5))).toBe(URL);
  });
});
