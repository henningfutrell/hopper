// Settings → hopper.io, the connection's state (issue #2039 part 2): the page's pure model says whether this hopper is
// connected to hopper.io now, and when not, why and when it tries again.
import { describe, expect, it } from 'vitest';
import { connectionLine } from '../../ui/src/model/cloud-link.ts';
import { systemSecretTitle } from '../../ui/src/model/vault-system.ts';

const AT = '2026-10-19T12:00:00.000Z';

describe('the cloud link\'s connection on the page', () => {
  it('says each state in plain words', () => {
    expect(connectionLine({ state: 'off' })).toBe('Not connected: this hopper is not linked');
    expect(connectionLine({ state: 'no-pin' })).toBe('Not connected: this version of the hopper has no key for hopper.io yet');
    expect(connectionLine({ state: 'no-key' })).toBe('Not connected: the link has no key. Rotate the key to make one');
    expect(connectionLine({ state: 'connecting' })).toBe('Connecting to hopper.io…');
    expect(connectionLine({ state: 'connected', since: AT })).toBe(`Connected to hopper.io since ${new Date(AT).toLocaleString()}`);
    expect(connectionLine({ state: 'waiting', retryAt: AT, problem: 'hopper.io cannot be reached' })).toBe(`Not connected: hopper.io cannot be reached. Next try ${new Date(AT).toLocaleTimeString()}`);
    expect(connectionLine({ state: 'revoked', since: AT })).toBe('Not connected: hopper.io revoked the key. Rotate the key, then register again');
    expect(connectionLine(undefined)).toBe('Not connected');
  });

  it('names the key before a rotation apart in the vault', () => {
    expect(systemSecretTitle({ name: 'cloud-link.key', kind: 'cloud-link' })).toBe('cloud link key: private half');
    expect(systemSecretTitle({ name: 'cloud-link.previous-key', kind: 'cloud-link' })).toBe('cloud link key before a rotation: private half');
  });
});
