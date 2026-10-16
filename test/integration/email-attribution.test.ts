// Audit and attribution keyed by email (issue #1380, design.md "Audit and attribution keyed by email"): what a person does
// is recorded under the verified email their user is known by, never the name or username a realm gave. A user with no
// email yet keeps the name the realm gave. The daemon, store and HTTP edge are real; the OIDC issuer is a fake on loopback.
//
// Feature: attribution keyed by email
//   Scenario: a person signed in through SSO changes a setting
//     Given Ada signs in through OIDC with the name Ada Lovelace, the username ada and the verified email ada@example.com
//     When she turns the TL;DR off
//     Then the change is recorded by ada@example.com
//   Scenario: a person whose email the realm does not vouch for
//     Given Eve signs in with an email her provider did not verify
//     When she turns the TL;DR off
//     Then the change is recorded by the name the realm gave, not by an email
import { afterEach, describe, expect, it } from 'vitest';
import type { TestApp } from '../support/app.ts';
import { signIn as oidcSignIn } from '../support/idp.ts';
import { harness, oidcIdp, oidcRealm, session, startNewHopper, stopAll } from '../support/sign-in-app.ts';

const h = harness();
afterEach(() => stopAll(h));

async function tldrOffBy(app: TestApp, token: string): Promise<unknown> {
  const user = (await session(app, token)).user.id as string;
  const r = await app.ui('/ui/api/tldr', { enabled: false }, { token });
  expect(r.status).toBe(200);
  const changed = app.app.user(user).store.events.recent(10, ['tldr.settings_changed']);
  expect(changed).toHaveLength(1);
  return changed[0]!.data.by;
}

describe('audit and attribution keyed by email (issue #1380)', () => {
  it('records what a person does by the verified email of their user; a user with no email by the name the realm gave', async () => {
    const idp = await oidcIdp(h, {
      claims: { sub: 'sub-ada', name: 'Ada Lovelace', preferred_username: 'ada', email: 'Ada@Example.com', email_verified: true }, userinfo: { sub: 'sub-ada' },
    });
    const { app, origin } = await startNewHopper(h, { version: 1, realms: [oidcRealm(idp, { defaultRole: 'admin' })] });

    const ada = (await oidcSignIn(app.url, origin, 'corp')).token!;
    expect(await tldrOffBy(app, ada)).toBe('ada@example.com');

    Object.assign(idp.claims, { sub: 'sub-eve', name: 'Eve', preferred_username: 'eve', email: 'eve@example.com', email_verified: false });
    Object.assign(idp.userinfo, { sub: 'sub-eve' });
    const eve = (await oidcSignIn(app.url, origin, 'corp')).token!;
    expect(await tldrOffBy(app, eve)).toBe('Eve');
  });
});
