// The infrastructure topology (issue #1781, design.md "The infrastructure topology"): one user's graph of the services in
// the AWS accounts and Kubernetes clusters their read-only checks reach, and what is linked to what. A check reports one
// or more topology sources, each as a whole: what it found, or why it could not read it. Each source keeps its last good
// snapshot, so a source out of reach leaves the rest of the graph as it was. Read-only: nothing here acts on a cloud or
// a cluster. Each report is `infra.topology_reported`, with the counts and never the nodes.
import { afterReport, cleanReport, joinGraph, sourceKey, sourceReportProblem, SOURCES_MAX, type SourceReport, type SourceView, type TopologyGraph } from '../domain/topology.ts';
import type { Clock, UserStore } from '../domain/ports.ts';
import type { PlanRefusal } from './service.ts';

export interface Topology {
  /** Keep each source's report; refused whole (400, saying which and why) when one is not whole or one source is named twice. */
  report(reporter: string, sources: SourceReport[]): { sources: SourceView[] } | PlanRefusal;
  graph(): TopologyGraph;
}

export function createTopology(o: { store: Pick<UserStore, 'topology' | 'events' | 'tx'>; clock: Clock }): Topology {
  const repo = o.store.topology;
  return {
    report(reporter, said) {
      if (said.length === 0 || said.length > SOURCES_MAX) return { status: 400, no: `a report holds 1 to ${SOURCES_MAX} sources` };
      for (const [i, s] of said.entries()) {
        const problem = sourceReportProblem(s);
        if (problem) return { status: 400, no: `source ${i + 1}: ${problem}` };
      }
      const reports = said.map(cleanReport);
      const keys = reports.map((r) => sourceKey(r.source));
      const twice = keys.find((k, i) => keys.indexOf(k) !== i);
      if (twice) return { status: 400, no: `source ${twice} is in the report twice` };
      const at = o.clock.now().toISOString();
      const kept = o.store.tx(() => {
        const out = reports.map((r, i) => {
          const s = afterReport(repo.get(keys[i]!), r, reporter, at);
          repo.put(s);
          return s;
        });
        o.store.events.append({
          type: 'infra.topology_reported',
          data: {
            reporter, sources: out.map((s) => ({
              key: s.key, ok: s.lastRead.ok, ...(s.lastRead.error ? { error: s.lastRead.error } : {}),
              ...(s.lastRead.ok && s.lastGood ? { nodes: s.lastGood.nodes.length, links: s.lastGood.links.length } : {}),
            })),
          },
        });
        return out;
      });
      return { sources: joinGraph(kept).sources };
    },
    graph: () => joinGraph(repo.list()),
  };
}
