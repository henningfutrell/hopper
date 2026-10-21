// The infrastructure topology (issue #1781, design.md "The infrastructure topology"): which services exist across the
// AWS accounts and Kubernetes clusters a user's read-only checks reach, and what is linked to what, as one graph. A
// **topology source** — one AWS account in one region, or one Kubernetes cluster — is reported as a whole: its nodes and
// links, or why it could not be read. Each source keeps its last good **topology snapshot** with when it was read, so a
// source that cannot be reached leaves the rest of the graph as it was. The graph is the snapshots joined: a node two
// sources name is one node, and a link names a node by its id (an ARN, a Kubernetes object) or by an alias (`dns:` a
// host name, `url:` a queue URL) that another source's node holds. The types, the limits, the checks and the join. Pure.

/** What a node is. A `cluster` is one node whether AWS (EKS) or its own Kubernetes API reported it: both name its ARN. */
export const NODE_KINDS = [
  'aws-account', 'vpc', 'cluster', 'load-balancer', 'database', 'queue', 'iam-role', 'bucket',
  'namespace', 'deployment', 'service', 'ingress', 'service-account',
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

/**
 * How two nodes are linked, read from `from` to `to`: `in` (a VPC in an account, a cluster in a VPC, a deployment in a
 * namespace), `routes-to` (a load balancer or an ingress to a service), `selects` (a service its deployment), `runs-as`
 * (a deployment its service account), `assumes` (a service account its IAM role, IRSA), `can-assume` (a principal of an
 * IAM role's trust policy, often of another account), `uses` (a workload a database or a queue it names).
 */
export const LINK_KINDS = ['in', 'routes-to', 'selects', 'runs-as', 'assumes', 'can-assume', 'uses'] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export const SOURCE_KINDS = ['aws', 'kubernetes'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** The most nodes and links one source holds, the most sources one report holds, and the longest text of a field. */
export const NODES_MAX = 20_000;
export const LINKS_MAX = 50_000;
export const SOURCES_MAX = 100;
/** The most names one read of the nodes Infra's changes touch takes (issue #2367): `GET /api/topology?touching=`. */
export const TOUCHING_MAX = 100;
const TEXT_MAX = 512;
const ATTRS_MAX = 32;
const ERROR_MAX = 2000;
const ACCOUNT = /^\d{12}$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;
/** An alias a node may hold, and a link may name in place of an id. */
const ALIAS = /^(dns|url):/;

export interface TopologyNode {
  /** Its id: an ARN for AWS, `aws-account:<id>` for an account, `k8s:<cluster>/<namespace>[/<kind>/<name>]` for Kubernetes. */
  id: string;
  kind: NodeKind;
  name: string;
  account?: string;
  region?: string;
  /** The cluster a Kubernetes object is in: the cluster node's id. */
  cluster?: string;
  namespace?: string;
  /** Other names other sources know it by: `dns:<host>` (a load balancer, a database endpoint), `url:<queue URL>`. */
  aliases?: string[];
  /** What a person reads on its details: its engine, its CIDR, its type. Short text only. */
  attrs?: Record<string, string>;
}

export interface TopologyLink { from: string; to: string; kind: LinkKind }

/** What a source is: an AWS account in one region, or a Kubernetes cluster (by its node's id). */
export type TopologySourceRef = { kind: 'aws'; account: string; region: string } | { kind: 'kubernetes'; cluster: string };

/** One source in a report: what it found, or why it could not be read. */
export type SourceReport =
  | { source: TopologySourceRef; ok: true; nodes: TopologyNode[]; links: TopologyLink[] }
  | { source: TopologySourceRef; ok: false; error: string };

/** A source as kept: its last good snapshot (when it had one), and its last read, good or not. */
export interface TopologySource {
  key: string;
  source: TopologySourceRef;
  /** Who reported it last: the API token's label, else who signed in. */
  reporter: string;
  lastGood?: { at: string; nodes: TopologyNode[]; links: TopologyLink[] };
  lastRead: { at: string; ok: boolean; error?: string };
}

/** A node in the joined graph: the sources that named it, and `seen` false when only a link names it (no source read it). */
export interface GraphNode extends TopologyNode { sources: string[]; seen: boolean }

/** A source as the graph shows it: no nodes, only how many, and whether its snapshot is stale (its last read failed). */
export interface SourceView { key: string; source: TopologySourceRef; reporter: string; lastGood?: { at: string; nodes: number; links: number }; lastRead: TopologySource['lastRead'] }

export interface TopologyGraph { nodes: GraphNode[]; links: TopologyLink[]; sources: SourceView[] }

/** A source's key: `aws/<account>/<region>`, `kubernetes/<cluster>`. A report of a source replaces its last one. */
export const sourceKey = (s: TopologySourceRef): string => (s.kind === 'aws' ? `aws/${s.account}/${s.region}` : `kubernetes/${s.cluster}`);

const text = (v: unknown, max = TEXT_MAX): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const optionalText = (v: unknown): boolean => v === undefined || text(v);

function sourceProblem(s: unknown): string | undefined {
  const r = (typeof s === 'object' && s !== null ? s : {}) as Record<string, unknown>;
  if (r.kind === 'aws') {
    if (typeof r.account !== 'string' || !ACCOUNT.test(r.account)) return 'an aws source names its account: 12 digits';
    if (typeof r.region !== 'string' || !REGION.test(r.region)) return 'an aws source names its region, as eu-west-1';
    return undefined;
  }
  if (r.kind === 'kubernetes') return text(r.cluster) ? undefined : 'a kubernetes source names its cluster: the cluster node\'s id (an EKS cluster\'s ARN)';
  return `source kind must be one of ${SOURCE_KINDS.join(', ')}`;
}

function nodeProblem(n: unknown): string | undefined {
  const r = (typeof n === 'object' && n !== null ? n : {}) as Record<string, unknown>;
  if (!text(r.id) || ALIAS.test(r.id)) return 'a node has an id, not an alias';
  if (!NODE_KINDS.includes(r.kind as NodeKind)) return `node ${r.id}: kind must be one of ${NODE_KINDS.join(', ')}`;
  if (!text(r.name)) return `node ${r.id} has no name`;
  if (![r.account, r.region, r.cluster, r.namespace].every(optionalText)) return `node ${r.id}: account, region, cluster and namespace are short text`;
  if (r.aliases !== undefined && !(Array.isArray(r.aliases) && r.aliases.length <= ATTRS_MAX && r.aliases.every((a) => text(a) && ALIAS.test(a)))) {
    return `node ${r.id}: each alias starts with dns: or url:`;
  }
  const attrs = r.attrs;
  if (attrs !== undefined && !(typeof attrs === 'object' && attrs !== null && !Array.isArray(attrs)
    && Object.keys(attrs).length <= ATTRS_MAX && Object.entries(attrs).every(([k, v]) => k.length <= 64 && typeof v === 'string' && v.length <= TEXT_MAX))) {
    return `node ${r.id}: attrs is at most ${ATTRS_MAX} short texts`;
  }
  return undefined;
}

function linkProblem(l: unknown): string | undefined {
  const r = (typeof l === 'object' && l !== null ? l : {}) as Record<string, unknown>;
  if (!text(r.from) || !text(r.to)) return 'a link names from and to';
  if (!LINK_KINDS.includes(r.kind as LinkKind)) return `link ${r.from} → ${r.to}: kind must be one of ${LINK_KINDS.join(', ')}`;
  return undefined;
}

/** Why a source's report is not whole, or undefined. A report that is not whole is refused, so no half snapshot is kept. */
export function sourceReportProblem(s: unknown): string | undefined {
  const r = (typeof s === 'object' && s !== null ? s : {}) as Record<string, unknown>;
  const source = sourceProblem(r.source);
  if (source) return source;
  if (r.ok === false) return text(r.error, ERROR_MAX) ? undefined : `a source that could not be read says why, in at most ${ERROR_MAX} characters`;
  if (r.ok !== true) return 'ok is true (with nodes and links) or false (with error)';
  if (!Array.isArray(r.nodes) || r.nodes.length > NODES_MAX) return `nodes is a list of at most ${NODES_MAX}`;
  if (!Array.isArray(r.links) || r.links.length > LINKS_MAX) return `links is a list of at most ${LINKS_MAX}`;
  for (const n of r.nodes) { const p = nodeProblem(n); if (p) return p; }
  for (const l of r.links) { const p = linkProblem(l); if (p) return p; }
  return undefined;
}

/** Only the fields a node has: nothing else a reporter sends is kept. */
const nodeOf = ({ id, kind, name, account, region, cluster, namespace, aliases, attrs }: TopologyNode): TopologyNode => ({
  id, kind, name, ...(account ? { account } : {}), ...(region ? { region } : {}), ...(cluster ? { cluster } : {}), ...(namespace ? { namespace } : {}),
  ...(aliases?.length ? { aliases } : {}), ...(attrs && Object.keys(attrs).length ? { attrs } : {}),
});

/** A report as kept: its source's fields, its nodes and links trimmed to theirs, each link once. */
export function cleanReport(r: SourceReport): SourceReport {
  const source: TopologySourceRef = r.source.kind === 'aws' ? { kind: 'aws', account: r.source.account, region: r.source.region } : { kind: 'kubernetes', cluster: r.source.cluster };
  if (!r.ok) return { source, ok: false, error: r.error.trim() };
  const seen = new Set<string>();
  const links = r.links.filter((l) => { const k = `${l.from} ${l.kind} ${l.to}`; return seen.has(k) ? false : (seen.add(k), true); }).map(({ from, to, kind }) => ({ from, to, kind }));
  return { source, ok: true, nodes: r.nodes.map(nodeOf), links };
}

/** What a link's end names when no source read it: an account, an IAM role, a cluster, from its id; else nothing. */
function stubOf(id: string): TopologyNode | undefined {
  const account = /^aws-account:(\d{12})$/.exec(id);
  if (account) return { id, kind: 'aws-account', name: account[1]!, account: account[1]! };
  const arn = /^arn:[\w-]+:([\w-]+):([\w-]*):(\d{12}):(.+)$/.exec(id);
  if (!arn) return undefined;
  const [, service, region, acct, rest] = arn as unknown as [string, string, string, string, string];
  const kind: NodeKind | undefined = service === 'iam' && rest.startsWith('role/') ? 'iam-role' : service === 'eks' && rest.startsWith('cluster/') ? 'cluster'
    : service === 'rds' ? 'database' : service === 'sqs' ? 'queue' : service === 'elasticloadbalancing' ? 'load-balancer' : undefined;
  if (!kind) return undefined;
  return { id, kind, name: rest.split('/').pop() ?? rest, account: acct, ...(region ? { region } : {}) };
}

/**
 * The graph of the kept sources: each one's last good snapshot, joined. A node named by more than one source is one
 * node, its fields from the first source that named them and its aliases and attrs merged. A link to an alias goes to the
 * node that holds it, and is dropped when none does (a host name in a workload's settings that no source read is no
 * node). A link to an id no source read gets a node of its own, `seen` false, when its id says what it is (an IAM role of
 * another account, an account); else it is dropped.
 */
export function joinGraph(sources: readonly TopologySource[]): TopologyGraph {
  const byId = new Map<string, GraphNode>();
  const ordered = [...sources].sort((a, b) => a.key.localeCompare(b.key));
  for (const s of ordered) {
    for (const n of s.lastGood?.nodes ?? []) {
      const had = byId.get(n.id);
      if (!had) { byId.set(n.id, { ...n, sources: [s.key], seen: true }); continue; }
      const aliases = [...new Set([...(had.aliases ?? []), ...(n.aliases ?? [])])];
      byId.set(n.id, {
        ...n, ...had, sources: [...had.sources, s.key], ...(aliases.length ? { aliases } : {}),
        ...(had.attrs || n.attrs ? { attrs: { ...n.attrs, ...had.attrs } } : {}),
      });
    }
  }
  const alias = new Map<string, string>();
  for (const n of byId.values()) for (const a of n.aliases ?? []) if (!alias.has(a)) alias.set(a, n.id);
  const end = (ref: string): string | undefined => {
    if (ALIAS.test(ref)) return alias.get(ref);
    if (byId.has(ref)) return ref;
    const stub = stubOf(ref);
    if (!stub) return undefined;
    byId.set(ref, { ...stub, sources: [], seen: false });
    return ref;
  };
  const links: TopologyLink[] = [];
  const seen = new Set<string>();
  for (const s of ordered) {
    for (const l of s.lastGood?.links ?? []) {
      const from = end(l.from);
      const to = end(l.to);
      if (!from || !to || from === to) continue;
      const k = `${from} ${l.kind} ${to}`;
      if (seen.has(k)) continue;
      seen.add(k);
      links.push({ from, to, kind: l.kind });
    }
  }
  return {
    nodes: [...byId.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    links,
    sources: ordered.map(viewOf),
  };
}

export const viewOf = (s: TopologySource): SourceView => ({
  key: s.key, source: s.source, reporter: s.reporter, lastRead: s.lastRead,
  ...(s.lastGood ? { lastGood: { at: s.lastGood.at, nodes: s.lastGood.nodes.length, links: s.lastGood.links.length } } : {}),
});

/** A source after a report of it: a good one replaces the snapshot; a failed one keeps the last good one, and says why. */
export function afterReport(was: TopologySource | undefined, r: SourceReport, reporter: string, at: string): TopologySource {
  const key = sourceKey(r.source);
  if (r.ok) return { key, source: r.source, reporter, lastGood: { at, nodes: r.nodes, links: r.links }, lastRead: { at, ok: true } };
  return { key, source: r.source, reporter, ...(was?.lastGood ? { lastGood: was.lastGood } : {}), lastRead: { at, ok: false, error: r.error } };
}

/** The topology sources a user's store keeps, one row each by its key. */
export interface TopologyRepository {
  get(key: string): TopologySource | undefined;
  put(source: TopologySource): void;
  list(): TopologySource[];
  /** Forgets a source (issue #1864: one discovery reported that never held a snapshot). */
  remove(key: string): void;
}

/** Every name a change's target may give a node, lower case: as Infra matches them (ui/src/model/topology.ts `namesOf`). */
const namesOf = (n: GraphNode): string[] => [n.id, n.name, ...(n.aliases ?? []).map((a) => a.replace(ALIAS, '')), ...Object.values(n.attrs ?? {})].map((x) => x.toLowerCase());

/** The nodes always kept for Infra: an asset names an account, a cluster or a namespace by fields, not by one name. */
const BY_ASSET: readonly NodeKind[] = ['aws-account', 'cluster', 'namespace'];

/**
 * What Infra reads to name the nodes its changes touched (issue #2367), in place of the whole graph: each account, cluster
 * and namespace node, each node of an account `touching` names, and each node one of them names. No links: Infra draws none.
 */
export function touchingGraph(g: TopologyGraph, touching: readonly string[]): TopologyGraph {
  const names = new Set(touching.map((t) => t.toLowerCase()));
  const kept = (n: GraphNode): boolean => BY_ASSET.includes(n.kind) || (n.account !== undefined && names.has(n.account.toLowerCase())) || namesOf(n).some((x) => names.has(x));
  return { nodes: g.nodes.filter(kept), links: [], sources: g.sources };
}
