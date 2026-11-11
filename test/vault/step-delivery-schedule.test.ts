// A step schedule's run asks the vault for its template's secrets (issue #2716, src/vault/step-delivery.ts): it names its
// schedule in place of a job, so no job must be at work, and the grant around it (grants.ts) is the hopper's own check of
// the schedule's grant, not a job's. The other checks stand: the user's own secret only, never a minting credential.
import { describe, expect, it } from 'vitest';
import type { NewEvent } from '../../src/domain/types.ts';
import type { VaultSecret } from '../../src/domain/vault.ts';
import { withVaultGrants } from '../../src/vault/grants.ts';
import { stepDelivery } from '../../src/vault/step-delivery.ts';
import type { Vault } from '../../src/vault/vault.ts';

const clock = { now: () => new Date('2026-10-25T02:00:00Z') };

function world(secrets: VaultSecret[]) {
  const events: NewEvent[] = [];
  const kept = new Map(secrets.map((s) => [s.name, s]));
  const store = {
    vault: { get: (name: string) => kept.get(name), replace: (s: VaultSecret) => { kept.set(s.name, s); }, sealed: () => undefined },
    events: { append: (e: NewEvent) => { events.push(e); } },
    tx: <T>(fn: () => T): T => fn(),
    jobs: { get: () => undefined },
  };
  const d = stepDelivery(store as never, clock, async () => ({ value: 'the-value' }));
  return { d, events, kept };
}

const secret = (name: string, more: Partial<VaultSecret> = {}) => ({ id: `id-${name}`, name, ...more }) as VaultSecret;

describe('a step schedule\'s secret (issue #2716)', () => {
  it('is given with no job, recorded with the schedule and the need box, never the value', async () => {
    const { d, events, kept } = world([secret('BUCKET_KEY')]);
    expect(await d.forStep({ name: 'BUCKET_KEY', schedule: 'nightly-backup', host: 'hopper-need-backup-1', template: 'backup' })).toEqual({ value: 'the-value' });
    expect(events).toEqual([{ type: 'vault.step_delivered', data: { name: 'BUCKET_KEY', host: 'hopper-need-backup-1', schedule: 'nightly-backup' } }]);
    expect(kept.get('BUCKET_KEY')!.lastUsed).toEqual({ at: '2026-10-25T02:00:00.000Z', machine: 'hopper-need-backup-1', schedule: 'nightly-backup' });
  });

  it('a minting credential or a system secret is refused, as for a job\'s step', async () => {
    const { d, events } = world([secret('KUBE', { mints: { kind: 'cluster', name: 'lab' } } as Partial<VaultSecret>)]);
    expect(await d.forStep({ name: 'KUBE', schedule: 'nightly-backup', host: 'b' })).toEqual({ refused: expect.stringContaining('minting credential') });
    expect(await d.forStep({ name: 'system/x', schedule: 'nightly-backup', host: 'b' })).toEqual({ refused: expect.stringContaining('not one of the user\'s own') });
    expect(events.every((e) => e.type === 'vault.step_refused' && e.jobId === undefined && (e.data as { schedule?: string }).schedule === 'nightly-backup')).toBe(true);
  });

  it('a job\'s step still needs its job at work', async () => {
    const { d } = world([secret('BUCKET_KEY')]);
    expect(await d.forStep({ name: 'BUCKET_KEY', job: 'job-1', host: 'b' })).toEqual({ refused: expect.stringContaining('the job is not at work') });
  });

  it('the vault grants pass a schedule\'s ask to the vault and open no grant ask', async () => {
    const asked: unknown[] = [];
    const v = withVaultGrants({ view: () => ({ templates: [] }), forStep: async (a: unknown) => { asked.push(a); return { value: 'v' }; } } as unknown as Vault, {
      store: { events: { append: () => {} }, jobs: { get: () => undefined }, vaultGrants: { get: () => undefined, list: () => [] } } as never, clock, targets: () => [], holds: () => true,
    });
    expect(await v.forStep({ name: 'BUCKET_KEY', schedule: 'nightly-backup', host: 'b' })).toEqual({ value: 'v' });
    expect(asked).toHaveLength(1);
    expect(v.view().grantAsks).toEqual([]);
  });
});
