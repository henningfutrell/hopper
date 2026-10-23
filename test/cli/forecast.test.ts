// `hopper forecast --job <id> | --issue <owner/repo#N> | --pr <url> | --set <N> --repo <owner/repo>` (issue #2554 parts
// 2 and 3): the call the operator CLI makes, before any daemon. It reads GET /api/delivery-forecast, as the UI and an agent do.
// With `--expedite on|off` (part 4) it sets the expedite flag of the change: POST /ui/api/delivery-expedite. With `--clear <step>`
// (part 5) it clears a delivery gate of a promotion set: POST /ui/api/delivery-gate. With `--ledger` (part 6) it reads the
// delivery ledger and its accuracy: GET /api/delivery-ledger.
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

  it('sets the expedite flag of a job, an issue or a pull request', async () => {
    const post = async (args: string[]) => forecastCall(args).post!(async () => undefined);
    expect(forecastCall(['--job', 'j1', '--expedite', 'on'])).toMatchObject({ role: 'operator' });
    expect(await post(['--job', 'j1', '--expedite', 'on'])).toEqual({ path: '/ui/api/delivery-expedite', body: { job: 'j1', expedite: true } });
    expect(await post(['--issue', 'octo/shed#7', '--expedite', 'off'])).toEqual({ path: '/ui/api/delivery-expedite', body: { issue: 'octo/shed#7', expedite: false } });
    expect(await post(['--pr', 'https://github.com/octo/shed/pull/12', '--expedite', 'on']))
      .toEqual({ path: '/ui/api/delivery-expedite', body: { pr: 'https://github.com/octo/shed/pull/12', expedite: true } });
  });

  it('clears a delivery gate of a promotion set (part 5)', async () => {
    expect(forecastCall(['--set', '7', '--repo', 'octo/shed', '--clear', 'test_gate'])).toMatchObject({ role: 'operator' });
    expect(await forecastCall(['--set', '7', '--repo', 'octo/shed', '--clear', 'test_gate']).post!(async () => undefined))
      .toEqual({ path: '/ui/api/delivery-gate', body: { repo: 'octo/shed', set: 7, step: 'test_gate' } });
  });

  it('reads the delivery ledger and its accuracy, of all, a job or a repository (part 6)', () => {
    expect(forecastCall(['--ledger'])).toEqual({ role: 'viewer', path: '/api/delivery-ledger' });
    expect(forecastCall(['--ledger', '--job', 'j1'])).toEqual({ role: 'viewer', path: '/api/delivery-ledger?job=j1' });
    expect(forecastCall(['--ledger', '--repo', 'octo/shed'])).toEqual({ role: 'viewer', path: '/api/delivery-ledger?repo=octo%2Fshed' });
  });

  it('refuses none, two, an empty one, a stray word or another option, before any call', () => {
    for (const args of [[], ['--job', 'j1', '--issue', 'octo/shed#7'], ['--job', ''], ['j1'], ['--repo', 'octo/shed'], ['--set', '7'], ['--job', 'j1', '--repo', 'octo/shed'],
      ['--job', 'j1', '--expedite', 'yes'], ['--job', 'j1', '--expedite', ''], ['--set', '7', '--repo', 'octo/shed', '--expedite', 'on'],
      ['--job', 'j1', '--clear', 'test_gate'], ['--set', '7', '--repo', 'octo/shed', '--clear', ''], ['--set', 'x', '--repo', 'octo/shed', '--clear', 'test_gate'],
      ['--set', '7', '--repo', 'octo/shed', '--clear', 'test_gate', '--expedite', 'on'],
      ['--ledger', '--job', 'j1', '--repo', 'octo/shed'], ['--ledger', '--issue', 'octo/shed#7'], ['--ledger', '--set', '7', '--repo', 'octo/shed'], ['--ledger', '--job', '']]) {
      expect(() => forecastCall(args)).toThrow(/usage: hopper forecast/);
    }
  });
});
