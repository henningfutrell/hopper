import { describe, expect, it } from 'vitest';
import passThrough from '../../src/plugins/router/pass-through/index.ts';
import { fakeKit, fixedClock } from './support.ts';

const ctx = { clock: fixedClock, logger: { info() {}, warn() {} }, dataDir: '/x', scratchDir: '/x', instanceName: 'p', env: () => undefined, routerMode: () => 'shadow' as const };

describe('pass-through router', () => {
  it('is always available', async () => {
    expect(await passThrough.detect(fakeKit({ which: async () => undefined, exists: async () => false }), {})).toEqual({ status: 'available' });
  });

  it('advises proceed_full for every job', async () => {
    const r = await passThrough.create(ctx, {});
    expect(r.name).toBe('pass-through');
    for (const kind of ['account', 'chat', undefined]) {
      expect(await r.advise({ spec: { kind } } as never)).toEqual({
        action: 'proceed_full', reason: 'pass-through: every job proceeds', details: {}, source: 'pass-through', at: '2026-10-03T12:00:00.000Z',
      });
    }
  });
});
