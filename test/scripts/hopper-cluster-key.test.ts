// scripts/hopper-cluster.sh migrate (issue #1373, docs/kubernetes.md "The master key"): with the master key Secret a person
// made (--master-key-secret), or one an outside store fills, the script never reads the key. A one-off pod of the
// release's image mounts the Secret and prints only its fingerprint. Stubs as in hopper-cluster.test.ts.
//
// Feature: the master key never passes through the script
//   Scenario: with the person's own Secret, a cluster pod checks its fingerprint before compose stops
//   Scenario: a Secret that is not there stops the move before anything changes; one with another key before compose stops
//   Scenario: with an outside store, the filled Secret is checked the same way
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FP, host, KEY, migrate, removeHosts } from '../support/hopper-cluster.ts';

afterEach(removeHosts);

describe('hopper-cluster.sh migrate, the master key in a Secret the script never reads', () => {
  it('with the owner\'s own Secret, never reads the master key: a cluster pod checks its fingerprint before compose stops', () => {
    const h = host({ unit: true });
    const r = migrate(h, { STUB_OWNER_SECRET: '1' }, ['--master-key-secret', 'owner-key']);
    expect(r.status, r.err).toBe(0);
    const calls = h.calls();
    // No launch source is read, no Secret value is read or written, the key reaches no node in compose.
    for (const c of calls) expect(c).not.toMatch(/master-key=\/dev\/stdin|\{\.data\.master-key\}|^podman exec -i hopperid node/);
    expect(calls).not.toContain('key-matched');
    expect(r.err).toContain(`the Secret owner-key holds the running hopper's master key (fingerprint ${FP})`);
    // The check: a pod of the hopper's image with the Secret mounted, once the release is in, before compose stops.
    const check = calls.findIndex((c) => c.startsWith('kubectl --namespace hopper run hopper-key-check '));
    expect(check).toBeGreaterThan(calls.findIndex((c) => c.startsWith('helm install')));
    expect(check).toBeLessThan(calls.indexOf('podman stop hopperid'));
    expect(calls[check]).toContain('"secretName":"owner-key"');
    expect(calls[check]).toContain('"image":"ghcr.io/henningfutrell/hopper:beta"');
    expect(calls[check]).toContain('--rm');
    const values = JSON.parse(readFileSync(join(h.home, 'values.json'), 'utf8')) as Record<string, unknown>;
    expect(values).toMatchObject({ masterKey: { existingSecret: 'owner-key' } });
  });

  it('with the owner\'s own Secret, stops before anything changes when it is not there, and before compose stops when it holds another key', () => {
    const missing = host();
    const m = migrate(missing, {}, ['--master-key-secret', 'owner-key']);
    expect(m.status).toBe(1);
    expect(m.err).toContain('no Secret owner-key with a master-key');
    expect(missing.calls().filter((c) => /^podman stop|^helm install/.test(c))).toEqual([]);

    const other = host();
    const o = migrate(other, { STUB_OWNER_SECRET: '1', STUB_SECRET_FP: '0000000000000000' }, ['--master-key-secret', 'owner-key']);
    expect(o.status).toBe(1);
    expect(o.err).toContain(`the Secret owner-key holds the master key of fingerprint 0000000000000000, the running hopper ${FP}`);
    expect(other.calls().filter((c) => /^podman stop/.test(c))).toEqual([]);
  });

  it('with an outside store, checks the filled Secret in a cluster pod: the script never reads it', () => {
    const h = host();
    const r = migrate(h, { STUB_LAUNCH_KEY: KEY }, ['--external-secret-store', 'vault', '--external-secret-key', 'hopper/master']);
    expect(r.status, r.err).toBe(0);
    const calls = h.calls();
    for (const c of calls) expect(c).not.toMatch(/master-key=\/dev\/stdin|\{\.data\.master-key\}/);
    expect(calls.some((c) => c.startsWith('kubectl --namespace hopper run hopper-key-check ') && c.includes('"secretName":"hopper-master-key"'))).toBe(true);
    expect(r.err).toContain("the Secret hopper-master-key from vault holds the running hopper's master key");
  });
});
