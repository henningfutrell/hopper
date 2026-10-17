// Unregistering the instance at hopper.io (issue #465, design.md "Unregistering at hopper.io"): the account owner removes
// the instance at hopper.io, and hopper.io says so over the cloud link. The instance takes it as a fact about its
// registration only: the link goes back to pending, its record and everything else on the instance stay. Over the real
// instance store.
//   Scenario: hopper.io removes a registered instance: the link is pending again, with the same id, and a new code
//     registers it again
//   Scenario: no link, another account or a pending link: nothing changes and nothing is recorded
//   Scenario: an unregister changes the link record's state only; every other row is as it was
import { afterEach, describe, expect, it } from 'vitest';
import type { InstanceStore } from '../../src/domain/store.ts';
import type { NewEvent } from '../../src/domain/types.ts';
import { createCloudLink, type CloudLink } from '../../src/http/cloud-link.ts';
import { openDb } from '../../src/store/db.ts';
import { openInstanceStore } from '../../src/store/index.ts';
import { installFromBefore, testDatabaseUrl } from '../support/database.ts';
import { fixedClock } from '../store/helpers.ts';

const closers: (() => void)[] = [];
afterEach(() => { for (const c of closers.splice(0)) c(); });

function setup(): { url: string; instance: InstanceStore; link: CloudLink; events: NewEvent[] } {
  const url = installFromBefore(testDatabaseUrl());
  const instance = openInstanceStore({ url, clock: fixedClock() });
  closers.push(() => instance.close());
  const events: NewEvent[] = [];
  const link = createCloudLink({ settings: instance.settings, events: { append: (e) => { events.push(e); } }, now: () => new Date('2026-10-17T08:00:00.000Z') });
  return { url, instance, link, events };
}

/** Links the instance to octo-cat and registers it there. */
function registered(link: CloudLink): void {
  link.link('octo-cat', 'admin');
  expect(link.register(link.mintRegistrationCode('admin').code, 'octo-cat')).toBe('registered');
}

describe('unregistering the instance at hopper.io', () => {
  it('hopper.io removes a registered instance: the link is pending again, with the same id, and a new code registers it again', () => {
    const { instance, link, events } = setup();
    const installId = instance.settings.instanceId();
    registered(link);

    expect(link.unregister('Octo-Cat')).toBe('unregistered');
    expect(link.view()).toEqual({ link: { installId, account: 'octo-cat', state: 'pending', linkedAt: '2026-10-17T08:00:00.000Z', by: 'admin' } });
    expect(events.at(-1)).toEqual({ type: 'cloud_link.unregistered', data: { installId, account: 'octo-cat' } });
    expect(link.unregister('octo-cat')).toBe('not-registered');

    expect(link.register(link.mintRegistrationCode('admin').code, 'octo-cat')).toBe('registered');
    expect(link.view().link).toMatchObject({ installId, state: 'registered' });
  });

  it('no link, another account or a pending link: nothing changes and nothing is recorded', () => {
    const { link, events } = setup();
    expect(link.unregister('octo-cat')).toBe('not-linked');
    link.link('octo-cat', 'admin');
    expect(link.unregister('octo-cat')).toBe('not-registered');
    expect(link.register(link.mintRegistrationCode('admin').code, 'octo-cat')).toBe('registered');
    expect(link.unregister('someone-else')).toBe('other-account');
    expect(link.view().link?.state).toBe('registered');
    expect(events.map((e) => e.type)).toEqual(['cloud_link.linked', 'cloud_link.registration_code_minted', 'cloud_link.registered']);
  });

  it('an unregister changes the link record\'s state only; every other row is as it was', () => {
    const { url, instance, link } = setup();
    instance.settings.setAllowedHosts(['hopper.example.net']);
    registered(link);
    const raw = openDb(url);
    closers.push(() => raw.close());
    const schema = new URL(url).searchParams.get('schema')!;
    const rows = () => raw.all(`SELECT key, value FROM "${schema}".settings ORDER BY key`) as { key: string; value: string }[];

    const before = rows();
    link.unregister('octo-cat');
    const after = rows();
    expect(after.filter((r) => r.key !== 'cloudLink')).toEqual(before.filter((r) => r.key !== 'cloudLink'));
    expect(after.map((r) => r.key)).toEqual(before.map((r) => r.key));
  });
});
