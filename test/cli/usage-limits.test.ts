// `hopper usage limits` and `hopper usage no-limits` (issue #2932): the call the operator CLI makes, before any daemon, and
// the edit it posts from what the daemon answers.
import { describe, expect, it } from 'vitest';
import type { Getter } from '../../src/cli-operator-call.ts';
import { usageCall } from '../../src/cli-operator-usage.ts';

const LIMITS = { soft: 0.7, hard: 0.95, softLanes: 1, defaults: { soft: 0.7, hard: 0.95, softLanes: 1 }, set: false };
const PLUGINS = {
  config: { version: 'v1' },
  instances: [
    { role: 'machine-source', instance: { name: 'l4', plugin: 'ssh', options: { ssh: 'l4.example', lanes: 9 } } },
    { role: 'machine-source', instance: { name: 'l2', plugin: 'ssh', options: { ssh: 'l2.example', lanes: 4, usageLimits: { soft: 0.5, hard: 0.7, softLanes: 2 } } } },
    { role: 'usage-source', instance: { name: 'claude-l4', plugin: 'claude-plan', options: { machine: 'l4' } } },
  ],
};
/** The daemon's answers to the CLI's reads: the usage report and the plugins report. */
const daemon: Getter = async (path) => {
  if (path === '/api/usage') return { limits: LIMITS, machines: [{ machineId: 'l4', label: 'l4', online: true, maxLanes: 9, cap: 1, band: 'unknown', unknown: ['claude-l4'] }] };
  if (path === '/api/plugins') return PLUGINS;
  throw new Error(`unexpected read ${path}`);
};

describe('hopper usage limits (issue #2932)', () => {
  it('reads the usage limits and each machine\'s lane cap', () => {
    const read = usageCall(['limits']);
    expect(read).toMatchObject({ role: 'viewer', path: '/api/usage' });
    expect(read.pick!({ limits: LIMITS, machines: [{ machineId: 'l4', label: 'l4', online: true, maxLanes: 9, cap: 1, band: 'unknown', unknown: ['claude-l4'], usedFrac: 0, executors: [] }] }))
      .toEqual({ limits: LIMITS, machines: [{ machineId: 'l4', maxLanes: 9, cap: 1, band: 'unknown', unknown: ['claude-l4'] }] });
  });

  it('sets the user\'s soft lanes and keeps the limits it does not name', async () => {
    const set = usageCall(['limits', 'set', '--soft-lanes', '9']);
    expect(set).toMatchObject({ role: 'admin', path: '/ui/api/usage/limits' });
    expect(await set.body!(daemon)).toEqual({ soft: 0.7, hard: 0.95, softLanes: 9 });
    expect(await usageCall(['limits', 'set', '--soft', '0.5', '--hard', '0.8']).body!(daemon)).toEqual({ soft: 0.5, hard: 0.8, softLanes: 1 });
  });

  it('sets one machine\'s own usage limits as a plugins edit; the machine\'s other options stay', async () => {
    const set = usageCall(['limits', 'set', '--machine', 'l4', '--soft-lanes', '9']);
    expect(set).toMatchObject({ role: 'admin' });
    expect(await set.post!(daemon)).toEqual({
      path: '/ui/api/plugins',
      body: { action: 'options', role: 'machine-source', name: 'l4', version: 'v1', options: { ssh: 'l4.example', lanes: 9, usageLimits: { soft: 0.7, hard: 0.95, softLanes: 9 } } },
    });
    // A machine with its own limits keeps those it does not name.
    expect(((await usageCall(['limits', 'set', '--machine', 'l2', '--hard', '0.9']).post!(daemon)).body as { options: unknown }).options)
      .toEqual({ ssh: 'l2.example', lanes: 4, usageLimits: { soft: 0.5, hard: 0.9, softLanes: 2 } });
    // Cleared: the machine goes by the user's limits again.
    expect(((await usageCall(['limits', 'clear', '--machine', 'l2']).post!(daemon)).body as { options: unknown }).options).toEqual({ ssh: 'l2.example', lanes: 4 });
    await expect(usageCall(['limits', 'set', '--machine', 'nope', '--soft-lanes', '2']).post!(daemon)).rejects.toThrow(/no machine named nope/);
  });

  it('marks a usage source as one whose account has no usage limits, or not', async () => {
    const on = usageCall(['no-limits', 'claude-l4', 'on']);
    expect(on).toMatchObject({ role: 'admin' });
    expect(await on.post!(daemon)).toEqual({
      path: '/ui/api/plugins',
      body: { action: 'options', role: 'usage-source', name: 'claude-l4', version: 'v1', options: { machine: 'l4', noLimits: true } },
    });
    expect(((await usageCall(['no-limits', 'claude-l4', 'off']).post!(daemon)).body as { options: unknown }).options).toEqual({ machine: 'l4' });
    await expect(usageCall(['no-limits', 'nope', 'on']).post!(daemon)).rejects.toThrow(/no usage source named nope/);
  });

  it('refuses a bad call before any daemon', () => {
    expect(() => usageCall(['limits', 'set'])).toThrow(/usage: hopper usage limits/);
    expect(() => usageCall(['limits', 'set', '--soft-lanes', 'many'])).toThrow(/usage: hopper usage limits/);
    expect(() => usageCall(['limits', 'set', '--soft', '70%'])).toThrow(/usage: hopper usage limits/);
    expect(() => usageCall(['limits', 'clear'])).toThrow(/usage: hopper usage limits/);
    expect(() => usageCall(['limits', 'clear', '--machine', 'l2', '--soft', '0.5'])).toThrow(/usage: hopper usage limits/);
    expect(() => usageCall(['no-limits', 'claude-l4'])).toThrow(/usage: hopper usage no-limits/);
    expect(() => usageCall(['no-limits', 'claude-l4', 'maybe'])).toThrow(/usage: hopper usage no-limits/);
  });
});
