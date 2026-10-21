// `hopper usage tokens [--job <id>] [--repo <owner/repo>] [--since <date>] [--by <group>]` (issue #2302): the call the
// operator CLI makes, before any daemon. It reads GET /api/usage/tokens, as the UI and an agent do.
import { describe, expect, it } from 'vitest';
import { usageCall } from '../../src/cli-operator-usage.ts';

describe('hopper usage tokens (issue #2302)', () => {
  it('reads the token ledger by repository, or with the filters and group it is given', () => {
    expect(usageCall(['tokens'])).toEqual({ role: 'viewer', path: '/api/usage/tokens' });
    expect(usageCall(['tokens', '--repo', 'octo/shed', '--since', '2026-10-01', '--by', 'day']))
      .toEqual({ role: 'viewer', path: '/api/usage/tokens?by=day&repo=octo%2Fshed&since=2026-10-01' });
  });

  it('reads one job\'s token use, per model', () => {
    expect(usageCall(['tokens', '--job', 'j1'])).toEqual({ role: 'viewer', path: '/api/jobs/j1/tokens' });
  });

  it('refuses another verb, a stray word and a job with other filters, before any call', () => {
    expect(() => usageCall([])).toThrow(/usage: hopper usage tokens/);
    expect(() => usageCall(['cost'])).toThrow(/usage: hopper usage tokens/);
    expect(() => usageCall(['tokens', 'more'])).toThrow(/usage: hopper usage tokens/);
    expect(() => usageCall(['tokens', '--job', 'j1', '--by', 'day'])).toThrow(/usage: hopper usage tokens/);
  });
});
