// Whose ask a box's vault ask is (issue #1004). A job on a seat does not run on the box, so the box's ask for it is
// refused. Since issue #1349 no box step asks through a box: a box step runs in a sandbox of its own, minted for it.
//
// Feature: a box's vault ask
//   Scenario: a job that runs on another machine is refused by the box
//   Scenario: a job not at work is refused
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

describe('a box\'s vault ask (issue #1004)', () => {
  it('a job that runs on another machine is refused by the box', () => {
    expect(boxAsk(options(), token, 'ka')).toMatchObject({ refused: 'the job does not run on box-a' });
  });

  it('a job not at work is refused', () => {
    const ended = { ...job, status: 'finished' } as Job;
    expect(boxAsk(options({ job: () => ended }), token, 'ka')).toMatchObject({ refused: expect.stringMatching(/not at work/) });
  });
});
