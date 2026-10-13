// GitHub's device flow (issue #214) polls for the grant at the interval GitHub gives, never faster; with none, every
// second. The fake GitHub gives a short one (issue #949: a test sign-in does not wait a second per poll).
import { afterEach, describe, expect, it } from 'vitest';
import { deviceFlow } from '../../src/connected-accounts/device-flow.ts';
import { hopperApps } from '../../src/connected-accounts/hopper-app.ts';
import { createFakeGitHub, type FakeForge } from '../support/fake-forges.ts';

const forges: FakeForge[] = [];
afterEach(async () => { for (const f of forges.splice(0)) await f.close(); });

/** How long the grant took once approved at once, with GitHub giving `interval` seconds. */
async function grantTakes(interval: number): Promise<number> {
  const github = await createFakeGitHub({ clientId: 'gh-client-id', deviceInterval: interval });
  forges.push(github);
  const pending = await deviceFlow(hopperApps({ github: { url: github.url, clientId: 'gh-client-id' } }).github).start();
  github.approve('octo');
  const at = Date.now();
  await pending.grant(new AbortController().signal);
  return Date.now() - at;
}

describe('GitHub device flow: the poll interval', () => {
  it('polls at the interval GitHub gives, a fraction of a second too', async () => {
    expect(await grantTakes(0.05)).toBeLessThan(500);
  });

  it('polls every second when GitHub gives no interval', async () => {
    expect(await grantTakes(0)).toBeGreaterThanOrEqual(1000);
  });
});
