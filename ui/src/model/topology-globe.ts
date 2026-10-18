// The Topology globe on Infra (issue #1893, design.md "The infrastructure topology"), pure: where each AWS region is on
// the Earth, the region a node lives in, the nodes grouped per region with their counts, the topology links between two
// regions as arcs, the nodes with no known place, and the points the globe draws. It reads the graph the filters leave,
// as the graph view does: no new discovery, no cloud call.
import type { GraphNode, NodeKind, TopologyGraph, TopologyLink } from '../../../src/domain/types.ts';

export type Place = { lat: number; lon: number; place: string };

/** Each AWS region at the city or the area AWS names for it, in degrees (north and east are positive). */
export const REGION_PLACES: Readonly<Record<string, Place>> = {
  'us-east-1': { lat: 38.9, lon: -77.4, place: 'N. Virginia' }, 'us-east-2': { lat: 40.0, lon: -83.0, place: 'Ohio' },
  'us-west-1': { lat: 37.4, lon: -121.9, place: 'N. California' }, 'us-west-2': { lat: 45.8, lon: -119.7, place: 'Oregon' },
  'us-gov-east-1': { lat: 39.9, lon: -82.6, place: 'GovCloud US-East' }, 'us-gov-west-1': { lat: 45.6, lon: -121.2, place: 'GovCloud US-West' },
  'ca-central-1': { lat: 45.5, lon: -73.6, place: 'Montreal' }, 'ca-west-1': { lat: 51.0, lon: -114.1, place: 'Calgary' },
  'mx-central-1': { lat: 20.6, lon: -100.4, place: 'Mexico' }, 'sa-east-1': { lat: -23.5, lon: -46.6, place: 'São Paulo' },
  'eu-west-1': { lat: 53.3, lon: -6.3, place: 'Ireland' }, 'eu-west-2': { lat: 51.5, lon: -0.1, place: 'London' },
  'eu-west-3': { lat: 48.9, lon: 2.4, place: 'Paris' }, 'eu-central-1': { lat: 50.1, lon: 8.7, place: 'Frankfurt' },
  'eu-central-2': { lat: 47.4, lon: 8.5, place: 'Zurich' }, 'eu-south-1': { lat: 45.5, lon: 9.2, place: 'Milan' },
  'eu-south-2': { lat: 41.6, lon: -0.9, place: 'Spain' }, 'eu-north-1': { lat: 59.3, lon: 18.1, place: 'Stockholm' },
  'il-central-1': { lat: 32.1, lon: 34.8, place: 'Tel Aviv' }, 'me-south-1': { lat: 26.1, lon: 50.6, place: 'Bahrain' },
  'me-central-1': { lat: 25.2, lon: 55.3, place: 'UAE' }, 'af-south-1': { lat: -33.9, lon: 18.4, place: 'Cape Town' },
  'ap-south-1': { lat: 19.1, lon: 72.9, place: 'Mumbai' }, 'ap-south-2': { lat: 17.4, lon: 78.5, place: 'Hyderabad' },
  'ap-east-1': { lat: 22.3, lon: 114.2, place: 'Hong Kong' }, 'ap-east-2': { lat: 25.0, lon: 121.5, place: 'Taipei' },
  'ap-southeast-1': { lat: 1.35, lon: 103.8, place: 'Singapore' }, 'ap-southeast-2': { lat: -33.9, lon: 151.2, place: 'Sydney' },
  'ap-southeast-3': { lat: -6.2, lon: 106.8, place: 'Jakarta' }, 'ap-southeast-4': { lat: -37.8, lon: 145.0, place: 'Melbourne' },
  'ap-southeast-5': { lat: 3.1, lon: 101.7, place: 'Malaysia' }, 'ap-southeast-6': { lat: -36.8, lon: 174.8, place: 'New Zealand' },
  'ap-southeast-7': { lat: 13.8, lon: 100.5, place: 'Thailand' }, 'ap-northeast-1': { lat: 35.7, lon: 139.7, place: 'Tokyo' },
  'ap-northeast-2': { lat: 37.6, lon: 127.0, place: 'Seoul' }, 'ap-northeast-3': { lat: 34.7, lon: 135.5, place: 'Osaka' },
  'cn-north-1': { lat: 39.9, lon: 116.4, place: 'Beijing' }, 'cn-northwest-1': { lat: 37.5, lon: 105.2, place: 'Ningxia' },
};

/** Where a region is, or nothing for a region this table does not know. */
export const regionPlace = (region: string): Place | undefined => (Object.hasOwn(REGION_PLACES, region) ? REGION_PLACES[region] : undefined);

/** The region an ARN names (`arn:aws:eks:eu-west-1:…`), or nothing (an IAM role, a bucket: global). */
const arnRegion = (id: string): string | undefined => {
  const r = id.startsWith('arn:') ? id.split(':')[3] : undefined;
  return r || undefined;
};

/** The region a node lives in: its own; else, for a Kubernetes object, its cluster's; else the one its ARN names. */
export function nodeRegion(n: GraphNode, byId: ReadonlyMap<string, GraphNode>): string | undefined {
  if (n.region) return n.region;
  const cluster = n.cluster ? byId.get(n.cluster) : undefined;
  return cluster?.region ?? (n.cluster ? arnRegion(n.cluster) : undefined) ?? arnRegion(n.id);
}

export type GlobeRegion = Place & { region: string; nodes: GraphNode[]; counts: { kind: NodeKind; count: number }[] };
/** The topology links between two regions, both ways, as one arc: `from` sorts before `to`. */
export type GlobeArc = { from: string; to: string; links: number };
/** A node the globe cannot place, and why: no region, or a region with no known place. */
export type Unplaced = { node: GraphNode; why: string };
export type Globe = { regions: GlobeRegion[]; arcs: GlobeArc[]; unplaced: Unplaced[] };

/**
 * The globe of the nodes and links the filters leave (`shown`): the nodes per region, most first; an arc for each pair of
 * regions a link joins; the nodes with no known place. A Kubernetes object's cluster is looked up in the whole graph `g`,
 * so a filter that leaves out the cluster leaves its objects where they live.
 */
export function globeOf(g: TopologyGraph, shown: { nodes: readonly GraphNode[]; links: readonly TopologyLink[] }): Globe {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const at = new Map<string, string>();
  const per = new Map<string, GraphNode[]>();
  const unplaced: Unplaced[] = [];
  for (const n of shown.nodes) {
    const region = nodeRegion(n, byId);
    if (!region) { unplaced.push({ node: n, why: 'no region' }); continue; }
    if (!regionPlace(region)) { unplaced.push({ node: n, why: `region ${region} has no known place` }); continue; }
    at.set(n.id, region);
    per.set(region, [...(per.get(region) ?? []), n]);
  }
  const regions = [...per].map(([region, nodes]): GlobeRegion => {
    const counts = new Map<NodeKind, number>();
    for (const n of nodes) counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1);
    return { region, ...regionPlace(region)!, nodes, counts: [...counts].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind)) };
  }).sort((a, b) => b.nodes.length - a.nodes.length || a.region.localeCompare(b.region));
  const arcs = new Map<string, GlobeArc>();
  for (const l of shown.links) {
    const [a, b] = [at.get(l.from), at.get(l.to)];
    if (!a || !b || a === b) continue;
    const [from, to] = a < b ? [a, b] : [b, a];
    const key = `${from} ${to}`;
    arcs.set(key, { from, to, links: (arcs.get(key)?.links ?? 0) + 1 });
  }
  return { regions, arcs: [...arcs.values()].sort((x, y) => y.links - x.links || x.from.localeCompare(y.from) || x.to.localeCompare(y.to)), unplaced };
}

export type Point = [x: number, y: number, z: number];

/** A place on a sphere of radius `r`, as three.js draws it: y up, longitude 0 toward +z, east toward +x. */
export function toPoint(lat: number, lon: number, r: number): Point {
  const [phi, lambda] = [(lat * Math.PI) / 180, (lon * Math.PI) / 180];
  return [r * Math.cos(phi) * Math.sin(lambda), r * Math.sin(phi), r * Math.cos(phi) * Math.cos(lambda)];
}

/** The arc between two places: the great circle, lifted above the sphere at its middle by a part of its length. */
export function arcPoints(a: Place, b: Place, r: number, steps = 32): Point[] {
  const [p, q] = [toPoint(a.lat, a.lon, 1), toPoint(b.lat, b.lon, 1)];
  const omega = Math.acos(Math.min(1, Math.max(-1, p[0] * q[0] + p[1] * q[1] + p[2] * q[2])));
  const lift = 0.15 + 0.35 * (omega / Math.PI);
  return Array.from({ length: steps + 1 }, (_, i): Point => {
    const t = i / steps;
    const [wa, wb] = omega < 1e-6 ? [1 - t, t] : [Math.sin((1 - t) * omega) / Math.sin(omega), Math.sin(t * omega) / Math.sin(omega)];
    const h = r * (1 + lift * Math.sin(Math.PI * t));
    return [h * (wa * p[0] + wb * q[0]), h * (wa * p[1] + wb * q[1]), h * (wa * p[2] + wb * q[2])];
  });
}

/** Whether this browser can draw WebGL: a canvas gives a `webgl2` or a `webgl` context. */
export function webglAvailable(canvas: () => HTMLCanvasElement = () => document.createElement('canvas')): boolean {
  try {
    const c = canvas();
    return !!(c.getContext('webgl2') ?? c.getContext('webgl'));
  } catch {
    return false;
  }
}
