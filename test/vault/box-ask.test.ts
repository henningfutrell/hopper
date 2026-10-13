// Issue #1004: whose ask a box's vault ask is. A job on a seat does not run on the box; while it runs a box step there,
// the box asks for it, and the vault takes that ask as the job's on the box — only on that box, and only while the step
// runs. Every other check stays as it was.
//
// Feature: a box step's vault ask
//   Scenario: a job that runs on another machine is refused by the box
//   Scenario: while the job runs a box step on that box, the box's ask is the job's
//   Scenario: a box step on one box gives nothing on another box
//   Scenario: a job not at work is refused, box step or not
import { describe, expect, it } from 'vitest';
import { mintLinkKey } from '../../src/client/link.ts';
import type { Job } from '../../src/domain/types.ts';
import { holdsProxyToken, proxyToken } from '../../src/github-proxy/token.ts';
import { boxAsk, type BoxAskOptions } from '../../src/vault/box.ts';

const link = mintLinkKey();
const job = { id: 'j1', status: 'running', laneId: 'seat/lane-1' } as unknown as Job;
const token = proxyToken(link.privateKey, 'u1', job.id);
const targets = () => [{ name: 'box-a', key: 'ka', template: 'asked-1' }, { name: 'box-b', key: 'kb', template: 'asked-1' }];

const options = (o: Partial<BoxAskOptions> = {}): BoxAskOptions => ({
  targets, holds: (p) => holdsProxyToken(link.privateKey, p), job: (id) => (id === job.id ? job : undefined), ...o,
});

describe('a box step\'s vault ask (issue #1004)', () => {
  it('a job that runs on another machine is refused by the box', () => {
    expect(boxAsk(options(), token, 'ka')).toMatchObject({ refused: 'the job does not run on box-a' });
  });

  it('while the job runs a box step on that box, the box\'s ask is the job\'s', () => {
    const r = boxAsk(options({ stepsOn: (jobId, machine) => jobId === 'j1' && machine === 'box-a' }), token, 'ka');
    expect(r).toEqual({ machine: { name: 'box-a', template: 'asked-1' }, job });
  });

  it('a box step on one box gives nothing on another box', () => {
    expect(boxAsk(options({ stepsOn: (_j, machine) => machine === 'box-a' }), token, 'kb')).toMatchObject({ refused: 'the job does not run on box-b' });
  });

  it('a job not at work is refused, box step or not', () => {
    const ended = { ...job, status: 'finished' } as Job;
    expect(boxAsk(options({ job: () => ended, stepsOn: () => true }), token, 'ka')).toMatchObject({ refused: expect.stringMatching(/not at work/) });
  });
});
