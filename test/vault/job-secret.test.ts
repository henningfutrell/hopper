// Issue #558, slice 3: a job on a box whose client serves the vault is told where its helper is — HOPPER_SECRET,
// beside its proxy token (HOPPER_TOKEN_FILE, issue #563) — and nothing else of the vault: no value, no variable
// holding one. A machine whose client says no helper (an ssh target, this machine, an older client) gets none, and so
// does a machine that is no box of a template (issue #652): the vault gives it nothing, so its jobs get no helper.
import { describe, expect, it } from 'vitest';
import { createUserGitHubProxy } from '../../src/users/github-proxy.ts';
import type { Job, MachineSnapshot } from '../../src/domain/types.ts';
import { mintLinkKey } from '../../src/client/link.ts';

// No skill of the user's own, no work skill chosen yet: the job gets the built-in one (issue #1911). The job egress
// route is off (issue #2849).
const noSkills = {
  events: { recent: () => [], append: () => undefined }, skillLibrary: { getWorkSkills: () => undefined, versions: () => [] },
  settings: { getJobEgress: () => ({ route: false }) },
};
const proxy = createUserGitHubProxy({
  user: { id: 'u1', name: 'u1' } as never, store: noSkills as never, linkPrivateKey: mintLinkKey().privateKey, accounts: { endpoints: () => ({ url: 'https://github.com', apiUrl: 'https://api.github.com' }) } as never,
  url: () => 'http://hopper:4790', artifactUrl: (id) => id, publicUrl: () => undefined, sources: () => [], clock: { now: () => new Date() }, logger: { warn: () => undefined },
});
const job = { id: 'j1', spec: {} } as Job;
const machine = (client?: MachineSnapshot['client'], template: MachineSnapshot['template'] = { name: 'kube' }): MachineSnapshot => ({
  id: 'box', label: 'box', maxLanes: 1, online: true, executors: ['herdr-claude'], ...(client ? { client } : {}), ...(template ? { template } : {}),
});
const HELPER = '/home/agent/.config/hopper-client/hopper-secret';

describe('the job is told where its vault helper is', () => {
  it('a box whose client serves the vault: HOPPER_SECRET is its helper; nothing else of the vault', () => {
    const p = proxy.jobProxy(job, machine({ release: 'r', current: true, vault: HELPER }))!;
    expect(p.vars).toMatchObject({ HOPPER_SECRET: HELPER });
    expect(Object.keys(p.vars).filter((k) => k.startsWith('HOPPER_')).sort()).toEqual(['HOPPER_SECRET', 'HOPPER_URL']);
  });

  it('a machine whose client serves none: no HOPPER_SECRET', () => {
    expect(proxy.jobProxy(job, machine({ release: 'r', current: true }))!.vars.HOPPER_SECRET).toBeUndefined();
    expect(proxy.jobProxy(job, machine())!.vars.HOPPER_SECRET).toBeUndefined();
  });

  it('a computer that is no box of a template, though its client serves the vault: no HOPPER_SECRET (issue #652)', () => {
    const p = proxy.jobProxy(job, machine({ release: 'r', current: true, vault: HELPER }, null as never))!;
    expect(p.vars.HOPPER_SECRET).toBeUndefined();
    expect(Object.keys(p.vars).filter((k) => k.startsWith('HOPPER_'))).toEqual(['HOPPER_URL']);
  });
});
