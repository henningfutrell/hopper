// The outgoing secret scan of the cloud link (issue #2039 part 2, docs/hopper-io-security.md R4): the instance scans each
// message before it sends it to hopper.io, and drops one that holds a secret. Pure.
//   Scenario: a token, a key or a private key is a secret; the public halves the hello names are not
//   Scenario: a secret the instance holds is found by its value, in any form the patterns miss
import { describe, expect, it } from 'vitest';
import { outgoingSecret } from '../../src/http/cloud-link-scan.ts';

const PUBLIC = 'aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5zA7bC9d';

describe('the outgoing secret scan', () => {
  it('a token, a key or a private key is a secret; the public halves the hello names are not', () => {
    const none = { publicKeys: [PUBLIC], held: [] };
    expect(outgoingSecret(JSON.stringify({ type: 'heartbeat', sentAt: '2026-10-19T08:00:00.000Z' }), none)).toBe(false);
    expect(outgoingSecret(JSON.stringify({ type: 'hello', publicKey: PUBLIC, proof: 'p'.repeat(86) }), none)).toBe(false);
    expect(outgoingSecret(JSON.stringify({ type: 'hello', publicKey: PUBLIC }), { publicKeys: [], held: [] })).toBe(true);
    expect(outgoingSecret(JSON.stringify({ version: `ghp_${'a1B2'.repeat(9)}` }), none)).toBe(true);
    expect(outgoingSecret(JSON.stringify({ version: 'f'.repeat(64) }), none)).toBe(true);
    expect(outgoingSecret(JSON.stringify({ v: '-----BEGIN PRIVATE KEY-----\nMC4CAQ\n-----END PRIVATE KEY-----' }), none)).toBe(true);
    expect(outgoingSecret(JSON.stringify({ machines: [{ key: 'Zk3m-Q9_x2LpW7aR0tYb5c' }] }), none)).toBe(false);
  });

  it('a secret the instance holds is found by its value, in any form the patterns miss', () => {
    expect(outgoingSecret(JSON.stringify({ v: 'plainword' }), { publicKeys: [], held: ['plainword'] })).toBe(true);
    expect(outgoingSecret(JSON.stringify({ v: 'other' }), { publicKeys: [], held: ['plainword', ''] })).toBe(false);
  });
});
