// The cloud link's messages (issue #465, design.md "The cloud link's messages"): what hopper.io may send the instance about
// its registration, and what the instance answers. The cloud link's agent (issue #464) hands each message it takes to
// `receive` and sends the answer back; before an unlink closes the connection it sends `unlinkedMessage`. Only the two
// closed message types count; anything else is refused, recorded, and changes nothing (docs/hopper-io-security.md R1, R6,
// R7). Over the real instance store.
//   Scenario: hopper.io sends the registration code: the instance registers and answers the outcome
//   Scenario: hopper.io sends the removal: the instance is pending again and answers the outcome
//   Scenario: a message that is too large, not JSON, of another type or of another shape is refused, recorded, and
//     changes nothing
//   Scenario: an unlink tells hopper.io which instance and account it ended
import { afterEach, describe, expect, it } from 'vitest';
import type { InstanceStore } from '../../src/domain/store.ts';
import type { NewEvent } from '../../src/domain/types.ts';
import { CLOUD_MESSAGE_MAX_BYTES, createCloudLinkMessages, unlinkedMessage } from '../../src/http/cloud-link-messages.ts';
import { createCloudLink, type CloudLink } from '../../src/http/cloud-link.ts';
import { openInstanceStore } from '../../src/store/index.ts';
import { installFromBefore, testDatabaseUrl } from '../support/database.ts';
import { systemOf } from '../support/system-secrets.ts';
import { fixedClock } from '../store/helpers.ts';

const closers: (() => void)[] = [];
afterEach(() => { for (const c of closers.splice(0)) c(); });

function setup(): { instance: InstanceStore; link: CloudLink; receive: (text: string) => unknown; events: NewEvent[] } {
  const url = installFromBefore(testDatabaseUrl());
  const instance = openInstanceStore({ url, clock: fixedClock() });
  closers.push(() => instance.close());
  const events: NewEvent[] = [];
  const append = (e: NewEvent) => { events.push(e); };
  const link = createCloudLink({ settings: instance.settings, secrets: systemOf({ vault: instance.vault, events: { append: (e) => e }, tx: instance.tx }), events: { append }, now: () => new Date('2026-10-17T08:00:00.000Z') });
  const messages = createCloudLinkMessages({ cloudLink: link, events: { append } });
  return { instance, link, receive: (text) => JSON.parse(messages.receive(text)), events };
}

describe('the cloud link\'s messages', () => {
  it('hopper.io sends the registration code: the instance registers and answers the outcome', () => {
    const { instance, link, receive } = setup();
    link.link('octo-cat', 'admin');
    const { code } = link.mintRegistrationCode('admin');

    expect(receive(JSON.stringify({ type: 'register', code: 'f'.repeat(64), account: 'octo-cat' }))).toEqual({ type: 'registration', outcome: 'no-code' });
    expect(receive(JSON.stringify({ type: 'register', code, account: 'someone-else' }))).toEqual({ type: 'registration', outcome: 'other-account' });
    expect(receive(JSON.stringify({ type: 'register', code, account: 'octo-cat' }))).toEqual({ type: 'registration', outcome: 'registered' });
    expect(link.view().link).toMatchObject({ installId: instance.settings.instanceId(), state: 'registered' });
    expect(receive(JSON.stringify({ type: 'register', code, account: 'octo-cat' }))).toEqual({ type: 'registration', outcome: 'no-code' });
  });

  it('hopper.io sends the removal: the instance is pending again and answers the outcome', () => {
    const { link, receive } = setup();
    expect(receive(JSON.stringify({ type: 'unregister', account: 'octo-cat' }))).toEqual({ type: 'unregistration', outcome: 'not-linked' });
    link.link('octo-cat', 'admin');
    expect(receive(JSON.stringify({ type: 'register', code: link.mintRegistrationCode('admin').code, account: 'octo-cat' }))).toEqual({ type: 'registration', outcome: 'registered' });

    expect(receive(JSON.stringify({ type: 'unregister', account: 'someone-else' }))).toEqual({ type: 'unregistration', outcome: 'other-account' });
    expect(receive(JSON.stringify({ type: 'unregister', account: 'octo-cat' }))).toEqual({ type: 'unregistration', outcome: 'unregistered' });
    expect(link.view().link?.state).toBe('pending');
    expect(receive(JSON.stringify({ type: 'unregister', account: 'octo-cat' }))).toEqual({ type: 'unregistration', outcome: 'not-registered' });
  });

  it('a message that is too large, not JSON, of another type or of another shape is refused, recorded, and changes nothing', () => {
    const { link, receive, events } = setup();
    link.link('octo-cat', 'admin');
    const { code } = link.mintRegistrationCode('admin');
    const before = events.length;

    const tooLarge = JSON.stringify({ type: 'register', code, account: 'octo-cat', pad: 'x'.repeat(CLOUD_MESSAGE_MAX_BYTES) });
    expect(receive(tooLarge)).toEqual({ type: 'refused', reason: 'too-large' });
    expect(receive('{"type":"register"')).toEqual({ type: 'refused', reason: 'not-json' });
    expect(receive(JSON.stringify({ type: 'job.start', repo: 'octo-cat/app' }))).toEqual({ type: 'refused', reason: 'unknown-type' });
    expect(receive(JSON.stringify(['register', code, 'octo-cat']))).toEqual({ type: 'refused', reason: 'unknown-type' });
    expect(receive(JSON.stringify({ type: 'register', code, account: 'octo-cat', role: 'admin' }))).toEqual({ type: 'refused', reason: 'bad-shape' });
    expect(receive(JSON.stringify({ type: 'unregister' }))).toEqual({ type: 'refused', reason: 'bad-shape' });

    expect(link.view().link?.state).toBe('pending');
    expect(link.view().registrationCode).toBeDefined();
    expect(events.slice(before)).toEqual(['too-large', 'not-json', 'unknown-type', 'unknown-type', 'bad-shape', 'bad-shape'].map((reason) => ({ type: 'cloud_link.message_refused', data: { reason } })));
    expect(JSON.stringify(events)).not.toContain(code);

    expect(receive(JSON.stringify({ type: 'register', code, account: 'octo-cat' }))).toEqual({ type: 'registration', outcome: 'registered' });
  });

  it('an unlink tells hopper.io which instance and account it ended', () => {
    const { instance, link } = setup();
    const linked = link.link('octo-cat', 'admin').link!;
    expect(JSON.parse(unlinkedMessage(linked))).toEqual({ type: 'unlinked', installId: instance.settings.instanceId(), account: 'octo-cat' });
  });
});
