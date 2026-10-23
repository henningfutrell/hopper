// Issue #2067: a template whose need names a cluster the vault cannot find is shown as an unknown asset, not as approved
// or as a pending approval: its card says so with the known clusters. Issue #2168: Needs you counts it in a row of its
// own, one line each, never under Access requests: that row and the Access requests badge count only what waits for a
// person's approval.
import { describe, expect, it } from 'vitest';
import { needsYouRows, type NeedsYouCounts } from '../../ui/src/model/needs-you.ts';
import { approvalText, unknownAssetLines } from '../../ui/src/model/vault.ts';
import type { TemplateView, VaultView } from '../../ui/src/model/wire.ts';

const unknown = { asset: { kind: 'cluster' as const, name: 'staging' }, cluster: 'staging', known: ['staging-eks', 'central-eks'] };
const template = {
  name: 'asked-e7c588b627d7', image: 'img', secrets: [], profiles: [{ operation: 'read', asset: unknown.asset }], savedBy: 'job j0', savedAt: '',
  approval: { image: 'img', secrets: [], by: 'the read policy', at: '' }, pending: { secrets: [], image: false, egress: [], profiles: [] }, gives: [],
  radius: { level: 'low', reasons: [] }, unknownAssets: [unknown],
} as unknown as TemplateView;
const none = { n: 0, high: 0 };
const counts = (o: Partial<NeedsYouCounts> = {}): NeedsYouCounts => ({
  intake: 0, access: 0, plans: 0, signedOut: [], notReady: [], gaveUp: [], checksUnread: [], stuckLanding: [], tagged: 0, sorting: 0, unknownAssets: [],
  sections: { questions: none, proposals: none, research: none, logins: none, failures: none, parked: none },
  ...o,
});

describe('an unknown asset (issue #2067)', () => {
  it('the template card says unknown asset, with the known clusters', () => {
    expect(approvalText(template)).toBe('unknown asset: no cluster staging; known: staging-eks, central-eks');
  });

  it('Needs you counts it in a row of its own, one line each, and Access requests counts only approvals', () => {
    const lines = unknownAssetLines({ templates: [template, { ...template, name: 'kube', unknownAssets: undefined }] } as unknown as VaultView);
    expect(lines).toEqual(['template asked-e7c588b627d7: unknown asset: no cluster staging; known: staging-eks, central-eks']);
    const rows = needsYouRows(counts({ access: 1, unknownAssets: lines }));
    const access = rows.find((r) => r.kind === 'access')!;
    expect(access.n).toBe(1);
    expect(access.details).toBeUndefined();
    const unknown = rows.find((r) => r.kind === 'unknown-assets')!;
    expect(unknown).toMatchObject({ n: 1, details: lines, href: '#approvals/access-requests' });
    expect(unknownAssetLines(null)).toEqual([]);
  });

  it('with no approval open, Access requests counts zero, however many templates do not resolve', () => {
    const many = Array.from({ length: 29 }, (_, i) => `template t${i}: unknown asset: no cluster x`);
    expect(needsYouRows(counts({ access: 0, unknownAssets: many })).find((r) => r.kind === 'access')!.n).toBe(0);
  });

  it('an ambiguous cluster says so, with its candidates', () => {
    const ambiguous = { ...template, unknownAssets: [{ asset: { kind: 'cluster', name: 'utility' }, cluster: 'utility', known: ['utility-eks', 'utility-gke'], candidates: ['utility-eks', 'utility-gke'] }] } as unknown as TemplateView;
    expect(approvalText(ambiguous)).toBe('unknown asset: cluster utility is ambiguous: utility-eks, utility-gke');
  });
});
