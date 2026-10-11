// Issue #697: the vault in its own container says which commit it runs at /health, so the hopper names a vault container
// left on another version (an update that recreated the hopper service alone).
import { afterEach, describe, expect, it } from 'vitest';
import { startVaultServer } from '../../src/vault/server.ts';

const stops: (() => Promise<void>)[] = [];
afterEach(async () => { for (const s of stops.splice(0)) await s(); });

const start = async (commit?: string) => {
  // /health opens no database: the URL is never dialled.
  const s = await startVaultServer({ env: { HOPPER_DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none', HOPPER_VAULT_KEY: 'k'.repeat(40) }, host: '127.0.0.1', port: 0, ...(commit ? { commit } : {}) });
  stops.push(() => s.stop());
  return (await fetch(new URL('/health', s.url))).json();
};

describe('the vault container\'s health (issue #697)', () => {
  it('answers the commit it runs, when its build knows it', async () => {
    expect(await start('c'.repeat(40))).toEqual({ ok: true, commit: 'c'.repeat(40) });
    expect(await start()).toEqual({ ok: true });
  });
});
