// The infrastructure topology on Infra (issue #1781, design.md "The infrastructure topology"), pure: the filters a person
// picks (account, cluster, region, kind) and the graph they leave, a node's neighbours, the nodes each Infra changes entry
// touched and the entries that touched a node, each source's state in words, and where each node is drawn (d3's force layout, run to its end, so the same graph
// is drawn the same way).
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3';
import type { GraphNode, LinkKind, NodeKind, SourceView, TopologyGraph, TopologyLink } from '../../../src/domain/types.ts';
import type { TimelineEntry } from './infra-plans.ts';

export type TopologyFilter = { account?: string; cluster?: string; region?: string; kind?: NodeKind };

/** The values each filter may take, from the nodes themselves, sorted. */
export function filterChoices(g: TopologyGraph): { accounts: string[]; clusters: { id: string; name: string }[]; regions: string[]; kinds: NodeKind[] } {
  const sorted = (xs: Iterable<string | undefined>): string[] => [...new Set([...xs].filter((x): x is string => !!x))].sort();
  return {
    accounts: sorted(g.nodes.map((n) => n.account)),
    clusters: g.nodes.filter((n) => n.kind === 'cluster').map((n) => ({ id: n.id, name: n.name })).sort((a, b) => a.name.localeCompare(b.name)),
    regions: sorted(g.nodes.map((n) => n.region)),
    kinds: sorted(g.nodes.map((n) => n.kind)) as NodeKind[],
  };
}

/** A node the filter keeps: each filter that is set holds for it. A cluster is in its own cluster. */
const kept = (n: GraphNode, f: TopologyFilter): boolean =>
  (!f.account || n.account === f.account) && (!f.region || n.region === f.region) && (!f.kind || n.kind === f.kind)
  && (!f.cluster || n.cluster === f.cluster || n.id === f.cluster);

/** The graph the filter leaves: its nodes, and the links whose two ends it kept. */
export function filterGraph(g: TopologyGraph, f: TopologyFilter): { nodes: GraphNode[]; links: TopologyLink[] } {
  const nodes = g.nodes.filter((n) => kept(n, f));
  const ids = new Set(nodes.map((n) => n.id));
  return { nodes, links: g.links.filter((l) => ids.has(l.from) && ids.has(l.to)) };
}

const LINK_WORDS: Record<LinkKind, [out: string, back: string]> = {
  in: ['is in', 'holds'], 'routes-to': ['routes to', 'is behind'], selects: ['selects', 'is selected by'], 'runs-as': ['runs as', 'is the identity of'],
  assumes: ['assumes', 'is assumed by'], 'can-assume': ['may assume', 'may be assumed by'], uses: ['uses', 'is used by'],
};

export type Neighbour = { node: GraphNode; words: string };

/** Each node a link joins to this one, with the link in words from this node's side ("is in", "is behind"). */
export function neighbours(g: TopologyGraph, id: string): Neighbour[] {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  return g.links.flatMap((l): Neighbour[] => {
    const other = l.from === id ? byId.get(l.to) : l.to === id ? byId.get(l.from) : undefined;
    return other ? [{ node: other, words: LINK_WORDS[l.kind][l.from === id ? 0 : 1] }] : [];
  });
}

/** The names a change's target may give a node: its id, its name, an alias without its prefix, an attr (`vpc-1`). */
const namesOf = (n: GraphNode): Set<string> =>
  new Set([n.id, n.name, ...(n.aliases ?? []).map((a) => a.replace(/^(dns|url):/, '')), ...Object.values(n.attrs ?? {})].map((s) => s.toLowerCase()));

/** The most names Infra's topology read takes (issue #2367): `TOUCHING_MAX` in src/domain/topology.ts. More read the whole graph. */
const TOUCHING_MAX = 100;

/** The names an entry's nodes are found by: its target, or its asset's name and each end of it (`<account>/<role path>`, `<cluster>/<namespace>`). */
function entryNames(e: TimelineEntry): string[] {
  const s = e.subject;
  if (!s) return [];
  if ('target' in s) return [s.target];
  const parts = s.asset.name.split('/');
  return [s.asset.name, parts[0]!, parts[parts.length - 1]!];
}

/**
 * The topology read that names the nodes of Infra's timeline (issue #2367): only the nodes its entries can touch, not the
 * whole graph (megabytes); undefined when no entry names a node.
 */
export function topologyPathFor(timeline: readonly TimelineEntry[]): string | undefined {
  const names = [...new Set(timeline.flatMap(entryNames).filter((n) => n !== '').map((n) => n.toLowerCase()))].sort();
  if (names.length === 0) return undefined;
  if (names.length > TOUCHING_MAX) return '/api/topology';
  return `/api/topology?${names.map((n) => `touching=${encodeURIComponent(n)}`).join('&')}`;
}

/**
 * The nodes an Infra changes entry touched (issue #1781). An out-of-band change or drift: each node its target names. A
 * plan, its approval or an apply, by its asset: an AWS account; an AWS role and the account it writes in; a cluster by its
 * name; a namespace (`<cluster>/<namespace>`) of that cluster. An Argo CD app or a Terraform workspace names no node.
 */
export function entryNodes(g: TopologyGraph, e: TimelineEntry): string[] {
  const s = e.subject;
  if (!s) return [];
  if ('target' in s) {
    const t = s.target.toLowerCase();
    return g.nodes.filter((n) => namesOf(n).has(t)).map((n) => n.id);
  }
  const { kind, name } = s.asset;
  const slash = name.indexOf('/');
  const [head, rest] = slash < 0 ? [name, ''] : [name.slice(0, slash), name.slice(slash + 1)];
  const clusters = (named: string): string[] => g.nodes.filter((n) => n.kind === 'cluster' && (n.name === named || n.id === named)).map((n) => n.id);
  const hit = (keep: (n: GraphNode) => boolean): string[] => g.nodes.filter(keep).map((n) => n.id);
  if (kind === 'aws-account') return hit((n) => n.kind === 'aws-account' && n.account === name);
  if (kind === 'aws-role') return hit((n) => n.account === head && (n.kind === 'aws-account' || (n.kind === 'iam-role' && n.name === rest.split('/').pop())));
  if (kind === 'cluster') return clusters(name);
  if (kind === 'namespace') {
    const of = new Set(clusters(head));
    return hit((n) => n.kind === 'namespace' && n.namespace === rest && !!n.cluster && of.has(n.cluster));
  }
  return [];
}

/** The Infra changes entries that touched this node, newest first. */
export const nodeEntries = (g: TopologyGraph, id: string, timeline: readonly TimelineEntry[]): TimelineEntry[] =>
  timeline.filter((e) => entryNodes(g, e).includes(id)).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

/** A source's name: `AWS 123456789012 eu-west-1`, `Kubernetes prod`. */
export const sourceName = (s: SourceView): string =>
  (s.source.kind === 'aws' ? `AWS ${s.source.account} ${s.source.region}` : `Kubernetes ${s.source.cluster.split('/').pop() ?? s.source.cluster}`);

/** A source's state: what its last good snapshot holds and when it was read; stale, and why, when its last read failed. */
export function sourceState(s: SourceView): { stale: boolean; words: string } {
  const snapshot = s.lastGood ? `${s.lastGood.nodes} nodes and ${s.lastGood.links} links, read at ${s.lastGood.at}` : 'no snapshot yet';
  if (s.lastRead.ok) return { stale: false, words: `${snapshot}, by ${s.reporter}` };
  return { stale: true, words: `the last read at ${s.lastRead.at} failed: ${s.lastRead.error ?? 'no reason given'}; shown: ${snapshot}` };
}

/** Which side a node is on, for its colour. */
export const sideOf = (k: NodeKind): 'aws' | 'kubernetes' | 'cluster' =>
  (k === 'cluster' ? 'cluster' : ['namespace', 'deployment', 'service', 'ingress', 'service-account'].includes(k) ? 'kubernetes' : 'aws');

/** The most nodes the page draws; more are listed, and a person narrows the filters. */
export const DRAW_MAX = 400;

export type Placed = { id: string; x: number; y: number };

/** Where each node is drawn in a `size` square: d3's force layout run to its end, its links pulling, every node pushing. */
export function layout(nodes: readonly GraphNode[], links: readonly TopologyLink[], size: number): Placed[] {
  type N = SimulationNodeDatum & { id: string };
  const sim: N[] = nodes.map((n) => ({ id: n.id }));
  const ls: SimulationLinkDatum<N>[] = links.map((l) => ({ source: l.from, target: l.to }));
  const s = forceSimulation(sim)
    .force('link', forceLink<N, SimulationLinkDatum<N>>(ls).id((d) => d.id).distance(40))
    .force('charge', forceManyBody().strength(-60)).force('x', forceX(0).strength(0.05)).force('y', forceY(0).strength(0.05))
    .force('collide', forceCollide(10)).stop();
  s.tick(300);
  const xs = sim.map((d) => d.x ?? 0);
  const ys = sim.map((d) => d.y ?? 0);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const pad = 24;
  const scale = (size - 2 * pad) / Math.max(maxX - minX, maxY - minY, 1);
  return sim.map((d) => ({ id: d.id, x: pad + ((d.x ?? 0) - minX) * scale, y: pad + ((d.y ?? 0) - minY) * scale }));
}
