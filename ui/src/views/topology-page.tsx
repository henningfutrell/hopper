// Topology (issue #1943, design.md "The infrastructure topology"): the topology's own top-level page, in the Infra nav
// group beside Infra, which links here and holds no copy. The graph and the globe (topology.tsx) are its content. It reads
// the graph, and the plans and out-of-band changes for the Infra changes a node's details list; each read shows loading or
// its error with Try again. `#topology/<node id>` (the id URI-encoded; an Infra timeline entry links so) picks that node.
import { Network } from 'lucide-react';
import { useState } from 'react';
import { Panel } from '@/components/panel';
import { useSection } from '@/app/nav';
import { infraTimeline } from '@/model/infra-plans';
import type { PlanApply, PlanView } from '@/model/wire';
import { NotYet, useLoad } from './infra-load';
import type { OutOfBandList } from './out-of-band';
import { TopologyPanel } from './topology';
import type { TopologyGraph } from '../../../src/domain/types.ts';

/** The node a `#topology/<id>` link names, or undefined. */
const nodeOf = (section: string): string | undefined => {
  if (!section) return undefined;
  try { return decodeURIComponent(section); } catch { return undefined; }
};

export function Topology() {
  const linked = nodeOf(useSection());
  const [topology, changeTopology, reloadTopology] = useLoad<TopologyGraph>('/api/topology');
  const [plans] = useLoad<{ plans: PlanView[]; applies: PlanApply[] }>('/api/infra-plans');
  const [changes] = useLoad<OutOfBandList>('/api/out-of-band');
  const [node, setNode] = useState<string | undefined>(linked);
  // A new link picks its node, as it renders: the node a click picked stays until the hash names another.
  const [followed, setFollowed] = useState(linked);
  if (linked !== followed) { setFollowed(linked); if (linked) setNode(linked); }
  const timeline = plans.kind === 'ok' && changes.kind === 'ok' ? infraTimeline(plans.data.plans, plans.data.applies, changes.data.changes) : [];
  return (
    <div data-slot="topology-page" className="max-w-4xl space-y-3">
      {topology.kind === 'ok'
        ? <TopologyPanel g={topology.data} timeline={timeline} selected={node} onSelect={setNode} onGraph={(g) => changeTopology(() => g)} />
        : <Panel title="Topology" icon={Network}><NotYet state={topology} what="topology" retry={reloadTopology} /></Panel>}
    </div>
  );
}
