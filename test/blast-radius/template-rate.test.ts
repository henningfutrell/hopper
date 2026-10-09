// Issue #584: a template's blast radius. A box's tools decide what it could do (a machine's rating, issue #542); its
// template decides what it may do. The template's operation profiles and its credential scope (the vault secrets its
// boxes may ask for) are rated: a read profile is low; a write, sync or apply profile is high; a vault secret, whose
// reach the hopper cannot see, counts as the rules count an unconfirmed reach. A profile that waits for approval is
// rated too, and says so.
import { describe, expect, it } from 'vitest';
import { highRadius, rateTemplate } from '../../src/blast-radius/template.ts';
import { DEFAULT_BLAST_RADIUS_SETTINGS, type OperationProfile } from '../../src/domain/types.ts';

const rules = DEFAULT_BLAST_RADIUS_SETTINGS.rules;
const profile = (operation: OperationProfile['operation'], name = 'x'): OperationProfile => ({ operation, asset: { kind: 'cluster', name } });
const READ = profile('read');
const WRITE = profile('write');

describe('rating a template', () => {
  it('nothing in scope: low', () => {
    expect(rateTemplate({ secrets: [], profiles: [] }, [], rules)).toEqual({ level: 'low', reasons: ['no operation profiles or vault secrets in scope'], profiles: [] });
  });

  it('a read profile only: low, with the profile as the reason', () => {
    const r = rateTemplate({ secrets: [], profiles: [READ] }, [READ], rules);
    expect(r.level).toBe('low');
    expect(r.profiles).toEqual([{ profile: READ, level: 'low', approved: true }]);
    expect(r.reasons).toEqual(['read on cluster x: read only']);
  });

  it.each(['write', 'sync', 'apply'] as const)('a %s profile is high, whether approved or not', (operation) => {
    const p = profile(operation);
    expect(rateTemplate({ secrets: [], profiles: [READ, p] }, [READ], rules)).toEqual({
      level: 'high',
      reasons: [`${operation} on cluster x: it changes the asset; waits for an explicit approval`],
      profiles: [{ profile: READ, level: 'low', approved: true }, { profile: p, level: 'high', approved: false }],
    });
    expect(rateTemplate({ secrets: [], profiles: [p] }, [p], rules).reasons).toEqual([`${operation} on cluster x: it changes the asset; approved`]);
  });

  it('a profile approved in Access but not declared on the template is rated too', () => {
    expect(rateTemplate({ secrets: [], profiles: [] }, [WRITE], rules)).toMatchObject({ level: 'high', profiles: [{ profile: WRITE, approved: true }] });
  });

  it('a vault secret in scope counts as an unconfirmed reach: medium by default, high when its name or scope says prod, low when the rules count it as read', () => {
    const plain = rateTemplate({ secrets: [{ name: 'KUBE_TOKEN', scope: 'lab cluster' }], profiles: [READ] }, [READ], rules);
    expect(plain.level).toBe('medium');
    expect(plain.reasons).toEqual(['vault secret KUBE_TOKEN (lab cluster): what it reaches is not discovered; counted as write']);
    expect(rateTemplate({ secrets: [{ name: 'KUBE_TOKEN', scope: 'prod cluster' }], profiles: [] }, [], rules).level).toBe('high');
    expect(rateTemplate({ secrets: [{ name: 'PRD_KEY' }], profiles: [] }, [], rules).level).toBe('high');
    expect(rateTemplate({ secrets: [{ name: 'KUBE_TOKEN' }], profiles: [] }, [], { ...rules, unconfirmed: 'read' }).level).toBe('low');
  });

  it('the high-radius operations are write, sync and apply', () => {
    expect(['read', 'write', 'sync', 'apply'].filter((o) => highRadius(profile(o as OperationProfile['operation'])))).toEqual(['write', 'sync', 'apply']);
  });
});
