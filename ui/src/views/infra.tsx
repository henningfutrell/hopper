// Infra (issue #896, design.md "The Infra page"): plans and applies of infrastructure changes, a top-level view on par with
// Jobs. Plans (infra-plans.tsx): each plan, its state and who it waits for, approve by risk, auto-approve, and the applies
// minted against it, and the environment watchers (part 4). Infra applies (infra-applies.tsx, issue #1722): off, changes go through CI.
// Applies and drift (infra-timeline.tsx): one timeline of plans recorded and approved, applies, drift and out-of-band
// writes, newest first. Out-of-band changes (out-of-band.tsx). Topology (topology.tsx, issue #1781): the graph of the
// services in the AWS accounts and Kubernetes clusters; each timeline entry links to the nodes it touched, and a node
// lists the entries that touched it. Every panel always shows: loading, an error with Try again, or an empty list
// that says how a job fills it.
import { AlertTriangle, FileDiff, History, Network, RefreshCw, ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Empty, Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { get } from '@/lib/api';
import { infraTimeline, plansWaiting } from '@/model/infra-plans';
import type { InfraPlanSettings, InfraWatchers, PlanApply, PlanView } from '@/model/wire';
import { setPolled } from '@/store/polled';
import { useServerNow } from '@/store/selectors';
import { AutoApprove, PlanList, Watchers } from './infra-plans';
import { InfraApplies } from './infra-applies';
import { OutOfBandChanges, type OutOfBandList } from './out-of-band';
import { InfraTimeline } from './infra-timeline';
import { TopologyPanel } from './topology';
import type { TopologyGraph } from '../../../src/domain/types.ts';

type Load<T> = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ok'; data: T };
type Plans = { plans: PlanView[]; applies: PlanApply[]; settings: InfraPlanSettings; watchers: InfraWatchers };

/** One read, with its state: loading, failed (and why), or its answer; `reload` reads again. Each answer, and each change
 *  to it (an approve, a mark), is also the shared one, so the nav badge and Needs you change with the page (issue #1193). */
function useLoad<T>(path: string): [Load<T>, (f: (d: T) => T) => void, () => void] {
  const [state, setState] = useState<Load<T>>({ kind: 'loading' });
  const [round, setRound] = useState(0);
  useEffect(() => {
    let live = true;
    get<T>(path).then((data) => { if (live) setState({ kind: 'ok', data }); }, (e: Error) => { if (live) setState({ kind: 'error', message: e.message }); });
    return () => { live = false; };
  }, [path, round]);
  useEffect(() => { if (state.kind === 'ok') setPolled(path, state.data); }, [path, state]);
  const change = useCallback((f: (d: T) => T) => setState((s) => (s.kind === 'ok' ? { kind: 'ok', data: f(s.data) } : s)), []);
  return [state, change, () => { setState({ kind: 'loading' }); setRound((n) => n + 1); }];
}

/** Loading, or the error with Try again; undefined when the answer is in. */
function NotYet({ state, what, retry }: { state: Load<unknown>; what: string; retry: () => void }) {
  if (state.kind === 'loading') return <Empty>Loading {what}…</Empty>;
  if (state.kind === 'error') {
    return (
      <div data-slot="infra-error" className="flex flex-wrap items-center gap-2 rounded-md border border-bad/40 bg-bad/5 p-3 text-sm text-bad">
        <AlertTriangle className="size-4" /><span className="break-words">The {what} cannot be read: {state.message}</span>
        <Button size="sm" variant="outline" className="ml-auto" onClick={retry}><RefreshCw />Try again</Button>
      </div>
    );
  }
  return null;
}

export function Infra() {
  const now = useServerNow();
  const [plans, changePlans, reloadPlans] = useLoad<Plans>('/api/infra-plans');
  const [changes, changeChanges, reloadChanges] = useLoad<OutOfBandList>('/api/out-of-band');
  const [topology, changeTopology, reloadTopology] = useLoad<TopologyGraph>('/api/topology');
  const [node, setNode] = useState<string | undefined>();
  const pickNode = (id: string) => {
    setNode(id);
    document.querySelector('[data-slot="topology-panel"]')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  };
  const onPlan = (plan: PlanView) => changePlans((d) => ({ ...d, plans: d.plans.map((p) => (p.id === plan.id ? plan : p)) }));
  const onSettings = (settings: InfraPlanSettings) => changePlans((d) => ({ ...d, settings }));
  const onWatchers = (watchers: InfraWatchers) => changePlans((d) => ({ ...d, watchers }));
  const waiting = plansWaiting(plans.kind === 'ok' ? plans.data : undefined, now);
  const timeline = plans.kind === 'ok' && changes.kind === 'ok' ? infraTimeline(plans.data.plans, plans.data.applies, changes.data.changes) : [];
  return (
    <div className="max-w-3xl space-y-3">
      <p className="text-sm text-muted-foreground">No apply without a plan. A job records the plan of each infrastructure change; the vault mints a credential that changes infrastructure only for an approved plan, made at the commit its branch is at now, and less than an hour old. An operator approves a low-risk plan in uat only; an admin approves any other plan. A plan that adds an AWS resource without the MAP tag fails, and nobody approves it. Each plan, approval and apply is sent to the notifiers, with the watchers of its environments.</p>
      <InfraApplies />
      <Panel title="Plans" icon={FileDiff} count={waiting || ''} bodyClassName="space-y-3">
        <NotYet state={plans} what="plans" retry={reloadPlans} />
        {plans.kind === 'ok' && <AutoApprove settings={plans.data.settings} onSettings={onSettings} />}
        {plans.kind === 'ok' && <Watchers watchers={plans.data.watchers} onWatchers={onWatchers} />}
        {plans.kind === 'ok' && plans.data.plans.length === 0 && (
          <Empty>No plans yet. A job records one with POST /job/infra-plans before it applies a change: <code>terraform plan</code>, <code>helm diff</code> or an Argo CD diff. Then the plan waits here for a person to approve it.</Empty>
        )}
        {plans.kind === 'ok' && plans.data.plans.length > 0 && <PlanList plans={plans.data.plans} applies={plans.data.applies} onPlan={onPlan} />}
      </Panel>
      <Panel title="Applies and drift" icon={History} count={timeline.length || ''} list>
        {plans.kind !== 'ok' ? <NotYet state={plans} what="plans" retry={reloadPlans} />
          : changes.kind !== 'ok' ? <NotYet state={changes} what="out-of-band changes" retry={reloadChanges} />
          : <InfraTimeline timeline={timeline} g={topology.kind === 'ok' ? topology.data : undefined} onNode={pickNode} />}
      </Panel>
      {changes.kind === 'ok'
        ? <OutOfBandChanges view={changes.data} onView={changeChanges} />
        : <Panel title="Out-of-band changes" icon={ShieldAlert}><NotYet state={changes} what="out-of-band changes" retry={reloadChanges} /></Panel>}
      <div data-slot="topology-panel" className="scroll-mt-3">
        {topology.kind === 'ok'
          ? <TopologyPanel g={topology.data} timeline={timeline} selected={node} onSelect={setNode} onGraph={(g) => changeTopology(() => g)} />
          : <Panel title="Topology" icon={Network}><NotYet state={topology} what="topology" retry={reloadTopology} /></Panel>}
      </div>
    </div>
  );
}
