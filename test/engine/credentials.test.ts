// A job's way to the hopper placed on its machine (issues #563, #695, #2040, #2233). A placement that fails is tried once
// more. A job that ran on its machine before (its agent session is known) keeps the variables its start gave it when its
// files cannot be placed again: a turn never takes HOPPER_GH and git's way to GitHub away from a job mid-work. A job that
// reopens after its end reaped its credentials dir (a continued or a parked job) has no files left to keep: it fails,
// and never resumes without its way to the hopper. Fakes only at the machine shell's seam.
import { describe, expect, it } from 'vitest';
import type { JobProxyCredentials, MachineShell } from '../../src/domain/ports.ts';
import type { Job, MachineSnapshot } from '../../src/domain/types.ts';
import { placeCredentials, Unreached } from '../../src/engine/credentials.ts';
import { matchCause, NO_WAY_TO_HOPPER } from '../../src/failures/causes.ts';

const MACHINE = { id: 'seat-1' } as MachineSnapshot;
const SCRATCH = '/work/.worktrees/@scratch/job-1';
const PROXY: JobProxyCredentials = {
  url: 'http://127.0.0.1:1',
  files: { 'hopper-gh': '#!/bin/sh\n', 'proxy-token': 'token' },
  paths: { HOPPER_GH: 'hopper-gh', HOPPER_PROXY_TOKEN: 'proxy-token' },
  vars: { HOPPER_URL: 'http://127.0.0.1:1', GIT_CONFIG_COUNT: '1' },
};
const VARIABLES = { HOPPER_GH: `${SCRATCH}/credentials/hopper-gh`, HOPPER_PROXY_TOKEN: `${SCRATCH}/credentials/proxy-token`, HOPPER_URL: 'http://127.0.0.1:1', GIT_CONFIG_COUNT: '1' };

/** A machine shell whose reach check answers `reach` and whose credential writes fail with `fails`, when set (`times`: only that many times). */
const shell = (o: { reach?: () => Promise<string | undefined>; fails?: string; times?: number } = {}): MachineShell & { kept: string[] } => {
  const kept: string[] = [];
  let failed = 0;
  return {
    kept,
    async reap() { return { kept: [] }; },
    async survey() { return { scopes: [], processes: [], scratch: [] }; },
    async discover() { throw new Error('not asked'); },
    reach: o.reach ?? (async () => undefined),
    async keepCredential(_jobId, dir, file) {
      if (o.fails && (o.times === undefined || failed < o.times)) { failed++; throw new Error(o.fails); }
      kept.push(`${dir}/${file}`);
    },
  };
};
const engine = { jobProxy: () => PROXY };
const fresh = { id: 'job-1' } as Job;
const started = { id: 'job-1', agentSession: 'session-1' } as Job;
const continued = { ...started, continued: { at: '2026-10-20T15:13:00.000Z', handoffId: 'h-1' } } as Job;
const parked = { ...started, parked: { at: '2026-10-20T15:13:00.000Z' } } as Job;
const elsewhere = { ...started, parked: { at: '2026-10-20T15:13:00.000Z', elsewhere: { at: '2026-10-20T15:13:00.000Z', checkpointAt: '2026-10-20T15:13:00.000Z', from: 'seat-2' } } } as Job;

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

  it('a placement that fails is tried once more: its files kept, its variables given', async () => {
    const notes: string[] = [];
    const s = shell({ fails: 'the connection dropped', times: 1 });
    expect(await placeCredentials(engine, continued, MACHINE, s, SCRATCH, false, (l) => notes.push(l))).toEqual(VARIABLES);
    expect(s.kept).toEqual([`${SCRATCH}/credentials/hopper-gh`, `${SCRATCH}/credentials/proxy-token`]);
    expect(notes).toEqual([]);
  });

  // Issue #2233: the end of its run reaped the credentials dir, so the variables of its start would point at nothing.
  it.each([['continued', continued], ['parked', parked]])('a %s job whose files cannot be placed again fails, never resumed without its way to the hopper', async (_kind, job) => {
    const failed = placeCredentials(engine, job, MACHINE, shell({ fails: 'the machine did not answer' }), SCRATCH, false, () => {});
    await expect(failed).rejects.toThrow(/cannot reach the hopper: .*not placed again.*the machine did not answer/);
    await expect(failed).rejects.not.toBeInstanceOf(Unreached);
    const message = await failed.then(() => '', (e: Error) => e.message);
    expect(matchCause(message, 'sig', [])?.id).toBe(NO_WAY_TO_HOPPER);
  });

  it('a machine that cannot reach the hopper throws, whether the job ran there before or not', async () => {
    const s = shell({ reach: async () => 'this machine cannot reach the hopper at http://127.0.0.1:1' });
    await expect(placeCredentials(engine, fresh, MACHINE, s, SCRATCH, false, () => {})).rejects.toBeInstanceOf(Unreached);
    await expect(placeCredentials(engine, started, MACHINE, s, SCRATCH, false, () => {})).rejects.toBeInstanceOf(Unreached);
  });

  // Issue #2355: a job that resumes elsewhere gets its checkpoint from the hopper; with no way to it there, it cannot go on.
  it('a job that resumes elsewhere and gets no way to the hopper on its machine throws, saying why', async () => {
    const none = { jobProxy: () => undefined };
    const noUrl = placeCredentials(none, elsewhere, MACHINE, shell(), SCRATCH, false, () => {});
    await expect(noUrl).rejects.toBeInstanceOf(Unreached);
    await expect(noUrl).rejects.toThrow(/cannot reach the hopper: the hopper has no URL its jobs reach it at on seat-1/);
    const noShell = placeCredentials(engine, elsewhere, MACHINE, undefined, SCRATCH, false, () => {});
    await expect(noShell).rejects.toThrow(/cannot reach the hopper: the hopper has no shell on seat-1/);
    const message = await noUrl.then(() => '', (e: Error) => e.message);
    expect(matchCause(message, 'sig', [])?.id).toBe(NO_WAY_TO_HOPPER);
    // Any other job runs without the proxy there, as before.
    expect(await placeCredentials(none, parked, MACHINE, shell(), SCRATCH, false, () => {})).toEqual({});
    expect(await placeCredentials(none, fresh, MACHINE, shell(), SCRATCH, false, () => {})).toEqual({});
  });

  // Issue #2427: a stall of the hopper's loop failed every seat's address probe. A parked job picked up on its seat then
  // reopened with no URL to reach the hopper at: its new pane had no HOPPER_URL, and it could not push its commits.
  it('a job on a machine with an address problem gets no way to the hopper there: it throws, never runs without it', async () => {
    const none = { jobProxy: () => undefined };
    const cutOff = { id: 'seat-1', addressProblem: 'the hopper cannot be reached from it: http://hopper:4790 (no connection)' } as MachineSnapshot;
    for (const job of [parked, continued, fresh]) {
      const placed = placeCredentials(none, job, cutOff, shell(), SCRATCH, false, () => {});
      await expect(placed).rejects.toBeInstanceOf(Unreached);
      await expect(placed).rejects.toThrow(/cannot reach the hopper: the hopper cannot be reached from it: http:\/\/hopper:4790 \(no connection\)/);
      const message = await placed.then(() => '', (e: Error) => e.message);
      expect(matchCause(message, 'sig', [])?.id).toBe(NO_WAY_TO_HOPPER);
    }
  });
});
