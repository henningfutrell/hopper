// `hopper sandbox runs | approve-run <job> <template> | decline-run <job> <template> --reason <text>` (issue #2197): the
// calls the operator CLI makes, before any daemon. A run card is decided once on `POST /ui/api/sandbox-requests`, as on
// Access requests; the list is the vault's view's `runs`.
import { describe, expect, it } from 'vitest';
import { sandboxCall } from '../../src/cli-operator-vault.ts';

describe('hopper sandbox runs (issue #2197)', () => {
  it('lists the run cards; approve-run and decline-run send one decision of the card', async () => {
    const list = sandboxCall(['runs']);
    expect(list).toMatchObject({ role: 'viewer', path: '/api/vault' });
    expect(list.pick!({ runs: [{ jobId: 'j1' }] })).toEqual([{ jobId: 'j1' }]);
    const approve = sandboxCall(['approve-run', 'j1', 'asked-1']);
    expect(approve).toMatchObject({ role: 'admin', path: '/ui/api/sandbox-requests' });
    expect(await approve.body!(undefined as never)).toEqual({ action: 'approve-run', job: 'j1', template: 'asked-1' });
    expect(await sandboxCall(['decline-run', 'j1', 'asked-1', '--reason', 'not now']).body!(undefined as never)).toEqual({ action: 'decline-run', job: 'j1', template: 'asked-1', reason: 'not now' });
  });

  it('refuses a card with no template, a decline with no reason and an approve with one, before any call', () => {
    expect(() => sandboxCall(['approve-run', 'j1'])).toThrow(/usage: hopper sandbox list/);
    expect(() => sandboxCall(['decline-run', 'j1', 'asked-1'])).toThrow(/usage: hopper sandbox list/);
    expect(() => sandboxCall(['approve-run', 'j1', 'asked-1', '--reason', 'x'])).toThrow(/usage: hopper sandbox list/);
  });
});
