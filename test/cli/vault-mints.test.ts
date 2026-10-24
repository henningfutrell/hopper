// `hopper vault set <name> --mints <kind>/<name>|none` (issue #791): the call the operator CLI makes, before any daemon.
// The Vault page's Mints for, `mints` on `POST /ui/api/vault` `set`; none sends null (a plain secret again),
// and leaving it out sends no `mints` (the secret keeps what it mints for). The integration test runs it on a daemon
// (test/integration/operator-cli-vault.test.ts).
import { describe, expect, it } from 'vitest';
import { OperatorRefusal } from '../../src/cli-operator-call.ts';
import { vaultCall } from '../../src/cli-operator-vault.ts';

const VALUE = '{"AccessKeyId":"AKIAEXAMPLE","SecretAccessKey":"secret"}';
const body = async (args: string[]) => {
  const call = vaultCall(args, () => VALUE);
  expect(call).toMatchObject({ role: 'admin', path: '/ui/api/vault' });
  return await call.body!(undefined as never);
};

describe('hopper vault set --mints (issue #791)', () => {
  it('sends what the credential mints for, null for none, and nothing when left out', async () => {
    expect(await body(['set', 'AWS_MINT', '--mints', 'aws-account/123456789012'])).toEqual({ action: 'set', name: 'AWS_MINT', value: VALUE, mints: { kind: 'aws-account', name: '123456789012' } });
    expect(await body(['set', 'KUBE_MINT', '--mints', 'cluster/lab', '--scope', 'lab'])).toEqual({ action: 'set', name: 'KUBE_MINT', value: VALUE, scope: 'lab', mints: { kind: 'cluster', name: 'lab' } });
    expect(await body(['set', 'AWS_MINT', '--mints', 'none'])).toEqual({ action: 'set', name: 'AWS_MINT', value: VALUE, mints: null });
    expect(await body(['set', 'AWS_MINT'])).toEqual({ action: 'set', name: 'AWS_MINT', value: VALUE });
  });

  it('refuses a kind a minting credential does not mint for, a bad name, and a shared secret, before any call', () => {
    expect(() => vaultCall(['set', 'X', '--mints', 'namespace/lab/web'], () => VALUE)).toThrow(new OperatorRefusal('--mints namespace/lab/web: write aws-account/<account id>, cluster/<name> or database/<cluster>/<namespace>/<database>, or none'));
    expect(() => vaultCall(['set', 'X', '--mints', 'cluster'], () => VALUE)).toThrow(/--mints cluster: write/);
    expect(() => vaultCall(['set', 'X', '--mints', 'cluster/a b'], () => VALUE)).toThrow(/is not a name a minting credential mints for/);
    expect(() => vaultCall(['set', 'X', '--mints', 'cluster/lab', '--shared'], () => VALUE)).toThrow(/a shared secret mints nothing/);
    expect(() => vaultCall(['remove', 'X', '--mints', 'none'], () => VALUE)).toThrow(/usage: hopper vault \| hopper vault set/);
  });
});
