// `hopper plan list|show|export|import` (issue #2861): the calls the operator CLI makes, before any daemon. They read the
// routes the Planned work tab reads, so the CLI answers what the UI and the API do; a CSV export prints as it is.
import { describe, expect, it } from 'vitest';
import { planCall } from '../../src/cli-operator-plan.ts';

describe('hopper plan (issue #2861)', () => {
  it('lists, shows and exports a work plan through the routes the tab reads', () => {
    expect(planCall(['list'])).toEqual({ role: 'viewer', path: '/api/planned-work/plans' });
    expect(planCall(['show', 'acme/app#1'])).toEqual({ role: 'viewer', path: '/api/planned-work?plan=acme%2Fapp%231' });
    expect(planCall(['export', 'acme/app#1', '--format', 'csv'])).toEqual({ role: 'viewer', path: '/api/planned-work/export?plan=acme%2Fapp%231&format=csv', raw: true });
    expect(planCall(['export', 'acme/app#1', '--format', 'json'])).toEqual({ role: 'viewer', path: '/api/planned-work/export?plan=acme%2Fapp%231&format=json', raw: false });
  });

  it('imports a plan from an issue, with its sync', async () => {
    const call = planCall(['import', 'acme/app#1', '--sync', 'off']);
    expect(call).toMatchObject({ role: 'operator', path: '/ui/api/planned-work/import' });
    expect(await call.body!(async () => undefined)).toEqual({ issue: 'acme/app#1', sync: 'off' });
  });

  it('refuses a missing plan, a bad format, a stray word or flag, before any call', () => {
    for (const args of [[], ['show'], ['export', 'acme/app#1'], ['export', 'acme/app#1', '--format', 'xml'], ['list', 'x'], ['show', 'a#1', 'b'], ['show', 'a#1', '--format', 'csv'], ['import', 'a#1', '--sync', 'on'], ['nope', 'a#1']]) {
      expect(() => planCall(args)).toThrow(/usage: hopper plan/);
    }
  });
});
