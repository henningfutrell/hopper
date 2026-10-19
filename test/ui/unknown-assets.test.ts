// Issue #2067: a template whose need names a cluster the vault cannot find is shown as an unknown asset, not as approved
// or as a pending approval: its card says so with the known clusters, and Needs you counts it under Access requests, one
// line each.
import { describe, expect, it } from 'vitest';
import { needsYouRows, type NeedsYouCounts } from '../../ui/src/model/needs-you.ts';
import { approvalText, unknownAssetLines } from '../../ui/src/model/vault.ts';
import type { TemplateView, VaultView } from '../../ui/src/model/wire.ts';

const unknown = { asset: { kind: 'cluster' as const, name: 'staging' }, cluster: 'staging', known: ['staging-eks', 'control-plane-eks'] };
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
    expect(approvalText(template)).toBe('unknown asset: no cluster staging; known: staging-eks, control-plane-eks');
  });

  it('Needs you counts it under Access requests, one line each', () => {
    const lines = unknownAssetLines({ templates: [template, { ...template, name: 'kube', unknownAssets: undefined }] } as unknown as VaultView);
    expect(lines).toEqual(['template asked-e7c588b627d7: unknown asset: no cluster staging; known: staging-eks, control-plane-eks']);
    const access = needsYouRows(counts({ access: 1, unknownAssets: lines })).find((r) => r.kind === 'access')!;
    expect(access.n).toBe(2);
    expect(access.details).toEqual(lines);
    expect(unknownAssetLines(null)).toEqual([]);
  });
});
