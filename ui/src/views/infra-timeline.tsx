// Infra → Applies and drift (issue #896, design.md "The Infra page"): one timeline of plans recorded and approved, applies,
// drift and out-of-band writes, newest first. Each entry links to the topology nodes it touched (issue #1781, design.md
// "The infrastructure topology"): a click opens the node on the Topology page (issue #1943).
import { Empty } from '@/components/panel';
import type { TimelineEntry } from '@/model/infra-plans';
import { entryNodes } from '@/model/topology';
import type { TopologyGraph } from '../../../src/domain/types.ts';

export const KIND = { plan: 'Plan', approved: 'Approved', rejected: 'Rejected', apply: 'Apply', drift: 'Drift', 'out-of-band': 'Out of band', marked: 'Marked' } as const;
export const KIND_TONE = { plan: 'text-muted-foreground', approved: 'text-ok', rejected: 'text-destructive', apply: 'text-ok', drift: 'text-warn', 'out-of-band': 'text-warn', marked: 'text-muted-foreground' } as const;

/** The most nodes one entry links to; the rest are counted. */
const LINKED_MAX = 3;

function Nodes({ g, e, onNode }: { g: TopologyGraph; e: TimelineEntry; onNode: (id: string) => void }) {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const ids = entryNodes(g, e);
  if (ids.length === 0) return null;
  return (
    <span data-slot="infra-timeline-nodes" className="block text-xs text-muted-foreground">
      Touched: {ids.slice(0, LINKED_MAX).map((id, i) => {
        const n = byId.get(id)!;
        return <span key={id}>{i > 0 && ', '}<button type="button" className="underline" onClick={() => onNode(id)}>{n.kind} {n.name}</button></span>;
      })}
      {ids.length > LINKED_MAX && ` and ${ids.length - LINKED_MAX} more`}
    </span>
  );
}

/** The timeline; with the topology `g`, each entry's nodes, which `onNode` picks. */
export function InfraTimeline({ timeline, g, onNode }: { timeline: TimelineEntry[]; g?: TopologyGraph; onNode: (id: string) => void }) {
  if (timeline.length === 0) return <Empty>Nothing yet. Each plan, approval, apply and out-of-band change shows here, newest first.</Empty>;
  return (
    <ul data-slot="infra-timeline" className="space-y-1.5 text-sm">
      {timeline.map((e, i) => (
        <li key={`${e.at} ${e.kind} ${i}`} className="flex gap-2">
          <span className={`w-24 shrink-0 text-xs ${KIND_TONE[e.kind]}`}>{KIND[e.kind]}</span>
          <span className="min-w-0 flex-1 break-words">{e.words}{g && <Nodes g={g} e={e} onNode={onNode} />}</span>
          <time className="num shrink-0 text-xs text-muted-foreground" dateTime={e.at}>{e.at}</time>
        </li>
      ))}
    </ul>
  );
}
