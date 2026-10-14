// What a running job waits on a person for (issue #627): asked before a nudge. Pure.
import { describe, expect, it } from 'vitest';
import type { Watch } from '../../src/domain/job-stream.ts';
import type { CredentialRequest } from '../../src/domain/vault.ts';
import { nudgeCheck, personAwaited } from '../../src/engine/nudge-check.ts';
import type { Job } from '../../src/domain/types.ts';

const AT = '2026-10-10T08:00:00.000Z';
const watch = (jobId: string): Watch => ({ id: 'request-1', jobId, deadline: AT, body: { name: 'example-api' }, openedAt: AT });
const request = (job: string): CredentialRequest => ({
  id: 'cr-1', skill: 'example-api', title: 'Example API', known: false, template: 'web', secret: 'example-api',
  kinds: [], setup: '', asked: [{ job, machine: 'box-1', at: AT }], existing: [], createdAt: AT,
});
const job = { id: 'job-1' } as Job;
/** The engine's parts the check reads: the job's source, its job stream's open watches, the credential requests. */
const engine = (over: string | undefined, watches: Watch[] = [], requests: CredentialRequest[] = []) =>
  ({ overAtSource: async () => over, credentialRequests: () => requests, store: { jobStream: { openWatches: () => watches } } }) as unknown as Parameters<typeof nudgeCheck>[0];

describe('personAwaited', () => {
  it('an open watch on the job\'s stream: a skill request', () => {
    expect(personAwaited('job-1', [watch('job-1')], [])).toBe('a skill request for example-api');
  });

  it('a credential request that names the job', () => {
    expect(personAwaited('job-1', [], [request('job-1')])).toBe('a credential request for Example API');
  });

  it('another job\'s watch or request: nothing', () => {
    expect(personAwaited('job-1', [watch('job-2')], [request('job-2')])).toBeUndefined();
  });
});

describe('nudgeCheck', () => {
  it('the source first: a job whose work is over there ends done, though it waits on a person', async () => {
    expect(await nudgeCheck(engine('its issue is closed', [watch('job-1')]), job)).toEqual({ done: 'its issue is closed' });
  });

  it('then what it waits on a person for, else the nudge', async () => {
    expect(await nudgeCheck(engine(undefined, [], [request('job-1')]), job)).toEqual({ waiting: 'a credential request for Example API' });
    expect(await nudgeCheck(engine(undefined), job)).toEqual({ nudge: true });
  });
});
