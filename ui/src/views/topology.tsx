// Infra → Topology (issue #1781, design.md "The infrastructure topology"): the graph of the services in the user's AWS
// accounts and Kubernetes clusters, and what is linked to what. A person filters it by account, cluster, region and kind,
// and clicks a node to read its details, its neighbours and the out-of-band changes that name it. Each source says when it
// was read, and a stale one says why. The page loads the graph (infra.tsx) and shows this panel always: an empty graph says
// how a check fills it. Read-only: nothing here acts on a cloud or a cluster.
import { Network } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Empty, Panel } from '@/components/panel';
import { changeHeadline } from '@/model/out-of-band';
import { changesOf, DRAW_MAX, filterChoices, filterGraph, layout, neighbours, sideOf, sourceName, sourceState, type TopologyFilter } from '@/model/topology';
import type { GraphNode, NodeKind, OutOfBandView, TopologyGraph } from '../../../src/domain/types.ts';

const SELECT = 'h-8 rounded-md border bg-transparent px-2 text-sm';
const SIZE = 640;
const FILL = { aws: 'fill-warn', kubernetes: 'fill-ok', cluster: 'fill-primary' } as const;

function Filters({ g, f, onF }: { g: TopologyGraph; f: TopologyFilter; onF: (f: TopologyFilter) => void }) {
  const c = filterChoices(g);
  const pick = (key: keyof TopologyFilter, label: string, options: { value: string; label: string }[]) => (
    <select aria-label={label} className={SELECT} value={f[key] ?? ''} onChange={(e) => onF({ ...f, [key]: e.target.value || undefined })}>
      <option value="">Every {label.toLowerCase()}</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
  return (
    <div className="flex flex-wrap gap-2">
      {pick('account', 'Account', c.accounts.map((a) => ({ value: a, label: a })))}
      {pick('cluster', 'Cluster', c.clusters.map((x) => ({ value: x.id, label: x.name })))}
      {pick('region', 'Region', c.regions.map((r) => ({ value: r, label: r })))}
      {pick('kind', 'Kind', c.kinds.map((k) => ({ value: k, label: k })))}
    </div>
  );
}

function Drawing({ nodes, links, selected, onSelect }: { nodes: GraphNode[]; links: TopologyGraph['links']; selected?: string; onSelect: (id: string) => void }) {
  const placed = useMemo(() => new Map(layout(nodes, links, SIZE).map((p) => [p.id, p])), [nodes, links]);
  return (
    <svg data-slot="topology-graph" viewBox={`0 0 ${SIZE} ${SIZE}`} className="w-full rounded-md border bg-muted/20" role="img" aria-label="Infrastructure topology">
      {links.map((l) => {
        const a = placed.get(l.from);
        const b = placed.get(l.to);
        return a && b ? <line key={`${l.from} ${l.kind} ${l.to}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="stroke-muted-foreground/40" strokeWidth={1} /> : null;
      })}
      {nodes.map((n) => {
        const p = placed.get(n.id);
        if (!p) return null;
        return (
          <g key={n.id} transform={`translate(${p.x},${p.y})`} className="cursor-pointer" onClick={() => onSelect(n.id)}>
            <title>{`${n.kind} ${n.name}`}</title>
            <circle r={n.id === selected ? 8 : 6} className={`${FILL[sideOf(n.kind)]} ${n.seen ? '' : 'opacity-40'} ${n.id === selected ? 'stroke-foreground' : 'stroke-background'}`} strokeWidth={1.5} />
            {nodes.length <= 80 && <text x={9} y={3} className="fill-foreground text-[9px]">{n.name}</text>}
          </g>
        );
      })}
    </svg>
  );
}

function Details({ g, node, changes, onSelect }: { g: TopologyGraph; node: GraphNode; changes: readonly OutOfBandView[]; onSelect: (id: string) => void }) {
  const near = neighbours(g, node.id);
  const touched = changesOf(node, changes);
  const where = [node.account && `account ${node.account}`, node.region, node.namespace && `namespace ${node.namespace}`].filter(Boolean).join(', ');
  return (
    <div data-slot="topology-node" className="space-y-2 rounded-md border p-3 text-sm">
      <p className="font-medium break-words">{node.kind} {node.name}</p>
      <p className="text-xs break-all text-muted-foreground">{node.id}</p>
      {where && <p className="text-xs text-muted-foreground">{where}</p>}
      <p className="text-xs text-muted-foreground">{node.seen ? `Found by ${node.sources.join(', ')}` : 'Named by a link only: no source read it'}</p>
      {node.attrs && <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-xs">{Object.entries(node.attrs).map(([k, v]) => [<dt key={`${k}t`} className="text-muted-foreground">{k}</dt>, <dd key={`${k}d`} className="break-all">{v}</dd>])}</dl>}
      <p className="text-xs font-medium">Neighbours</p>
      {near.length === 0 ? <p className="text-xs text-muted-foreground">No links.</p> : (
        <ul className="space-y-0.5 text-xs">
          {near.map((x, i) => <li key={`${x.node.id} ${i}`}>{x.words} <button type="button" className="underline" onClick={() => onSelect(x.node.id)}>{x.node.kind} {x.node.name}</button></li>)}
        </ul>
      )}
      <p className="text-xs font-medium">Recent changes</p>
      {touched.length === 0 ? <p className="text-xs text-muted-foreground">No out-of-band change names this node.</p>
        : <ul className="space-y-0.5 text-xs">{touched.slice(0, 10).map((c) => <li key={c.id}>{c.at}: {changeHeadline(c)}</li>)}</ul>}
    </div>
  );
}

export function TopologyPanel({ g, changes }: { g: TopologyGraph; changes: readonly OutOfBandView[] }) {
  const [f, setF] = useState<TopologyFilter>({});
  const [selected, setSelected] = useState<string | undefined>();
  const shown = useMemo(() => filterGraph(g, f), [g, f]);
  const node = g.nodes.find((n) => n.id === selected);
  const stale = g.sources.filter((s) => sourceState(s).stale).length;
  return (
    <Panel title="Topology" icon={Network} count={g.nodes.length || ''} bodyClassName="space-y-3">
      <p className="text-sm text-muted-foreground">The services in your AWS accounts and Kubernetes clusters, and what is linked to what. A read-only check reports each account and cluster; a source it cannot read keeps its last good snapshot.</p>
      {g.sources.length === 0 ? <Empty>No topology yet. A read-only check reports what it finds in an AWS account or a Kubernetes cluster with POST /ui/api/topology/report and an API token with the scope topology:report.</Empty> : (
        <>
          <ul data-slot="topology-sources" className="space-y-0.5 text-xs">
            {g.sources.map((s) => {
              const st = sourceState(s);
              return <li key={s.key} className={st.stale ? 'text-warn' : 'text-muted-foreground'}><span className="font-medium">{sourceName(s)}</span>: {st.words}</li>;
            })}
          </ul>
          {stale > 0 && <p className="text-xs text-warn">{stale === 1 ? 'One source is' : `${stale} sources are`} stale: the graph shows their last good snapshot.</p>}
          <Filters g={g} f={f} onF={setF} />
          {shown.nodes.length === 0 ? <Empty>No node holds every filter.</Empty>
            : shown.nodes.length > DRAW_MAX ? <Empty>{shown.nodes.length} nodes: too many to draw. Pick an account, a cluster, a region or a kind.</Empty>
            : <Drawing nodes={shown.nodes} links={shown.links} selected={selected} onSelect={setSelected} />}
          <p className="text-xs text-muted-foreground">{shown.nodes.length} nodes, {shown.links.length} links. Orange: AWS; green: Kubernetes; blue: a cluster; faint: named by a link only. Click a node.</p>
          {node && <Details g={g} node={node} changes={changes} onSelect={setSelected} />}
          <KindList kinds={filterChoices(g).kinds} nodes={shown.nodes} onSelect={setSelected} />
        </>
      )}
    </Panel>
  );
}

/** The nodes as a list by kind, for a person who reads rather than looks, and for a graph too large to draw. */
function KindList({ kinds, nodes, onSelect }: { kinds: NodeKind[]; nodes: GraphNode[]; onSelect: (id: string) => void }) {
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-muted-foreground">Every node by kind</summary>
      <ul className="mt-1 space-y-1">
        {kinds.map((k) => {
          const of = nodes.filter((n) => n.kind === k);
          return of.length === 0 ? null : (
            <li key={k}><span className="font-medium">{k}</span> ({of.length}): {of.slice(0, 200).map((n, i) => <span key={n.id}>{i > 0 && ', '}<button type="button" className="underline" onClick={() => onSelect(n.id)}>{n.name}</button></span>)}</li>
          );
        })}
      </ul>
    </details>
  );
}
