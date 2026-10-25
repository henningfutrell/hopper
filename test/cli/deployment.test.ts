// `hopper deployment` (issue #2775 part 2): the call the operator CLI makes, before any daemon. `--job <id>` reads the job's
// kept delivery track (GET /api/delivery-tracks); with `--expect deploy|none` and an optional `--note` it flips the job's
// deployment expectation (POST /ui/api/delivery-tracks/deploy|no-deploy). `--list` reads the deployment records on their
// own (GET /api/deployments), filtered by `--repo`, `--target` and `--kind`.
import { describe, expect, it } from 'vitest';
import { deploymentCall } from '../../src/cli-operator-deployment.ts';

const post = async (args: string[]) => deploymentCall(args).post!(async () => undefined);

describe('hopper deployment (issue #2775)', () => {
  it('reads a job\'s kept delivery track', () => {
    expect(deploymentCall(['--job', 'j1'])).toEqual({ role: 'viewer', path: '/api/delivery-tracks?job=j1' });
  });

  it('flips a job\'s deployment expectation, with a note', async () => {
    expect(deploymentCall(['--job', 'j1', '--expect', 'none'])).toMatchObject({ role: 'operator', path: '/ui/api/delivery-tracks/no-deploy' });
    expect(await post(['--job', 'j1', '--expect', 'none', '--note', 'a docs change'])).toEqual({ path: '/ui/api/delivery-tracks/no-deploy', body: { job: 'j1', note: 'a docs change' } });
    expect(await post(['--job', 'j1', '--expect', 'deploy'])).toEqual({ path: '/ui/api/delivery-tracks/deploy', body: { job: 'j1' } });
  });

  it('holds a job\'s change, takes ownership of it, and releases it (part 8)', async () => {
    expect(deploymentCall(['--job', 'j1', '--hold'])).toMatchObject({ role: 'operator', path: '/ui/api/delivery-tracks/hold' });
    expect(await post(['--job', 'j1', '--hold'])).toEqual({ path: '/ui/api/delivery-tracks/hold', body: { job: 'j1' } });
    expect(await post(['--job', 'j1', '--hold', '--owner', 'person', '--reason', 'by hand'])).toEqual({ path: '/ui/api/delivery-tracks/hold', body: { job: 'j1', owner: 'person', reason: 'by hand' } });
    expect(await post(['--job', 'j1', '--release', '--reason', 'go on'])).toEqual({ path: '/ui/api/delivery-tracks/release', body: { job: 'j1', reason: 'go on' } });
  });

  it('lists the deployment records, filtered', () => {
    expect(deploymentCall(['--list'])).toEqual({ role: 'viewer', path: '/api/deployments' });
    expect(deploymentCall(['--list', '--repo', 'octo/shed', '--kind', 'none', '--target', 'production']))
      .toEqual({ role: 'viewer', path: '/api/deployments?repo=octo%2Fshed&kind=none&target=production' });
  });

  it('refuses what it cannot read', () => {
    for (const args of [[], ['--job', ''], ['--job', 'j1', '--expect', 'maybe'], ['--expect', 'none'], ['--note', 'x', '--job', 'j1'], ['--list', '--job', 'j1'], ['--list', '--expect', 'none'], ['--job', 'j1', '--repo', 'octo/shed'], ['--what'],
      ['--job', 'j1', '--hold', '--release'], ['--job', 'j1', '--hold', '--expect', 'none'], ['--job', 'j1', '--hold', '--owner', 'robot'], ['--job', 'j1', '--release', '--owner', 'person'],
      ['--job', 'j1', '--reason', 'x'], ['--job', 'j1', '--expect', 'none', '--reason', 'x'], ['--list', '--hold']]) {
      expect(() => deploymentCall(args), args.join(' ')).toThrow(/usage/);
    }
  });
});
