// The summary of an infra plan (issue #870, design.md "Infra plans: the summary and the MAP tag check"): in plain words,
// what the plan adds, changes, replaces and destroys, and where; its risk callouts (destroys, IAM and identity, prod,
// data, network), each with its resources; its blast radius; its checks (the MAP tag). Made once, when the plan is kept,
// from its changes (infra-plan-changes.ts), and kept with it. Pure.
import type { Asset } from './access.ts';
import { CHANGE_ACTIONS, MAP_TAG, type ChangeAction, type PlannedChange } from './infra-plan-changes.ts';
import type { PlanTool } from './infra-plans.ts';

export const PLAN_RISKS = ['destroy', 'iam', 'prod', 'data', 'network'] as const;
export type PlanRisk = (typeof PLAN_RISKS)[number];
/** `high` when the plan destroys, touches IAM, prod or data, fails a check, or cannot be read; else `low`. */
export type PlanLevel = 'low' | 'high';

export interface RiskCallout { risk: PlanRisk; words: string; resources: string[] }
export interface PlanCheck { name: 'map-tag'; ok: boolean; words: string; resources?: string[] }

export interface PlanSummary {
  /** One line: "Adds 2 security group rules in uat; changes nothing in prod; destroys nothing". */
  words: string;
  level: PlanLevel;
  counts: Record<ChangeAction, number>;
  /** The environments the target and the resources name, in the order first named. */
  environments: string[];
  risks: RiskCallout[];
  blastRadius: string;
  checks: PlanCheck[];
  /** A check failed: the plan is kept and shown, but nobody approves it and the vault applies it never. */
  failed: boolean;
}

/** The environments a name says, as words of their own (`uat-network`, `aws_instance.prod_web`, `prod/web`). */
const ENVIRONMENTS: [string, RegExp][] = [
  ['prod', /(^|[^a-z0-9])(prod|production|prd)($|[^a-z0-9])/i],
  ['uat', /(^|[^a-z0-9])uat($|[^a-z0-9])/i],
  ['staging', /(^|[^a-z0-9])(staging|stage|stg)($|[^a-z0-9])/i],
  ['dev', /(^|[^a-z0-9])(dev|development)($|[^a-z0-9])/i],
  ['qa', /(^|[^a-z0-9])qa($|[^a-z0-9])/i],
];
/** The environments the hopper knows, in that order (issue #870 part 4: the environment watchers are named by them). */
export const PLAN_ENVIRONMENTS: readonly string[] = ENVIRONMENTS.map(([env]) => env);
const envsOf = (s: string): string[] => ENVIRONMENTS.filter(([, re]) => re.test(s)).map(([env]) => env);
const changeEnvs = (c: PlannedChange): string[] => [...envsOf(c.address), ...(c.envTag ? envsOf(c.envTag) : [])];

const IAM = /^(aws_(iam|ssoadmin|identitystore|organizations|cognito)_|[a-z]+_.*iam_)|^(Role|ClusterRole|RoleBinding|ClusterRoleBinding|ServiceAccount)$/;
const NETWORK = /^aws_(default_)?(vpc|subnet|route|security_group|network_acl|nat_gateway|internet_gateway|egress_only_internet_gateway|eip|ec2_transit_gateway|lb|alb|vpn|customer_gateway|route53|networkfirewall|wafv2|cloudfront|api_gateway|apigatewayv2|globalaccelerator)|^(NetworkPolicy|Ingress|Service|Gateway|HTTPRoute|VirtualService)$/;
const DATA = /^aws_(db_|rds_|s3_bucket|dynamodb_|efs_|ebs_volume|elasticache_|redshift|docdb_|neptune_|backup_|kms_|secretsmanager_|opensearch_|elasticsearch_|msk_|kinesis_)|^(PersistentVolumeClaim|PersistentVolume|StatefulSet|Secret)$/;

const plural = (n: number, word: string): string => {
  if (n === 1) return `${n} ${word}`;
  if (/[^aeiou]y$/.test(word)) return `${n} ${word.slice(0, -1)}ies`;
  return /(s|x|ch|sh)$/.test(word) ? `${n} ${word}es` : `${n} ${word}s`;
};
/** A type in words: `aws_security_group_rule` → `security group rule`; a Kubernetes kind as it is. */
const typeWords = (type: string): string => (/^[a-z0-9]+_/.test(type) ? type.replace(/^[a-z0-9]+_/, '').replace(/_/g, ' ') : type);
const listed = (items: string[], max: number): string => (items.length <= max ? items.join(', ') : `${items.slice(0, max).join(', ')}, and ${items.length - max} more`);

const VERB: Record<ChangeAction, string> = { create: 'adds', update: 'changes', replace: 'replaces', delete: 'destroys' };

/** "adds 2 security group rules, 1 instance": the changes of one action, by type, most first. */
function verbPhrase(action: ChangeAction, changes: PlannedChange[]): string | undefined {
  const of = changes.filter((c) => c.action === action);
  if (of.length === 0) return undefined;
  const byType = new Map<string, number>();
  for (const c of of) byType.set(c.type, (byType.get(c.type) ?? 0) + 1);
  const types = [...byType].sort((a, b) => b[1] - a[1]).map(([t, n]) => plural(n, typeWords(t)));
  return `${VERB[action]} ${listed(types, 3)}`;
}

function callout(risk: PlanRisk, label: string, of: PlannedChange[]): RiskCallout | undefined {
  if (of.length === 0) return undefined;
  const names = of.map((c) => (risk === 'destroy' && c.action === 'replace' ? `${c.address} (replaced)` : c.address));
  return { risk, words: `${label}: ${plural(of.length, 'resource')}: ${listed(names, 5)}`, resources: of.map((c) => c.address) };
}

function mapTagCheck(changes: PlannedChange[]): PlanCheck {
  const tag = `${MAP_TAG.key}=${MAP_TAG.value}`;
  const missing = changes.filter((c) => c.untagged).map((c) => c.address);
  return missing.length === 0
    ? { name: 'map-tag', ok: true, words: `Every new AWS resource has the MAP tag ${tag}` }
    : { name: 'map-tag', ok: false, words: `${plural(missing.length, 'new AWS resource')} ${missing.length === 1 ? 'lacks' : 'lack'} the MAP tag ${tag}: ${listed(missing, 5)}`, resources: missing };
}

/** The summary of a plan's changes, applied as `asset` to `target`. */
export function summarize(tool: PlanTool, changes: PlannedChange[], at: { target: string; asset: Asset }): PlanSummary {
  const targetEnvs = envsOf(at.target);
  const environments = [...new Set([...targetEnvs, ...changes.flatMap(changeEnvs)])];
  const inProd = (c: PlannedChange): boolean => targetEnvs.includes('prod') || changeEnvs(c).includes('prod');
  const risks = [
    callout('destroy', 'Destroys', changes.filter((c) => c.action === 'delete' || c.action === 'replace')),
    callout('iam', 'IAM and identity', changes.filter((c) => IAM.test(c.type))),
    callout('prod', 'Prod', changes.filter(inProd)),
    callout('data', 'Data', changes.filter((c) => c.action !== 'create' && DATA.test(c.type))),
    callout('network', 'Network', changes.filter((c) => NETWORK.test(c.type))),
  ].filter((r): r is RiskCallout => r !== undefined);
  const checks = tool === 'terraform' ? [mapTagCheck(changes)] : [];
  const failed = checks.some((c) => !c.ok);
  const unread = tool !== 'terraform' && changes.length === 0;
  const counts = Object.fromEntries(CHANGE_ACTIONS.map((a) => [a, changes.filter((c) => c.action === a).length])) as Record<ChangeAction, number>;
  const level: PlanLevel = unread || failed || risks.some((r) => r.risk !== 'network') ? 'high' : 'low';
  const where = environments.length > 0 ? ` in ${environments.join(', ')}` : ', environment not named';
  const kinds = new Set(changes.map((c) => c.type)).size;
  return {
    words: wordsOf(changes, environments, where, unread), level, counts, environments, risks,
    blastRadius: `${plural(changes.length, 'resource')} of ${plural(kinds, 'kind')}${environments.length > 0 ? `, in ${environments.join(', ')}` : ', environment not named'}; applied as ${at.asset.kind} ${at.asset.name} to ${at.target}`,
    checks, failed,
  };
}

function wordsOf(changes: PlannedChange[], environments: string[], where: string, unread: boolean): string {
  if (unread) return 'The hopper found no change it knows in this diff: read the plan';
  if (changes.length === 0) return 'Changes nothing';
  const phrases = CHANGE_ACTIONS.map((a) => verbPhrase(a, changes)).filter((p): p is string => p !== undefined).join(', ');
  const prod = environments.length > 0 && !environments.includes('prod') ? '; changes nothing in prod' : '';
  const destroys = changes.some((c) => c.action === 'delete' || c.action === 'replace') ? '' : '; destroys nothing';
  return `${phrases.charAt(0).toUpperCase()}${phrases.slice(1)}${where}${prod}${destroys}`;
}
