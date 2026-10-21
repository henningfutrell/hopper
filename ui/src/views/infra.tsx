// Infra (issue #896, design.md "The Infra page"): plans and applies of infrastructure changes, a top-level view on par with
// Jobs. Plans (infra-plans.tsx): each plan, its state and who it waits for, approve by risk, auto-approve, and the applies
// minted against it, and the environment watchers (part 4). Infra applies (infra-applies.tsx, issue #1722): off, changes go through CI.
// Applies and drift (infra-timeline.tsx): one timeline of plans recorded and approved, applies, drift and out-of-band
// writes, newest first. Out-of-band changes (out-of-band.tsx). The topology has its own page (topology-page.tsx, issue
// #1943): a line here links to it, and each timeline entry links to the nodes it touched there; the page reads the graph
// only to name those nodes. Every panel always shows: loading, an error with Try again, or an empty list that says how a
// job fills it. `#infra/<plan id>` (issue #2205: a job's wait on a plan links so) picks that plan, or says it is not recorded.
import { FileDiff, History, ShieldAlert } from 'lucide-react';
import { Empty, Panel } from '@/components/panel';
import { useSection } from '@/app/nav';
import { infraTimeline, plansWaiting } from '@/model/infra-plans';
import type { InfraPlanSettings, InfraWatchers, PlanApply, PlanView } from '@/model/wire';
import { useServerNow } from '@/store/selectors';
import { AutoApprove, PlanList, Watchers } from './infra-plans';
import { InfraApplies } from './infra-applies';
import { OutOfBandChanges, type OutOfBandList } from './out-of-band';
import { InfraTimeline } from './infra-timeline';
import { NotYet, useLoad } from './infra-load';
import type { TopologyGraph } from '../../../src/domain/types.ts';

type Plans = { plans: PlanView[]; applies: PlanApply[]; settings: InfraPlanSettings; watchers: InfraWatchers };

export function Infra() {
  const now = useServerNow();
  const picked = useSection() || undefined;
  const [plans, changePlans, reloadPlans] = useLoad<Plans>('/api/infra-plans');
  const [changes, changeChanges, reloadChanges] = useLoad<OutOfBandList>('/api/out-of-band');
  const [topology] = useLoad<TopologyGraph>('/api/topology');
  const pickNode = (id: string) => { window.location.hash = `#topology/${encodeURIComponent(id)}`; };
  const onPlan = (plan: PlanView) => changePlans((d) => ({ ...d, plans: d.plans.map((p) => (p.id === plan.id ? plan : p)) }));
  const onSettings = (settings: InfraPlanSettings) => changePlans((d) => ({ ...d, settings }));
  const onWatchers = (watchers: InfraWatchers) => changePlans((d) => ({ ...d, watchers }));
  const waiting = plansWaiting(plans.kind === 'ok' ? plans.data : undefined, now);
  const timeline = plans.kind === 'ok' && changes.kind === 'ok' ? infraTimeline(plans.data.plans, plans.data.applies, changes.data.changes) : [];
  return (
    <div className="max-w-3xl space-y-3">
      <p className="text-sm text-muted-foreground">No apply without a plan. A job records the plan of each infrastructure change; the vault mints a credential that changes infrastructure only for an approved plan, made at the commit its branch is at now, and less than an hour old. An operator approves a low-risk plan in uat only; an admin approves any other plan. A plan that adds an AWS resource without the MAP tag fails, and nobody approves it. Each plan, approval and apply is sent to the notifiers, with the watchers of its environments.</p>
      <p data-slot="infra-topology-link" className="text-sm text-muted-foreground">The services in your AWS accounts and Kubernetes clusters, and what is linked to what, are on <a href="#topology" className="underline">Topology</a>.</p>
      <InfraApplies />
      <Panel title="Plans" icon={FileDiff} count={waiting || ''} bodyClassName="space-y-3">
        <NotYet state={plans} what="plans" retry={reloadPlans} />
        {plans.kind === 'ok' && <AutoApprove settings={plans.data.settings} onSettings={onSettings} />}
        {plans.kind === 'ok' && <Watchers watchers={plans.data.watchers} onWatchers={onWatchers} />}
        {plans.kind === 'ok' && plans.data.plans.length === 0 && (
          <Empty>No plans yet. A job records one with POST /job/infra-plans before it applies a change: <code>terraform plan</code>, <code>helm diff</code> or an Argo CD diff. Then the plan waits here for a person to approve it.</Empty>
        )}
        {plans.kind === 'ok' && picked && !plans.data.plans.some((p) => p.id === picked) && (
          <p data-slot="infra-plan-missing" className="text-sm text-destructive">No plan {picked} is recorded on this hopper, so there is nothing to approve. The job that waits on it is told so; it records the plan with POST /job/infra-plans.</p>
        )}
        {plans.kind === 'ok' && plans.data.plans.length > 0 && <PlanList plans={plans.data.plans} applies={plans.data.applies} onPlan={onPlan} picked={picked} />}
      </Panel>
      <Panel title="Applies and drift" icon={History} count={timeline.length || ''}>
        {plans.kind !== 'ok' ? <NotYet state={plans} what="plans" retry={reloadPlans} />
          : changes.kind !== 'ok' ? <NotYet state={changes} what="out-of-band changes" retry={reloadChanges} />
          : <InfraTimeline timeline={timeline} g={topology.kind === 'ok' ? topology.data : undefined} onNode={pickNode} />}
      </Panel>
      {changes.kind === 'ok'
        ? <OutOfBandChanges view={changes.data} onView={changeChanges} />
        : <Panel title="Out-of-band changes" icon={ShieldAlert}><NotYet state={changes} what="out-of-band changes" retry={reloadChanges} /></Panel>}
    </div>
  );
}
