// Issue #2639 part 4: an approval of a new egress host is kept only once the egress proxy holds the template's hosts.
import { describe, expect, it } from 'vitest';
import { withLiveEgress } from '../../src/vault/live-egress.ts';
import type { Vault } from '../../src/vault/vault.ts';

function fakeVault(pending: string[], egress: string[]) {
  const approved: string[] = [];
  const v = {
    view: () => ({ templates: [{ name: 'e2e', egress, pending: { egress: pending } }] }),
    approveTemplate: async (name: string) => { approved.push(name); return { ok: true }; },
  } as unknown as Vault;
  return { v, approved };
}

describe('withLiveEgress (issue #2639 part 4)', () => {
  it('puts every egress host of the template in the proxy before the approval', async () => {
    const { v, approved } = fakeVault(['pypi.org:443'], ['auth.example.test:443', 'pypi.org:443']);
    const allowed: string[][] = [];
    const r = await withLiveEgress(v, async (hosts) => { allowed.push([...hosts]); expect(approved).toEqual([]); }).approveTemplate('e2e', 'admin');
    expect(r).toEqual({ ok: true });
    expect(allowed).toEqual([['auth.example.test:443', 'pypi.org:443']]);
    expect(approved).toEqual(['e2e']);
  });

  it('keeps no approval when the proxy does not take the hosts, and says why', async () => {
    const { v, approved } = fakeVault(['pypi.org:443'], ['pypi.org:443']);
    const r = await withLiveEgress(v, () => Promise.reject(new Error('the egress proxy did not take the allowlist in 30 s (timed out)'))).approveTemplate('e2e', 'admin');
    expect(r).toMatchObject({ ok: false, code: 'unavailable' });
    expect(!r.ok && r.error).toContain('the egress proxy did not take the allowlist');
    expect(approved).toEqual([]);
  });

  it('asks nothing of the proxy when no egress host is new, or for a template it does not know', async () => {
    const { v, approved } = fakeVault([], ['auth.example.test:443']);
    let asked = 0;
    const live = withLiveEgress(v, async () => { asked++; });
    await live.approveTemplate('e2e', 'admin');
    await live.approveTemplate('none', 'admin');
    expect(asked).toBe(0);
    expect(approved).toEqual(['e2e', 'none']);
  });
});
