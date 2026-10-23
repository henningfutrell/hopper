// `hopper forecast --job <id> | --issue <owner/repo#N> | --pr <url> | --set <N> --repo <owner/repo>` (issue #2554 parts
// 2 and 3): the call the operator CLI makes, before any daemon. It reads GET /api/delivery-forecast, as the UI and an agent do.
import { describe, expect, it } from 'vitest';
import { forecastCall } from '../../src/cli-operator-forecast.ts';

describe('hopper forecast (issue #2554)', () => {
  it('reads the forecast of a job, an issue or a pull request', () => {
    expect(forecastCall(['--job', 'j1'])).toEqual({ role: 'viewer', path: '/api/delivery-forecast?job=j1' });
    expect(forecastCall(['--issue', 'octo/shed#7'])).toEqual({ role: 'viewer', path: '/api/delivery-forecast?issue=octo%2Fshed%237' });
    expect(forecastCall(['--pr', 'https://github.com/octo/shed/pull/12']))
      .toEqual({ role: 'viewer', path: '/api/delivery-forecast?pr=https%3A%2F%2Fgithub.com%2Focto%2Fshed%2Fpull%2F12' });
  });

  it('reads a promotion set of a repository by its number', () => {
    expect(forecastCall(['--set', '7', '--repo', 'octo/shed'])).toEqual({ role: 'viewer', path: '/api/delivery-forecast?set=7&repo=octo%2Fshed' });
  });

  it('refuses none, two, an empty one, a stray word or another option, before any call', () => {
    for (const args of [[], ['--job', 'j1', '--issue', 'octo/shed#7'], ['--job', ''], ['j1'], ['--repo', 'octo/shed'], ['--set', '7'], ['--job', 'j1', '--repo', 'octo/shed']]) {
      expect(() => forecastCall(args)).toThrow(/usage: hopper forecast/);
    }
  });
});
