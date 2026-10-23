// Issue #2639 part 3: one card per job per template. A run card whose template gives the vault — a vault secret or a
// minted credential — also carries the job's vault grant when its item has none, so one approval approves the
// template, the run and the grant together. A grant ask a card holds is no ask of its own.
import { describe, expect, it } from 'vitest';
import { looseGrantAsks, runCards } from '../../src/domain/run-cards.ts';
import type { TemplateView } from '../../src/domain/vault.ts';
import type { VaultGrantAsk } from '../../src/domain/vault-grants.ts';

const read = { operation: 'read' as const, asset: { kind: 'cluster' as const, name: 'lab' } };

const waiting = (name: string, o: Partial<TemplateView> = {}): TemplateView => ({
  name, image: 'img', secrets: [], profiles: [], savedBy: 'job j1', savedAt: '2026-10-23T01:00:00.000Z',
  pending: { secrets: [], image: true, egress: [], profiles: [] }, gives: [], radius: { level: 'low', reasons: [] }, ...o,
} as TemplateView);

const live = (id: string) => ({ title: `job ${id}` });
const wait = (jobId: string, template: string) => ({ jobId, template, askedAt: '2026-10-23T02:00:00.000Z' });

describe('a run card carries the vault grant (issue #2639 part 3)', () => {
  it('a template with a vault secret or a profile, for a job with no grant: the card grants the vault', () => {
    const cards = runCards({
      templates: [waiting('s', { secrets: ['grafana-token'] }), waiting('p', { profiles: [read] }), waiting('none')],
      requests: [], job: live, granted: () => false,
      waits: [wait('j1', 's'), wait('j1', 'p'), wait('j1', 'none')],
    });
    expect(cards.map((c) => [c.template, c.vaultGrant ?? false])).toEqual([['s', true], ['p', true], ['none', false]]);
  });

  it('a job whose item has a grant: the card grants nothing more', () => {
    const cards = runCards({ templates: [waiting('s', { secrets: ['k'] })], requests: [], job: live, granted: (id) => id === 'j1', waits: [wait('j1', 's'), wait('j2', 's')] });
    expect(cards.map((c) => [c.jobId, c.vaultGrant ?? false])).toEqual([['j1', false], ['j2', true]]);
    expect(cards[0]).not.toHaveProperty('vaultGrant');
  });

  it('a grant ask a card holds is not shown apart; others are', () => {
    const cards = runCards({ templates: [waiting('s', { secrets: ['k'] })], requests: [], job: live, granted: () => false, waits: [wait('j1', 's')] });
    const ask = (job: string, template: string): VaultGrantAsk => ({ job, key: job, template, names: ['k'], askedAt: '2026-10-23T03:00:00.000Z' });
    const held = ask('j1', 's'), otherTemplate = ask('j1', 'x'), otherJob = ask('j2', 's');
    expect(looseGrantAsks([held, otherTemplate, otherJob], cards)).toEqual([otherTemplate, otherJob]);
  });
});
