// A session that ends while the UI is open (issue #439): the UI goes straight to sign-in with the realm the
// session was made with, and back to the page the person was on once signed in — never a half-working page.
import { describe, expect, it } from 'vitest';
import { reauthFor, returnTo } from '../../ui/src/lib/reauth.ts';

const offer = (o: Partial<{ gateway: boolean; realms: { name: string; label: string; type: 'oidc' | 'saml' | 'github'; redirect?: boolean }[]; devices: { name: string; label: string; type: 'github'; redirect?: boolean }[] }> = {}) =>
  ({ local: true, none: null, password: false, gateway: false, origin: 'http://localhost:1', realms: [], devices: [], required: false, ...o });

describe('where sign-in starts again', () => {
  it('an OIDC or SAML realm that is still on: its identity provider, at once', () => {
    expect(reauthFor('corp', offer({ realms: [{ name: 'corp', label: 'Corp', type: 'oidc' }] }))).toEqual({ kind: 'redirect', realm: 'corp' });
  });

  it('a GitHub realm that goes to GitHub and back: there too; one with a device code: the landing page, which shows it', () => {
    expect(reauthFor('gh', offer({ devices: [{ name: 'gh', label: 'GitHub', type: 'github', redirect: true }] }))).toEqual({ kind: 'redirect', realm: 'gh' });
    expect(reauthFor('gh', offer({ devices: [{ name: 'gh', label: 'GitHub', type: 'github' }] }))).toEqual({ kind: 'landing' });
  });

  it('a gateway realm that is on: a new session from the token the gateway forwards', () => {
    expect(reauthFor('edge', offer({ gateway: true }))).toEqual({ kind: 'gateway' });
  });

  it('a realm that is gone or off, a password realm, the login code: the landing page', () => {
    expect(reauthFor('corp', offer())).toEqual({ kind: 'landing' });
    expect(reauthFor('dir', offer())).toEqual({ kind: 'landing' });
    expect(reauthFor('local', offer())).toEqual({ kind: 'landing' });
    expect(reauthFor(null, offer({ gateway: true }))).toEqual({ kind: 'landing' });
  });
});

describe('the page to come back to', () => {
  it('is the view the person was on; the landing page and a login link are not pages', () => {
    expect(returnTo('#settings/sign-in')).toBe('#settings/sign-in');
    expect(returnTo('#queue')).toBe('#queue');
    expect(returnTo('')).toBeNull();
    expect(returnTo('#')).toBeNull();
    expect(returnTo(`#login=${'a'.repeat(64)}`)).toBeNull();
  });
});
