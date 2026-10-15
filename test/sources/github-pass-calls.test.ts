// The calls a GitHub source's pass made (issue #1264): its REST and GraphQL calls, which the sync loop keeps in the
// call log so Sources shows each source's GitHub call volume. A call outside the pass does not count for it.
import { describe, expect, it } from 'vitest';
import { createGitHubTraffic } from '../../src/github-limiter/traffic.ts';
import { passReads } from '../../src/sources/github/pass-reads.ts';
import { createFakeGitHub } from '../../src/sources/index.ts';

describe('the calls of a pass (issue #1264)', () => {
  it('the traffic count tells each pass its REST and GraphQL calls when it ends', async () => {
    const traffic = createGitHubTraffic({ log: () => undefined });
    const told: number[] = [];
    traffic.call('GET', 'https://api.github.com/user'); // between passes: not this pass's
    await traffic.pass('github', async () => {
      traffic.call('GET', 'https://api.github.com/repos/o/r/issues');
      traffic.call('POST', 'https://api.github.com/graphql', 'query { viewer { login } }');
      traffic.gitFetch('o/r'); // a git fetch is no API call
    }, (calls) => { told.push(calls); });
    expect(told).toEqual([2]);
  });

  it('a source\'s pass reads say how many calls its last pass made', async () => {
    const traffic = createGitHubTraffic({ log: () => undefined });
    const r = passReads(createFakeGitHub(), 'github', traffic);
    expect(r.calls()).toBe(0);
    await r.pass(async () => { traffic.call('GET', 'https://api.github.com/repos/o/r/issues'); });
    expect(r.calls()).toBe(1);
    await r.pass(async () => undefined);
    expect(r.calls()).toBe(0);
  });
});
