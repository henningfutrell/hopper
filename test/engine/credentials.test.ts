// A job's way to the hopper placed on its machine (issues #563, #695, #2040). A job that ran on its machine before (its
// agent session is known) keeps the variables its start gave it when its files cannot be placed again: a resume or a
// turn never takes HOPPER_GH and git's way to GitHub away from a job mid-work. Fakes only at the machine shell's seam.
import { describe, expect, it } from 'vitest';
import type { JobProxyCredentials, MachineShell } from '../../src/domain/ports.ts';
import type { Job, MachineSnapshot } from '../../src/domain/types.ts';
import { placeCredentials, Unreached } from '../../src/engine/credentials.ts';

const MACHINE = { id: 'seat-1' } as MachineSnapshot;
const SCRATCH = '/work/.worktrees/@scratch/job-1';
const PROXY: JobProxyCredentials = {
  url: 'http://127.0.0.1:1',
  files: { 'hopper-gh': '#!/bin/sh\n', 'proxy-token': 'token' },
  paths: { HOPPER_GH: 'hopper-gh', HOPPER_PROXY_TOKEN: 'proxy-token' },
  vars: { HOPPER_URL: 'http://127.0.0.1:1', GIT_CONFIG_COUNT: '1' },
};
const VARIABLES = { HOPPER_GH: `${SCRATCH}/credentials/hopper-gh`, HOPPER_PROXY_TOKEN: `${SCRATCH}/credentials/proxy-token`, HOPPER_URL: 'http://127.0.0.1:1', GIT_CONFIG_COUNT: '1' };

/** A machine shell whose reach check answers `reach` and whose credential writes fail with `fails`, when set. */
const shell = (o: { reach?: () => Promise<string | undefined>; fails?: string } = {}): MachineShell & { kept: string[] } => {
  const kept: string[] = [];
  return {
    kept,
    async reap() { return { kept: [] }; },
    async survey() { return { scopes: [], processes: [], scratch: [] }; },
    async discover() { throw new Error('not asked'); },
    reach: o.reach ?? (async () => undefined),
    async keepCredential(_jobId, dir, file) {
      if (o.fails) throw new Error(o.fails);
      kept.push(`${dir}/${file}`);
    },
  };
};
const engine = { jobProxy: () => PROXY };
const fresh = { id: 'job-1' } as Job;
const started = { id: 'job-1', agentSession: 'session-1' } as Job;

describe('placeCredentials (issues #563, #2040)', () => {
  it('keeps the files on the machine and gives the variables that point there', async () => {
    const s = shell();
    expect(await placeCredentials(engine, fresh, MACHINE, s, SCRATCH, false, () => {})).toEqual(VARIABLES);
    expect(s.kept).toEqual([`${SCRATCH}/credentials/hopper-gh`, `${SCRATCH}/credentials/proxy-token`]);
  });

  it('a job that ran there before keeps its variables when its files cannot be placed again, and says so', async () => {
    const notes: string[] = [];
    expect(await placeCredentials(engine, started, MACHINE, shell({ fails: 'the machine did not answer' }), SCRATCH, false, (l) => notes.push(l))).toEqual(VARIABLES);
    expect(notes).toEqual([expect.stringMatching(/the machine did not answer.*keeps the hopper's GitHub proxy its start placed/)]);
  });

  it('a job that ran there before keeps its variables when the reach check cannot run', async () => {
    const notes: string[] = [];
    const s = shell({ reach: async () => { throw new Error('the connection dropped'); } });
    expect(await placeCredentials(engine, started, MACHINE, s, SCRATCH, false, (l) => notes.push(l))).toEqual(VARIABLES);
    expect(notes).toEqual([expect.stringMatching(/the connection dropped/)]);
  });

  it('a fresh job runs without the proxy when its files cannot be placed, and says so', async () => {
    const notes: string[] = [];
    expect(await placeCredentials(engine, fresh, MACHINE, shell({ fails: 'not there' }), SCRATCH, false, (l) => notes.push(l))).toEqual({});
    expect(notes).toEqual([expect.stringMatching(/runs without the hopper's GitHub proxy: not there/)]);
  });

  it('a machine that cannot reach the hopper throws, whether the job ran there before or not', async () => {
    const s = shell({ reach: async () => 'this machine cannot reach the hopper at http://127.0.0.1:1' });
    await expect(placeCredentials(engine, fresh, MACHINE, s, SCRATCH, false, () => {})).rejects.toBeInstanceOf(Unreached);
    await expect(placeCredentials(engine, started, MACHINE, s, SCRATCH, false, () => {})).rejects.toBeInstanceOf(Unreached);
  });
});
