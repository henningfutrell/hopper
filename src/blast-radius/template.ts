// A template's blast radius (issue #584, design.md "A template's blast radius"), pure. A box's tools decide what it
// could do (`rate.ts`); its template decides what it may do. Rated from the template's operation profiles — the ones it
// declares and the ones access holds an approval for — and its credential scope, the vault secrets its boxes may ask
// for. A read profile is low; a write, sync or apply profile is high, approved or not. A vault secret is a credential
// whose reach the hopper cannot see: it counts as an unconfirmed reach, by the rules.
import {
  RADIUS_LEVELS, type OperationProfile, type RadiusLevel, type RadiusRules, type TemplateProfileRadius, type TemplateRadius,
} from '../domain/types.ts';
import { prodName, reachLevel } from './rate.ts';

/** The operations that change an asset: a profile of one needs its own explicit approval. */
const HIGH_OPERATIONS: readonly string[] = ['write', 'sync', 'apply'];

/** Whether a profile is high radius: write, sync or apply. */
export const highRadius = (p: OperationProfile): boolean => HIGH_OPERATIONS.includes(p.operation);

const keyOf = (p: OperationProfile): string => `${p.operation}/${p.asset.kind}/${p.asset.name}`;
const profileText = (p: OperationProfile): string => `${p.operation} on ${p.asset.kind} ${p.asset.name}`;

/** The template's scope as the rating reads it: its vault secrets (name and scope line, never a value) and its declared profiles. */
export interface TemplateScope {
  secrets: { name: string; scope?: string }[];
  profiles: OperationProfile[];
}

export function rateTemplate(scope: TemplateScope, approved: readonly OperationProfile[], rules: RadiusRules): TemplateRadius {
  const approvedKeys = new Set(approved.map(keyOf));
  const seen = new Set<string>();
  const profiles: TemplateProfileRadius[] = [];
  for (const p of [...scope.profiles, ...approved]) {
    if (seen.has(keyOf(p))) continue;
    seen.add(keyOf(p));
    profiles.push({ profile: p, level: highRadius(p) ? 'high' : 'low', approved: approvedKeys.has(keyOf(p)) });
  }
  const counted = rules.unconfirmed === 'write' ? 'write' : 'read';
  const lines: { level: RadiusLevel; reason: string }[] = [
    ...profiles.map((p) => ({
      level: p.level,
      reason: `${profileText(p.profile)}: ${p.level === 'high' ? `it changes the asset; ${p.approved ? 'approved' : 'waits for an explicit approval'}` : 'read only'}`,
    })),
    ...scope.secrets.map((s) => {
      const prod = prodName([s.name, s.scope], rules);
      return {
        level: reachLevel({ kind: 'credential', target: s.name, access: 'unconfirmed', prod, evidence: '' }, rules),
        reason: `vault secret ${s.name}${s.scope ? ` (${s.scope})` : ''}${prod ? ', prod' : ''}: what it reaches is not discovered; counted as ${counted}`,
      };
    }),
  ];
  if (lines.length === 0) return { level: 'low', reasons: ['no operation profiles or vault secrets in scope'], profiles };
  const level = RADIUS_LEVELS[Math.max(...lines.map((l) => RADIUS_LEVELS.indexOf(l.level)))]!;
  return { level, reasons: lines.filter((l) => l.level === level).map((l) => l.reason), profiles };
}
