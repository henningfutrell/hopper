// Registering the instance at hopper.io (issue #465, design.md "Registering at hopper.io"): the instance admin mints a
// registration code on the instance while it is linked; hopper.io hands the code back over the cloud link when the account
// owner enters it there, and the instance takes it once. Over the real instance store.
//   Scenario: the code the admin minted registers the link to its own account, once; the id is the instance id
//   Scenario: no code, a wrong, spent or expired code, another account or no link register nothing
//   Scenario: a new code replaces the one before; an unlink removes the code; a link again keeps the instance id and is
//     pending until it registers again
import { afterEach, describe, expect, it } from 'vitest';
import type { InstanceStore } from '../../src/domain/store.ts';
import type { NewEvent } from '../../src/domain/types.ts';
import { createCloudLink, type CloudLink } from '../../src/http/cloud-link.ts';
import { HttpError } from '../../src/http/errors.ts';
import { openInstanceStore } from '../../src/store/index.ts';
import { installFromBefore, testDatabaseUrl } from '../support/database.ts';
import { systemOf } from '../support/system-secrets.ts';
import { fixedClock } from '../store/helpers.ts';

const closers: (() => void)[] = [];
afterEach(() => { for (const c of closers.splice(0)) c(); });

function setup(): { instance: InstanceStore; link: CloudLink; events: NewEvent[]; clock: ReturnType<typeof fixedClock> } {
  const instance = openInstanceStore({ url: installFromBefore(testDatabaseUrl()), clock: fixedClock() });
  closers.push(() => instance.close());
  const events: NewEvent[] = [], clock = fixedClock('2026-10-17T08:00:00.000Z');
  const link = createCloudLink({ settings: instance.settings, secrets: systemOf({ vault: instance.vault, events: { append: (e) => e }, tx: instance.tx }), events: { append: (e) => { events.push(e); } }, now: () => clock.now() });
  return { instance, link, events, clock };
}

describe('registering the instance at hopper.io', () => {
  it('the code the admin minted registers the link to its own account, once; the id is the instance id', () => {
    const { instance, link, events, clock } = setup();
    const installId = instance.settings.instanceId();
    expect(link.link('octo-cat', 'admin').link).toMatchObject({ installId, state: 'pending' });

    const minted = link.mintRegistrationCode('admin');
    expect(minted.code).toMatch(/^[0-9a-f]{64}$/);
    expect(minted.expiresAt).toBe('2026-10-17T08:10:00.000Z');
    expect(link.view().registrationCode).toEqual({ expiresAt: minted.expiresAt, by: 'admin' });
    expect(JSON.stringify(link.view())).not.toContain(minted.code);
    expect(JSON.stringify(instance.settings.getCloudRegistrationCode())).not.toContain(minted.code);

    clock.set('2026-10-17T08:09:59.000Z');
    expect(link.register(minted.code, 'Octo-Cat')).toBe('registered');
    expect(link.view()).toEqual({ link: { installId, account: 'octo-cat', state: 'registered', linkedAt: '2026-10-17T08:00:00.000Z', registeredAt: '2026-10-17T08:09:59.000Z', by: 'admin' } });
    expect(link.register(minted.code, 'octo-cat')).toBe('no-code');

    expect(events.map((e) => [e.type, e.data])).toEqual([
      ['cloud_link.linked', { installId, account: 'octo-cat', by: 'admin' }],
      ['cloud_link.registration_code_minted', { installId, account: 'octo-cat', expiresAt: minted.expiresAt, by: 'admin' }],
      ['cloud_link.registered', { installId, account: 'octo-cat' }],
    ]);
    expect(JSON.stringify(events)).not.toContain(minted.code);
  });

  it('no code, a wrong, spent or expired code, another account or no link register nothing', () => {
    const { link, events, clock } = setup();
    expect(link.register('a'.repeat(64), 'octo-cat')).toBe('not-linked');
    expect(() => link.mintRegistrationCode('admin')).toThrow(HttpError);

    link.link('octo-cat', 'admin');
    expect(link.register('a'.repeat(64), 'octo-cat')).toBe('no-code');
    const { code } = link.mintRegistrationCode('admin');
    expect(link.register('a'.repeat(64), 'octo-cat')).toBe('no-code');
    expect(link.register('not hex', 'octo-cat')).toBe('no-code');
    expect(link.register(code, 'someone-else')).toBe('other-account');
    clock.set('2026-10-17T08:10:00.000Z');
    expect(link.register(code, 'octo-cat')).toBe('no-code');
    expect(link.view().link?.state).toBe('pending');
    expect(link.view().registrationCode).toBeUndefined();
    expect(events.map((e) => e.type)).toEqual(['cloud_link.linked', 'cloud_link.registration_code_minted']);
  });

  it('a new code replaces the one before; an unlink removes the code; a link again keeps the instance id and is pending until it registers again', () => {
    const { instance, link } = setup();
    const installId = instance.settings.instanceId();
    link.link('octo-cat', 'admin');
    const first = link.mintRegistrationCode('admin'), second = link.mintRegistrationCode('admin');
    expect(link.register(first.code, 'octo-cat')).toBe('no-code');
    expect(link.register(second.code, 'octo-cat')).toBe('registered');

    const again = link.mintRegistrationCode('admin');
    expect(link.unlink('admin')).toEqual({ link: null });
    expect(instance.settings.getCloudRegistrationCode()).toBeUndefined();
    expect(link.link('octo-cat', 'admin').link).toMatchObject({ installId, state: 'pending' });
    expect(link.view().link).not.toHaveProperty('registeredAt');
    expect(link.register(again.code, 'octo-cat')).toBe('no-code');
    expect(link.register(link.mintRegistrationCode('admin').code, 'octo-cat')).toBe('registered');
    expect(link.view().link).toMatchObject({ installId, state: 'registered' });
  });
});
