// Issue #897: Needs you, the one inbox of every decision that waits on a person. One row per kind, in a fixed order, each
// with its count and the page that is its one home; one total, and a high-priority mark (#535). Access requests counts
// what jobs on boxes wait on a person for: credential requests, vault grant asks, and templates that wait for approval.
import { describe, expect, it } from 'vitest';
import { NEEDS_YOU_KINDS, needsYouRows, needsYouTotal, type NeedsYouCounts } from '../../ui/src/model/needs-you.ts';
import { accessRequestsWaiting, templateWaits } from '../../ui/src/model/vault.ts';
import type { TemplateView, VaultView } from '../../ui/src/model/wire.ts';

const none = { n: 0, high: 0 };
const counts = (o: Partial<NeedsYouCounts> = {}): NeedsYouCounts => ({
  intake: 0, access: 0, sorting: 0,
  sections: { questions: none, proposals: none, research: none, logins: none, failures: none, parked: none },
  ...o,
});

describe('Needs you rows (issue #897)', () => {
  it('one row per kind, in order, each linked to its one home, with what it counts', () => {
    const rows = needsYouRows(counts());
    expect(rows.map((r) => r.kind)).toEqual(NEEDS_YOU_KINDS);
    expect(rows.map((r) => r.href)).toEqual(['#intake', '#access-requests', '#questions', '#proposals', '#research', '#logins', '#failures', '#queue']);
    expect(rows.every((r) => r.n === 0 && r.what.length > 0)).toBe(true);
  });

  it('counts each kind, and the total adds them with the high-priority ones', () => {
    const rows = needsYouRows(counts({ intake: 2, access: 1, sorting: 3, sections: { questions: { n: 1, high: 1 }, proposals: none, research: none, logins: none, failures: { n: 4, high: 2 }, parked: none } }));
    const n = Object.fromEntries(rows.map((r) => [r.kind, r.n]));
    expect(n).toEqual({ intake: 2, access: 1, questions: 1, proposals: 0, research: 0, logins: 0, failures: 4, sorting: 3 });
    expect(needsYouTotal(rows)).toEqual({ n: 11, high: 3 });
  });

  it('a parked job waits to be picked up, not on a decision: it has no row', () => {
    const rows = needsYouRows(counts({ sections: { questions: none, proposals: none, research: none, logins: none, failures: none, parked: { n: 2, high: 1 } } }));
    expect(rows.some((r) => (r.kind as string) === 'parked')).toBe(false);
    expect(needsYouTotal(rows)).toEqual({ n: 0, high: 0 });
  });
});

const template = (o: Partial<TemplateView> = {}): TemplateView => ({
  name: 't', image: 'img', secrets: [], profiles: [], gives: [], pending: { image: false, secrets: [], profiles: [] },
  approval: { by: 'admin', at: '2026-10-01T00:00:00.000Z', image: 'img', secrets: [] },
  ...o,
} as unknown as TemplateView);

describe('Access requests: what waits on a person (issue #897)', () => {
  it('a template waits when it was never approved, or a new image, secret or profile waits', () => {
    expect(templateWaits(template())).toBe(false);
    expect(templateWaits(template({ approval: undefined }))).toBe(true);
    expect(templateWaits(template({ pending: { image: true, secrets: [], profiles: [] } }))).toBe(true);
    expect(templateWaits(template({ pending: { image: false, secrets: ['K'], profiles: [] } }))).toBe(true);
    expect(templateWaits(template({ pending: { image: false, secrets: [], profiles: [{ operation: 'apply', asset: { kind: 'cluster', name: 'lab' } }] } }))).toBe(true);
  });

  it('counts credential requests, vault grant asks and templates that wait; none for no view', () => {
    const view = {
      secrets: [], backends: [], templates: [template(), template({ name: 'u', approval: undefined })],
      requests: [{ id: 'r1' }], grantAsks: [{ job: 'j1' }, { job: 'j2' }], grants: [{ key: 'k' }],
    } as unknown as VaultView;
    expect(accessRequestsWaiting(view)).toBe(4);
    expect(accessRequestsWaiting(null)).toBe(0);
  });
});
