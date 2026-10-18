// Infra → Topology → Globe (issue #1893, design.md "The infrastructure topology"): the nodes the filters leave, at the
// AWS region they live in, a marker per region and an arc for the links between two regions, drawn with three.js
// (globe-scene.ts, loaded only here). Each region is listed too, with its counts by kind: a click on a region, on the globe
// or in the list, lists its nodes, and a click on a node picks it, as on the graph. The nodes with no known place are in a
// list of their own. When the scene cannot start, `onFail` says why and the panel shows the graph.
import { useEffect, useMemo, useRef, useState } from 'react';
import { globeOf } from '@/model/topology-globe';
import type { GraphNode, TopologyGraph, TopologyLink } from '../../../src/domain/types.ts';

const plural = (n: number, one: string): string => `${n} ${n === 1 ? one : `${one}s`}`;

function NodeButtons({ nodes, onSelect }: { nodes: readonly GraphNode[]; onSelect: (id: string) => void }) {
  return <>{nodes.slice(0, 200).map((n, i) => <span key={n.id}>{i > 0 && ', '}<button type="button" className="underline" onClick={() => onSelect(n.id)}>{n.kind} {n.name}</button></span>)}</>;
}

export function GlobeView({ g, shown, selected, onSelect, onFail }: {
  g: TopologyGraph; shown: { nodes: GraphNode[]; links: TopologyLink[] }; selected?: string; onSelect: (id: string) => void; onFail: (why: string) => void;
}) {
  const globe = useMemo(() => globeOf(g, shown), [g, shown]);
  const [picked, setPicked] = useState<string | undefined>();
  const host = useRef<HTMLDivElement>(null);
  const selectedRegion = globe.regions.find((r) => r.nodes.some((n) => n.id === selected))?.region;
  const region = globe.regions.find((r) => r.region === (picked ?? selectedRegion));
  const failed = useRef(onFail);
  useEffect(() => { failed.current = onFail; });
  useEffect(() => {
    const el = host.current;
    if (!el) return undefined;
    let gone = false;
    let dispose: (() => void) | undefined;
    import('./globe-scene').then((m) => {
      if (gone) return;
      try { dispose = m.mountGlobe(el, globe.regions, globe.arcs, region?.region, setPicked).dispose; } catch (e) { failed.current((e as Error).message || String(e)); }
    }).catch((e: unknown) => { if (!gone) failed.current((e as Error).message || String(e)); });
    return () => { gone = true; dispose?.(); };
  }, [globe, region?.region]);
  return (
    <div className="space-y-2">
      <div ref={host} data-slot="topology-globe" role="img" aria-label="Infrastructure topology on a globe" className="w-full overflow-hidden rounded-md border bg-muted/20" />
      <p className="text-xs text-muted-foreground">{plural(globe.regions.length, 'region')}, {plural(globe.arcs.length, 'arc')} between regions. Drag to turn, wheel to zoom.</p>
      {globe.regions.length > 0 && (
        <ul data-slot="topology-globe-regions" className="space-y-0.5 text-xs">
          {globe.regions.map((r) => (
            <li key={r.region}>
              <button type="button" aria-pressed={r.region === region?.region} className={`underline ${r.region === region?.region ? 'font-medium' : ''}`} onClick={() => setPicked(r.region)}>{r.region} ({r.place})</button>
              {': '}{plural(r.nodes.length, 'node')} — {r.counts.map((c) => `${c.count} ${c.kind}`).join(', ')}
            </li>
          ))}
        </ul>
      )}
      {region && (
        <div data-slot="topology-globe-region" className="rounded-md border p-3 text-xs">
          <p className="mb-1 font-medium">{region.region} ({region.place}): {plural(region.nodes.length, 'node')}</p>
          <NodeButtons nodes={region.nodes} onSelect={onSelect} />
        </div>
      )}
      {globe.unplaced.length > 0 && (
        <div data-slot="topology-globe-unplaced" className="text-xs">
          <p className="font-medium">No known place ({globe.unplaced.length})</p>
          <ul className="space-y-0.5">
            {globe.unplaced.slice(0, 200).map((u) => <li key={u.node.id}><NodeButtons nodes={[u.node]} onSelect={onSelect} /> <span className="text-muted-foreground">— {u.why}</span></li>)}
          </ul>
        </div>
      )}
    </div>
  );
}
