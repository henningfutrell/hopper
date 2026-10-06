// Two admin tiers (issue #242, docs/sign-in.md "Super admins"): the first person to sign in with GitHub is
// a super admin; any admin makes another person admin; only a super admin makes another person super admin
// or hands the privilege over (transfer: they stay admin). A regular admin can neither, and no change of
// theirs takes the privilege from anyone (removing or turning off the realm a super admin signs in with).
// The daemon, store and HTTP server are real; GitHub is a fake at the forge seam.
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeGitHub, type FakeForge } from '../support/fake-forges.ts';
import { rawRequest } from '../support/http.ts';
import type { TestApp } from '../support/app.ts';
import { signIn } from '../support/idp.ts';
import { harness, oidcIdp, oidcRealm, session, startWithAuth, stopAll } from '../support/sign-in-app.ts';
import { waitFor } from '../support/wait.ts';

const h = harness();
afterEach(() => stopAll(h));

const BINDING = 'b'.repeat(43);

async function forge(): Promise<FakeForge> {
  const github = await createFakeGitHub({ clientId: 'gh-app-client' });
  h.stops.push(() => github.close());
  return github;
}
const ENV = (github: FakeForge) => ({ HOPPER_GITHUB_URL: github.url, HOPPER_GITHUB_CLIENT_ID: 'gh-app-client', HOPPER_GITHUB_APP_SLUG: 'hopper-test' });
const GITHUB = { name: 'github', label: 'GitHub', type: 'github', roles: { defaultRole: 'viewer' } };

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read loose JSON
const post = async (url: string, origin: string, path: string, body: unknown): Promise<{ status: number; body: any }> => {
  const r = await rawRequest(url, { method: 'POST', path, body: JSON.stringify(body), headers: { 'content-type': 'application/json', origin } });
  return { status: r.status, body: r.text ? JSON.parse(r.text) : undefined };
};

/** Sign in with GitHub as `login`; the session token. */
async function signInAs(app: TestApp, origin: string, github: FakeForge, login: string): Promise<string> {
  const started = await post(app.url, origin, '/ui/auth/github/device', { binding: BINDING });
  expect(started.status).toBe(200);
  github.approve(login);
  const done = await waitFor(async () => {
    const r = await post(app.url, origin, '/ui/auth/device/poll', { flow: started.body.flow, binding: BINDING });
    return r.body?.state === 'waiting' ? undefined : r;
  }, { what: `${login}'s sign-in to end` });
  expect(done.status).toBe(200);
  return done.body.token as string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read loose JSON
const realms = async (app: TestApp, token: string): Promise<any> => (await app.api('GET', '/api/realms', undefined, { 'x-hopper-session': token })).body;
const change = async (app: TestApp, token: string, body: Record<string, unknown>) =>
  app.ui<{ error?: string }>('/ui/api/realms', { ...body, version: (await realms(app, token)).version }, { token });
/** The person who signed in as the user named `name`, as Settings → Sign-in lists them. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read loose JSON
const person = async (app: TestApp, token: string, name: string): Promise<any> => (await realms(app, token)).people.find((p: { user: string }) => p.user === name);
const who = async (app: TestApp, token: string, name: string) => { const p = await person(app, token, name); return { realm: p.realm, subject: p.subject }; };
const me = async (app: TestApp, token: string) => (await session(app, token)).user;

async function threeSignedIn() {
  const github = await forge();
  const { app, origin } = await startWithAuth(h, { version: 1, realms: [GITHUB] }, ENV(github));
  const first = await signInAs(app, origin, github, 'octo');
  const second = await signInAs(app, origin, github, 'bea');
  const third = await signInAs(app, origin, github, 'cal');
  return { app, origin, github, first, second, third };
}

describe('two admin tiers (issue #242)', () => {
  it('the first person to sign in with GitHub is a super admin; the rest are not', async () => {
    const { app, first, second } = await threeSignedIn();
    expect(await me(app, first)).toMatchObject({ role: 'admin', superAdmin: true });
    expect(await me(app, second)).toMatchObject({ role: 'viewer', superAdmin: false });
    const view = await realms(app, first);
    expect(view.people).toEqual(expect.arrayContaining([
      { realm: 'github', subject: expect.any(String), user: 'octo', role: 'admin', superAdmin: true },
      { realm: 'github', subject: expect.any(String), user: 'bea', role: 'viewer', superAdmin: false },
    ]));
  });

  it('an admin makes another person admin, and that admin can make others admin', async () => {
    const { app, first, second, third } = await threeSignedIn();
    const r = await change(app, first, { action: 'admin', who: await who(app, first, 'bea') });
    expect(r.status).toBe(200);
    expect(await me(app, second)).toMatchObject({ role: 'admin', superAdmin: false });
    expect((await change(app, second, { action: 'admin', who: await who(app, second, 'cal') })).status).toBe(200);
    expect(await me(app, third)).toMatchObject({ role: 'admin', superAdmin: false });
  });

  it('a regular admin cannot make anyone super admin, nor hand the privilege over', async () => {
    const { app, first, second } = await threeSignedIn();
    await change(app, first, { action: 'admin', who: await who(app, first, 'bea') });
    const make = await change(app, second, { action: 'super-admin', who: await who(app, second, 'cal') });
    expect(make.status).toBe(403);
    expect(make.body.error).toMatch(/super admin/);
    const self = await change(app, second, { action: 'super-admin', who: await who(app, second, 'bea') });
    expect(self.status).toBe(403);
    const transfer = await change(app, second, { action: 'super-admin', who: await who(app, second, 'cal'), transfer: true });
    expect(transfer.status).toBe(403);
    expect((await realms(app, first)).people.filter((p: { superAdmin: boolean }) => p.superAdmin).map((p: { user: string }) => p.user)).toEqual(['octo']);
  });

  it('a super admin makes another person super admin: they are admin too', async () => {
    const { app, first, second } = await threeSignedIn();
    expect((await change(app, first, { action: 'super-admin', who: await who(app, first, 'bea') })).status).toBe(200);
    expect(await me(app, second)).toMatchObject({ role: 'admin', superAdmin: true });
    expect(await me(app, first)).toMatchObject({ role: 'admin', superAdmin: true });
  });

  it('a super admin hands the privilege over: the other is super admin, they stay admin', async () => {
    const { app, first, second, third } = await threeSignedIn();
    expect((await change(app, first, { action: 'super-admin', who: await who(app, first, 'bea'), transfer: true })).status).toBe(200);
    expect(await me(app, second)).toMatchObject({ role: 'admin', superAdmin: true });
    expect(await me(app, first)).toMatchObject({ role: 'admin', superAdmin: false });
    // No longer super admin: they cannot make anyone super admin.
    expect((await change(app, first, { action: 'super-admin', who: await who(app, first, 'cal') })).status).toBe(403);
    // The new super admin can.
    expect((await change(app, second, { action: 'super-admin', who: await who(app, second, 'cal') })).status).toBe(200);
    expect(await me(app, third)).toMatchObject({ role: 'admin', superAdmin: true });
  });

  it('someone who never signed in cannot be made admin or super admin', async () => {
    const { app, first } = await threeSignedIn();
    expect((await change(app, first, { action: 'admin', who: { realm: 'github', subject: '999999' } })).status).toBe(404);
    expect((await change(app, first, { action: 'super-admin', who: { realm: 'github', subject: '999999' } })).status).toBe(404);
  });

  it('a regular admin cannot take the privilege away by turning off or removing the realm a super admin signs in with', async () => {
    const github = await forge();
    const idp = await oidcIdp(h, { claims: { email: 'ada@example.com', email_verified: true, name: 'Ada', preferred_username: 'ada' } });
    const { app, origin } = await startWithAuth(h, { version: 1, realms: [GITHUB, oidcRealm(idp, { admin: { emails: ['ada@example.com'] } })] }, ENV(github));
    const first = await signInAs(app, origin, github, 'octo');
    const ada = (await signIn(app.url, origin, 'corp')).token;
    expect(await me(app, ada)).toMatchObject({ role: 'admin', superAdmin: false });
    expect((await change(app, ada, { action: 'enable', name: 'github', enabled: false })).status).toBe(403);
    expect((await change(app, ada, { action: 'remove', name: 'github' })).status).toBe(403);
    expect(await me(app, first)).toMatchObject({ role: 'admin', superAdmin: true });
    // Its other settings stay theirs to change.
    expect((await change(app, ada, { action: 'save', name: 'github', realm: { ...GITHUB, roles: { defaultRole: 'operator' } } })).status).toBe(200);
  });
});
