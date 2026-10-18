// The Topology globe's model (ui/src/model/topology-globe.ts, issue #1893), pure: each AWS region at its place, the region
// a node lives in, the nodes per region with their counts, the links between two regions as arcs, the nodes with no known
// place, the points the globe draws, and whether the browser can draw WebGL.
import { describe, expect, it } from 'vitest';
import { arcPoints, globeOf, nodeRegion, REGION_PLACES, regionPlace, toPoint, webglAvailable } from '../../ui/src/model/topology-globe.ts';
import { filterGraph } from '../../ui/src/model/topology.ts';
import { CLUSTER } from '../support/topology-answers.ts';
import { EAST_DB, twoRegions } from '../support/topology-globe-graph.ts';

const near = (p: number[], q: number[]): boolean => p.every((v, i) => Math.abs(v - q[i]!) < 1e-9);
const length = (p: number[]): number => Math.hypot(...p);

describe('region to coordinate', () => {
  it('puts each region at its place, on the Earth, and knows no other region', () => {
    expect(regionPlace('eu-west-1')).toEqual({ lat: 53.3, lon: -6.3, place: 'Ireland' });
    expect(regionPlace('us-east-1')?.place).toBe('N. Virginia');
    expect(regionPlace('ap-southeast-2')!.lat).toBeLessThan(0);
    expect(regionPlace('sa-east-1')!.lon).toBeLessThan(0);
    expect(regionPlace('eu-moon-9')).toBeUndefined();
    expect(regionPlace('toString')).toBeUndefined();
    for (const [region, p] of Object.entries(REGION_PLACES)) {
      expect(region).toMatch(/^[a-z]{2}(-[a-z]+)+-\d$/);
      expect(Math.abs(p.lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(p.lon)).toBeLessThanOrEqual(180);
    }
  });

  it('maps a place onto the sphere: y up, longitude 0 toward +z, east toward +x', () => {
    expect(near(toPoint(0, 0, 2), [0, 0, 2])).toBe(true);
    expect(near(toPoint(90, 0, 1), [0, 1, 0])).toBe(true);
    expect(near(toPoint(0, 90, 1), [1, 0, 0])).toBe(true);
    expect(length(toPoint(53.3, -6.3, 1.5))).toBeCloseTo(1.5);
  });

  it('draws an arc from one region to the other, above the sphere between them', () => {
    const [a, b] = [regionPlace('eu-west-1')!, regionPlace('us-east-1')!];
    const arc = arcPoints(a, b, 1, 16);
    expect(arc).toHaveLength(17);
    expect(near(arc[0]!, toPoint(a.lat, a.lon, 1))).toBe(true);
    expect(near(arc[16]!, toPoint(b.lat, b.lon, 1))).toBe(true);
    expect(length(arc[8]!)).toBeGreaterThan(1.1);
  });
});

describe('the nodes on the globe', () => {
  it('groups the nodes per region with their counts: a Kubernetes object at its cluster’s region, a bucket at the one S3 names', () => {
    const g = twoRegions();
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    const deployment = g.nodes.find((n) => n.kind === 'deployment')!;
    expect(deployment.region).toBeUndefined();
    expect(nodeRegion(deployment, byId)).toBe('eu-west-1');
    const globe = globeOf(g, filterGraph(g, {}));
    expect(globe.regions.map((r) => r.region)).toEqual(['eu-west-1', 'us-east-1']);
    const [eu, us] = globe.regions;
    expect(eu!.place).toBe('Ireland');
    expect(eu!.nodes.some((n) => n.id === CLUSTER)).toBe(true);
    expect(eu!.nodes.filter((n) => n.cluster === CLUSTER).length).toBeGreaterThan(3);
    expect(eu!.counts).toContainEqual({ kind: 'deployment', count: 1 });
    expect(eu!.counts.reduce((s, c) => s + c.count, 0)).toBe(eu!.nodes.length);
    expect(us!.nodes.map((n) => [n.kind, n.name]).sort()).toEqual([['bucket', 'east-logs'], ['database', 'reports']]);
  });

  it('draws the links between two regions as one arc, and none inside a region', () => {
    const g = twoRegions();
    const globe = globeOf(g, filterGraph(g, {}));
    expect(globe.arcs).toEqual([{ from: 'eu-west-1', to: 'us-east-1', links: 1 }]);
    expect(g.links.some((l) => l.to === EAST_DB && l.kind === 'uses')).toBe(true);
  });

  it('lists the nodes with no known place apart, and why', () => {
    const g = twoRegions();
    const why = new Map(globeOf(g, filterGraph(g, {})).unplaced.map((u) => [`${u.node.kind} ${u.node.name}`, u.why]));
    expect(why.get('aws-account 111111111111')).toBe('no region');
    expect(why.get('iam-role deploy')).toBe('no region');
    expect(why.get('bucket old-files')).toBe('no region');
    expect(why.get('bucket moon-files')).toBe('region eu-moon-9 has no known place');
    expect([...why.keys()].some((k) => k.startsWith('database') || k.startsWith('deployment'))).toBe(false);
  });

  it('reads the graph the filters leave: a filter keeps a Kubernetes object at its cluster even when it leaves out the cluster', () => {
    const g = twoRegions();
    const deployments = globeOf(g, filterGraph(g, { kind: 'deployment' }));
    expect(deployments.regions.map((r) => [r.region, r.nodes.length])).toEqual([['eu-west-1', 1]]);
    expect(deployments.arcs).toEqual([]);
    expect(globeOf(g, filterGraph(g, { region: 'us-east-1' })).regions.map((r) => r.region)).toEqual(['us-east-1']);
  });
});

describe('WebGL', () => {
  const canvas = (getContext: (kind: string) => unknown) => () => ({ getContext }) as unknown as HTMLCanvasElement;
  it('is there when a canvas gives a webgl2 or a webgl context, and not when it gives none or throws', () => {
    expect(webglAvailable(canvas((k) => (k === 'webgl2' ? {} : null)))).toBe(true);
    expect(webglAvailable(canvas((k) => (k === 'webgl' ? {} : null)))).toBe(true);
    expect(webglAvailable(canvas(() => null))).toBe(false);
    expect(webglAvailable(canvas(() => { throw new Error('no GPU'); }))).toBe(false);
  });
});
