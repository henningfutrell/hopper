// A machine's blast radius (issue #542, design.md "Blast radius and actor machines"), rated from what its discovery
// found and the admin's rules. Pure. Each reach — an AWS identity, a kubectl context, a credential source no identity
// accounts for — is read, write, admin (it can grant itself more) or unconfirmed (discovery could not tell; a write
// unless the rules say otherwise), and prod or not. The level: high for admin reach or write reach to prod, medium for
// any other write reach, low otherwise.
import { AWS_ADMIN_ACTIONS } from '../client/discover.ts';
import {
  RADIUS_LEVELS, type AwsIdentity, type BlastRadiusSettings, type DiscoveryChanges, type DiscoveryFacts, type KubeContext,
  type RadiusLevel, type RadiusRules, type Rating, type Reach,
} from '../domain/types.ts';

const rankOf = (level: RadiusLevel): number => RADIUS_LEVELS.indexOf(level);

/** Whether a name is prod by the rules: one of the patterns in it, case ignored. */
function prodName(names: (string | undefined)[], rules: RadiusRules): boolean {
  const patterns = rules.prodPatterns.map((p) => p.toLowerCase()).filter((p) => p.length > 0);
  return names.some((n) => n !== undefined && patterns.some((p) => n.toLowerCase().includes(p)));
}

function awsReach(a: AwsIdentity, rules: RadiusRules): Reach | undefined {
  if (!a.arn) return undefined;
  const target = `${a.profile}: account ${a.account ?? 'unknown'}, ${a.arn}${a.region ? `, ${a.region}` : ''}`;
  const prod = prodName([a.profile, a.account, a.arn], rules) || (a.account !== undefined && rules.prodAccounts.includes(a.account));
  if (a.arn.endsWith(':root')) return { kind: 'aws', target, access: 'admin', prod, evidence: 'the account\'s root user' };
  if (!a.simulated) return { kind: 'aws', target, access: 'unconfirmed', prod, evidence: `policy simulation gave no answer: ${a.simulationError ?? 'not run'}` };
  const allowed = a.simulated.filter((s) => s.decision === 'allowed').map((s) => s.action);
  const admin = allowed.filter((x) => (AWS_ADMIN_ACTIONS as readonly string[]).includes(x));
  if (admin.length > 0) return { kind: 'aws', target, access: 'admin', prod, evidence: `policy simulation allows ${allowed.join(', ')}` };
  if (allowed.length > 0) return { kind: 'aws', target, access: 'write', prod, evidence: `policy simulation allows ${allowed.join(', ')}` };
  return { kind: 'aws', target, access: 'read', prod, evidence: `policy simulation allows none of the ${a.simulated.length} write actions` };
}

function kubeReach(k: KubeContext, rules: RadiusRules): Reach {
  const target = `${k.name}${k.cluster ? `: cluster ${k.cluster}` : ''}${k.namespace ? `, namespace ${k.namespace}` : ''}`;
  const prod = prodName([k.name, k.cluster, k.namespace], rules);
  const yes = k.can.filter((c) => c.answer === 'yes').map((c) => c.check);
  const unanswered = k.can.filter((c) => c.answer !== 'yes' && c.answer !== 'no');
  if (yes.includes('* *')) return { kind: 'kubernetes', target, access: 'admin', prod, evidence: 'can-i: every verb on every resource, all namespaces' };
  const writes = yes.filter((c) => !c.startsWith('get '));
  if (writes.length > 0) return { kind: 'kubernetes', target, access: 'write', prod, evidence: `can-i, all namespaces: ${writes.join(', ')}` };
  if (unanswered.length > 0 || k.can.length === 0) {
    return { kind: 'kubernetes', target, access: 'unconfirmed', prod, evidence: `can-i gave no answer: ${unanswered[0]?.answer ?? 'not asked'}` };
  }
  return { kind: 'kubernetes', target, access: 'read', prod, evidence: `can-i, all namespaces: ${yes.length ? `only ${yes.join(', ')}` : 'none of the checks'}` };
}

/** Variables that name where credentials are, not credentials: not a reach of their own. */
const POINTERS = new Set(['TF_WORKSPACE', 'VAULT_ADDR']);
const isAwsSource = (n: string): boolean => n.startsWith('AWS_') || n.startsWith('aws-');
const isKubeSource = (n: string): boolean => n === 'KUBECONFIG' || n === 'kubeconfig' || n === 'kubernetes-service-account';
const isTerraformSource = (n: string): boolean => n.startsWith('TF_TOKEN_') || n.startsWith('TF_CLOUD_') || n === 'terraform-credentials';

/** Credential sources no discovered identity accounts for: what they reach is unconfirmed. */
function sourceReach(f: DiscoveryFacts, rules: RadiusRules): Reach[] {
  const awsKnown = f.aws.some((a) => a.arn !== undefined);
  const kubeKnown = f.kube.length > 0;
  const sources = [...f.credentials.env.map((n) => ({ n, what: 'variable' })), ...f.credentials.files.map((n) => ({ n, what: 'file' }))];
  return sources
    .filter(({ n }) => !POINTERS.has(n) && !(awsKnown && isAwsSource(n)) && !(kubeKnown && isKubeSource(n)))
    .map(({ n, what }) => ({
      kind: isTerraformSource(n) ? 'terraform' as const : 'credential' as const,
      target: n, access: 'unconfirmed' as const, prod: prodName([n], rules),
      evidence: `credential ${what} ${n} present; what it reaches is not discovered`,
    }));
}

/** The level one reach gives. */
export function reachLevel(r: Reach, rules: RadiusRules): RadiusLevel {
  const access = r.access === 'unconfirmed' ? (rules.unconfirmed === 'write' ? 'write' : 'read') : r.access;
  if (access === 'admin' || (access === 'write' && r.prod)) return 'high';
  return access === 'write' ? 'medium' : 'low';
}

const describe = (r: Reach): string => `${r.kind} ${r.target}${r.prod ? ' (prod)' : ''}: ${r.access}, ${r.evidence}`;

export function rate(f: DiscoveryFacts, rules: RadiusRules): Rating {
  const reach = [
    ...f.aws.map((a) => awsReach(a, rules)).filter((r): r is Reach => r !== undefined),
    ...f.kube.map((k) => kubeReach(k, rules)),
    ...sourceReach(f, rules),
  ];
  if (reach.length === 0) return { level: 'low', reach, reasons: ['no credentials or access found'] };
  const levels = reach.map((r) => reachLevel(r, rules));
  const level = RADIUS_LEVELS[Math.max(...levels.map(rankOf))]!;
  return { level, reach, reasons: reach.filter((_, i) => levels[i] === level).map(describe) };
}

/** The names a discovery's facts hold, for what came and went: tools, identities, contexts, credential sources. */
function namesOf(f: DiscoveryFacts): string[] {
  return [
    ...f.bins.map((b) => `tool ${b.dir}/${b.name}`),
    ...f.aws.filter((a) => a.arn !== undefined).map((a) => `aws ${a.profile}`),
    ...f.kube.map((k) => `kubernetes ${k.name}`),
    ...f.credentials.env.map((n) => `credential variable ${n}`),
    ...f.credentials.files.map((n) => `credential file ${n}`),
  ];
}

/** What a discovery changed since the one before it; the first is everything new, listed as none. */
export function changesOf(before: DiscoveryFacts | undefined, after: DiscoveryFacts, levelBefore: RadiusLevel | undefined, levelAfter: RadiusLevel): DiscoveryChanges {
  if (!before) return { first: true, added: [], removed: [] };
  const was = namesOf(before);
  const now = namesOf(after);
  const wasSet = new Set(was);
  const nowSet = new Set(now);
  return {
    first: false,
    added: now.filter((n) => !wasSet.has(n)),
    removed: was.filter((n) => !nowSet.has(n)),
    ...(levelBefore !== undefined && levelBefore !== levelAfter ? { level: { from: levelBefore, to: levelAfter } } : {}),
  };
}

/** Whether a level is higher than another. */
export const higher = (a: RadiusLevel, b: RadiusLevel): boolean => rankOf(a) > rankOf(b);

/** Why the gate keeps a machine from ordinary placement, or undefined: an actor machine always; else rated at or above the gate. */
export function gateOf(machineId: string, level: RadiusLevel | undefined, s: BlastRadiusSettings): string | undefined {
  const actor = s.actors.find((a) => a.machineId === machineId);
  if (actor) return `an actor machine (${actor.purpose})`;
  if (s.gateAt === 'off' || level === undefined) return undefined;
  return rankOf(level) >= rankOf(s.gateAt) ? `rated ${level}` : undefined;
}
