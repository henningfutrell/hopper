// Issue #585: the built-in vault backends, each through the plugin contract. HashiCorp Vault against a real server
// (dev mode); 1Password and Bitwarden through a fake of their SDK, the one seam to an outside service a test cannot
// reach. Each reads the value a reference points at, at each call; checks a reference's form without the network;
// takes its credential from the runtime (the variable its `tokenEnv` names, or that variable's `_FILE`); and says why
// it cannot read, never with a value.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PluginContext, PluginDefinition, VaultBackend } from '../../src/plugins/sdk.ts';
import hashicorpVault from '../../src/plugins/vault-backend/hashicorp-vault/index.ts';
import { onePasswordPlugin } from '../../src/plugins/vault-backend/1password/index.ts';
import { bitwardenPlugin } from '../../src/plugins/vault-backend/bitwarden/index.ts';
import { z } from 'zod';
import { startTestVault, type TestVault } from '../support/hashicorp-vault.ts';

let vault: TestVault;
beforeAll(async () => { vault = await startTestVault(); }, 120_000);
afterAll(async () => { await vault?.stop(); });

function ctx(env: Record<string, string>): PluginContext {
  return {
    clock: { now: () => new Date() }, logger: { info: () => {}, warn: () => {} }, dataDir: '/nonexistent', scratchDir: '/nonexistent', instanceName: 'b',
    env: (name) => env[name], secretName: (name) => name, userEnv: {},
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each plugin's own options
async function backend(def: PluginDefinition<'vault-backend', any>, options: Record<string, unknown>, env: Record<string, string>): Promise<VaultBackend> {
  const parsed = def.options!(z).parse(options);
  return def.create(ctx(env), parsed);
}

describe('hashicorp-vault', () => {
  it('reads the key a reference names from the KV v2 engine, now', async () => {
    await vault.write('apps/web', { password: 'first', user: 'web' });
    const b = await backend(hashicorpVault, { address: vault.addr }, { VAULT_TOKEN: vault.token });
    expect(await b.read('apps/web#password')).toBe('first');
    await vault.write('apps/web', { password: 'second' });
    expect(await b.read('apps/web#password')).toBe('second');
  });

  it('checks a reference is path#key, without the network', async () => {
    const b = await backend(hashicorpVault, { address: 'http://127.0.0.1:1' }, {});
    expect(b.check('apps/web#password')).toBeUndefined();
    expect(b.check('apps/web')).toMatch(/path#key/);
    expect(b.check('apps/../sys#x')).toMatch(/path#key/);
    expect(b.check('#password')).toMatch(/path#key/);
  });

  it('says why it cannot read: no secret there, no such key, a token it refuses, no token', async () => {
    await vault.write('apps/web', { password: 'never-in-an-error' });
    const b = await backend(hashicorpVault, { address: vault.addr }, { VAULT_TOKEN: vault.token });
    await expect(b.read('apps/nothing#password')).rejects.toThrow(/no secret at apps\/nothing/);
    await expect(b.read('apps/web#other')).rejects.toThrow(/apps\/web has no key other/);
    const wrong = await backend(hashicorpVault, { address: vault.addr }, { VAULT_TOKEN: 'not-a-token' });
    await expect(wrong.read('apps/web#password')).rejects.toThrow(/refused the token .*403/);
    const none = await backend(hashicorpVault, { address: vault.addr }, {});
    await expect(none.read('apps/web#password')).rejects.toThrow(/VAULT_TOKEN is not set/);
  });

  it('is needs-setup until its token is given', async () => {
    const options = hashicorpVault.options!(z).parse({ address: vault.addr });
    const kit = { env: () => undefined, secretName: (n: string) => n } as never;
    expect(await hashicorpVault.detect(kit, options)).toMatchObject({ status: 'needs-setup', reason: expect.stringMatching(/VAULT_TOKEN/) });
  });
});

describe('1password', () => {
  it('resolves an op:// secret reference with the service account token, one client per token', async () => {
    const made: string[] = [];
    const def = onePasswordPlugin({ connect: async (token) => { made.push(token); return { resolve: async (ref) => `value of ${ref}` }; } });
    const b = await backend(def, {}, { OP_SERVICE_ACCOUNT_TOKEN: 'ops_1' });
    expect(await b.read('op://Infra/db/password')).toBe('value of op://Infra/db/password');
    expect(await b.read('op://Infra/db/user')).toBe('value of op://Infra/db/user');
    expect(made).toEqual(['ops_1']);
  });

  it('checks a reference is op://vault/item/field, and says why it cannot read', async () => {
    const def = onePasswordPlugin({ connect: async () => ({ resolve: async () => { throw new Error('item not found'); } }) });
    const b = await backend(def, {}, { OP_SERVICE_ACCOUNT_TOKEN: 'ops_1' });
    expect(b.check('op://Infra/db/password')).toBeUndefined();
    expect(b.check('op://Infra/db/section/password')).toBeUndefined();
    expect(b.check('Infra/db/password')).toMatch(/op:\/\//);
    expect(b.check('op://Infra/db')).toMatch(/op:\/\//);
    await expect(b.read('op://Infra/db/password')).rejects.toThrow(/item not found/);
    const none = await backend(def, {}, {});
    await expect(none.read('op://Infra/db/password')).rejects.toThrow(/OP_SERVICE_ACCOUNT_TOKEN is not set/);
  });
});

describe('bitwarden', () => {
  const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

  it('reads a Secrets Manager secret by its id with the machine account\'s access token, at its server', async () => {
    const made: { token: string; apiUrl: string; identityUrl: string }[] = [];
    const def = bitwardenPlugin({ connect: async (token, urls) => { made.push({ token, ...urls }); return { get: async (id) => `value of ${id}` }; } });
    const b = await backend(def, { apiUrl: 'https://api.bitwarden.eu', identityUrl: 'https://identity.bitwarden.eu' }, { BWS_ACCESS_TOKEN: '0.abc' });
    expect(await b.read(ID)).toBe(`value of ${ID}`);
    expect(await b.read(ID)).toBe(`value of ${ID}`);
    expect(made).toEqual([{ token: '0.abc', apiUrl: 'https://api.bitwarden.eu', identityUrl: 'https://identity.bitwarden.eu' }]);
  });

  it('checks a reference is a secret id, and says why it cannot read', async () => {
    const def = bitwardenPlugin({ connect: async () => ({ get: async () => { throw new Error('404 Not Found'); } }) });
    const b = await backend(def, {}, { BWS_ACCESS_TOKEN: '0.abc' });
    expect(b.check(ID)).toBeUndefined();
    expect(b.check('db-password')).toMatch(/secret's id/);
    await expect(b.read(ID)).rejects.toThrow(/404 Not Found/);
    const none = await backend(def, {}, {});
    await expect(none.read(ID)).rejects.toThrow(/BWS_ACCESS_TOKEN is not set/);
  });
});
