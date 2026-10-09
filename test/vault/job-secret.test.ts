// Issue #558, slice 3: a job on a machine whose client serves the vault is told where its helper is — HOPPER_SECRET,
// beside its proxy token (HOPPER_TOKEN_FILE, issue #563) — and nothing else of the vault: no value, no variable
// holding one. A machine whose client says no helper (an ssh target, this machine, an older client) gets none.
import { describe, expect, it } from 'vitest';
import { createUserGitHubProxy } from '../../src/users/github-proxy.ts';
import type { Job, MachineSnapshot } from '../../src/domain/types.ts';
import { mintLinkKey } from '../../src/client/link.ts';

const proxy = createUserGitHubProxy({
  user: { id: 'u1', name: 'u1' } as never, store: {} as never, linkPrivateKey: mintLinkKey().privateKey, accounts: {} as never,
  url: () => 'http://hopper:4790',
});
const job = { id: 'j1' } as Job;
const machine = (client?: MachineSnapshot['client']): MachineSnapshot => ({ id: 'box', label: 'box', maxLanes: 1, online: true, executors: ['herdr-claude'], ...(client ? { client } : {}) });

describe('the job is told where its vault helper is', () => {
  it('a client that serves the vault: HOPPER_SECRET is its helper; nothing else of the vault', () => {
    const p = proxy.jobProxy(job, machine({ release: 'r', current: true, vault: '/home/agent/.config/hopper-client/hopper-secret' }))!;
    expect(p.vars).toMatchObject({ HOPPER_SECRET: '/home/agent/.config/hopper-client/hopper-secret' });
    expect(Object.keys(p.vars).filter((k) => k.startsWith('HOPPER_')).sort()).toEqual(['HOPPER_SECRET', 'HOPPER_URL']);
  });

  it('a machine whose client serves none: no HOPPER_SECRET', () => {
    expect(proxy.jobProxy(job, machine({ release: 'r', current: true }))!.vars.HOPPER_SECRET).toBeUndefined();
    expect(proxy.jobProxy(job, machine())!.vars.HOPPER_SECRET).toBeUndefined();
  });
});
