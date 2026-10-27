// `hopper usage model-routing` and `hopper usage job-budget` (issue #2848, part 2): the call the operator CLI makes, before
// any daemon.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { usageCall } from '../../src/cli-operator-usage.ts';

const none = async () => undefined;

describe('hopper usage model-routing (issue #2848, part 2)', () => {
  it('reads model routing, and an admin turns it on or off', async () => {
    expect(usageCall(['model-routing'])).toEqual({ role: 'viewer', path: '/api/model-routing' });
    const on = usageCall(['model-routing', 'on']);
    expect(on).toMatchObject({ role: 'admin', path: '/ui/api/model-routing' });
    expect(await on.body!(none)).toEqual({ on: true });
    expect(await usageCall(['model-routing', 'off']).body!(none)).toEqual({ on: false });
  });

  it('saves the fields a JSON file names', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'model-routing-')), 'routing.json');
    writeFileSync(file, JSON.stringify({ cheap: { model: 'haiku', jobTokens: 0, jobCostUsd: 2 } }));
    const set = usageCall(['model-routing', 'set', '--file', file]);
    expect(set).toMatchObject({ role: 'admin', path: '/ui/api/model-routing' });
    expect(await set.body!(none)).toEqual({ cheap: { model: 'haiku', jobTokens: 0, jobCostUsd: 2 } });
    writeFileSync(file, '{ not json');
    await expect(usageCall(['model-routing', 'set', '--file', file]).body!(none)).rejects.toThrow(/not JSON/);
  });

  it('sets a job\'s own budget', async () => {
    const set = usageCall(['job-budget', 'j1', '--job-cost', '12.5']);
    expect(set).toMatchObject({ role: 'operator', path: '/ui/api/jobs/j1/budget' });
    expect(await set.body!(none)).toEqual({ jobCostUsd: 12.5 });
    expect(await usageCall(['job-budget', 'j1', '--job-tokens', '0', '--job-cost', '3']).body!(none)).toEqual({ jobTokens: 0, jobCostUsd: 3 });
  });

  it('refuses a bad call before any daemon', () => {
    expect(() => usageCall(['model-routing', 'set'])).toThrow(/usage: hopper usage model-routing/);
    expect(() => usageCall(['model-routing', 'maybe'])).toThrow(/usage: hopper usage model-routing/);
    expect(() => usageCall(['model-routing', 'on', '--file', 'x.json'])).toThrow(/usage: hopper usage model-routing/);
    expect(() => usageCall(['model-routing', '--job-tokens', '5'])).toThrow(/usage: hopper usage model-routing/);
    expect(() => usageCall(['job-budget', 'j1'])).toThrow(/usage: hopper usage model-routing/);
    expect(() => usageCall(['job-budget', '--job-cost', '3'])).toThrow(/usage: hopper usage model-routing/);
    expect(() => usageCall(['job-budget', 'j1', '--job-cost', 'lots'])).toThrow(/usage: hopper usage model-routing/);
  });
});
