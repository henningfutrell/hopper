// A template's blast radius (issue #584, design.md "A template's blast radius"), pure. A box's tools decide what it
// could do (`rate.ts`); its template decides what it may do. Rated from the template's operation profiles — the ones it
// declares and the ones access holds an approval for — and its credential scope, the vault secrets its boxes may ask
// for. A read profile is low; a write, sync, apply or observe profile, and a database read (issue #2231), is high, approved or not. A vault secret is a credential
// whose reach the hopper cannot see: it counts as an unconfirmed reach, by the rules. An egress host (issue #1875) is
// medium: a place off AWS and the minted clusters where a box can send what it reads.
import {
  DEFAULT_BLAST_RADIUS_SETTINGS, RADIUS_LEVELS, type OperationProfile, type RadiusLevel, type RadiusRules, type TemplateProfileRadius, type TemplateRadius,
} from '../domain/types.ts';
import { prodName, reachLevel } from './rate.ts';

/**
 * The operations a profile of needs its own explicit approval: the ones that change an asset, and observe (issue #2146),
 * whose port-forward reaches every port of a pod.
 */
const HIGH_OPERATIONS: readonly string[] = ['write', 'sync', 'apply', 'observe'];

/**
 * Whether a profile is high radius: write, sync, apply or observe, or a read of a database (issue #2231), which reads
 * rows of data a person may not want a job to see.
 */
export const highRadius = (p: OperationProfile): boolean => HIGH_OPERATIONS.includes(p.operation) || p.asset.kind === 'database';

const keyOf = (p: OperationProfile): string => `${p.operation}/${p.asset.kind}/${p.asset.name}`;
const profileText = (p: OperationProfile): string => `${p.operation} on ${p.asset.kind} ${p.asset.name}`;

/** The template's scope as the rating reads it: its vault secrets (name and scope line, never a value), its declared profiles and its egress hosts (issue #1875). */
export interface TemplateScope {
  secrets: { name: string; scope?: string }[];
  profiles: OperationProfile[];
  egress?: string[];
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
      reason: `${profileText(p.profile)}: ${p.level === 'high' ? `${p.profile.operation === 'observe' ? 'it port-forwards to the asset\'s pods' : 'it changes the asset'}; ${p.approved ? 'approved' : 'waits for an explicit approval'}` : 'read only'}`,
    })),
    ...scope.secrets.map((s) => {
      const prod = prodName([s.name, s.scope], rules);
      return {
        level: reachLevel({ kind: 'credential', target: s.name, access: 'unconfirmed', prod, evidence: '' }, rules),
        reason: `vault secret ${s.name}${s.scope ? ` (${s.scope})` : ''}${prod ? ', prod' : ''}: what it reaches is not discovered; counted as ${counted}`,
      };
    }),
    // Issue #1875: a host off AWS and the minted clusters, where a box can send what it reads.
    ...(scope.egress ?? []).map((h) => ({ level: 'medium' as const, reason: `egress host ${h}: its boxes may send what they read there` })),
  ];
  if (lines.length === 0) return { level: 'low', reasons: ['no operation profiles or vault secrets in scope'], profiles };
  const level = RADIUS_LEVELS[Math.max(...lines.map((l) => RADIUS_LEVELS.indexOf(l.level)))]!;
  return { level, reasons: lines.filter((l) => l.level === level).map((l) => l.reason), profiles };
}

const rank = (r: TemplateRadius): number => RADIUS_LEVELS.indexOf(r.level);

/**
 * A template's rating as Users & access → Access shows it: from its approvals and each vault template of its name (`scopes`);
 * the highest when users' templates share it, and the default rules when none does.
 */
export function templateRadius(template: string, approved: OperationProfile[], scopes: { name: string; scope: TemplateScope; rules: RadiusRules }[]): TemplateRadius {
  const mine = scopes.filter((s) => s.name === template);
  const rated = mine.length ? mine.map((s) => rateTemplate(s.scope, approved, s.rules)) : [rateTemplate({ secrets: [], profiles: [] }, approved, DEFAULT_BLAST_RADIUS_SETTINGS.rules)];
  return rated.reduce((a, b) => (rank(b) > rank(a) ? b : a));
}
