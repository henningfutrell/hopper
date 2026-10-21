// `hopper usage tokens [--job <id>] [--repo <owner/repo>] [--since <date>] [--by <group>] [--split <group>]` (issue #2302): the call the
// operator CLI makes, before any daemon. It reads GET /api/usage/tokens, as the UI and an agent do.
import { describe, expect, it } from 'vitest';
import { usageCall } from '../../src/cli-operator-usage.ts';

describe('hopper usage tokens (issue #2302)', () => {
  it('reads the token ledger by repository, or with the filters and group it is given', () => {
    expect(usageCall(['tokens'])).toEqual({ role: 'viewer', path: '/api/usage/tokens' });
    expect(usageCall(['tokens', '--repo', 'octo/shed', '--since', '2026-10-01', '--by', 'day']))
      .toEqual({ role: 'viewer', path: '/api/usage/tokens?by=day&repo=octo%2Fshed&since=2026-10-01' });
    // Part 2: each day split by account, as the Dashboard stacks it.
    expect(usageCall(['tokens', '--by', 'day', '--split', 'account']))
      .toEqual({ role: 'viewer', path: '/api/usage/tokens?by=day&split=account' });
  });

  it('reads one job\'s token use, per model', () => {
    expect(usageCall(['tokens', '--job', 'j1'])).toEqual({ role: 'viewer', path: '/api/jobs/j1/tokens' });
  });

  it('refuses another verb, a stray word and a job with other filters, before any call', () => {
    expect(() => usageCall([])).toThrow(/usage: hopper usage tokens/);
    expect(() => usageCall(['cost'])).toThrow(/usage: hopper usage tokens/);
    expect(() => usageCall(['tokens', 'more'])).toThrow(/usage: hopper usage tokens/);
    expect(() => usageCall(['tokens', '--job', 'j1', '--by', 'day'])).toThrow(/usage: hopper usage tokens/);
    expect(() => usageCall(['tokens', '--job', 'j1', '--split', 'repo'])).toThrow(/usage: hopper usage tokens/);
  });

  it('reads the token budget, and an admin sets it (part 3)', async () => {
    expect(usageCall(['budget'])).toEqual({ role: 'viewer', path: '/api/token-budget' });
    const set = usageCall(['budget', 'set', '--job-tokens', '5000000', '--job-cost', '2.5']);
    expect(set).toMatchObject({ role: 'admin', path: '/ui/api/token-budget' });
    expect(await set.body!(async () => undefined)).toEqual({ jobTokens: 5000000, jobCostUsd: 2.5 });
    expect(await usageCall(['budget', 'set', '--job-cost', '0']).body!(async () => undefined)).toEqual({ jobCostUsd: 0 });
    expect(() => usageCall(['budget', 'set'])).toThrow(/usage: hopper usage/);
    expect(() => usageCall(['budget', 'set', '--job-tokens', 'many'])).toThrow(/usage: hopper usage/);
    expect(() => usageCall(['budget', '--job-tokens', '5'])).toThrow(/usage: hopper usage/);
    expect(() => usageCall(['budget', 'set', '--by', 'day'])).toThrow(/usage: hopper usage/);
  });
});
