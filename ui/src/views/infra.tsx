// Infra (issue #896, design.md "The Infra page"): plans and applies of infrastructure changes, a top-level view on par with
// Jobs. Plans (infra-plans.tsx): each plan, its state and who it waits for, approve, and the applies minted against it.
// Applies and drift: one timeline of plans recorded and approved, applies, drift and out-of-band writes, newest first.
// Out-of-band changes (out-of-band.tsx). Every panel always shows: loading, an error with Try again, or an empty list
// that says how a job fills it.
import { AlertTriangle, FileDiff, History, RefreshCw, ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Empty, Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { get } from '@/lib/api';
import { infraTimeline, planState } from '@/model/infra-plans';
import type { PlanApply, PlanView } from '@/model/wire';
import { useServerNow } from '@/store/selectors';
import { PlanList } from './infra-plans';
import { OutOfBandChanges, type OutOfBandList } from './out-of-band';

type Load<T> = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ok'; data: T };
type Plans = { plans: PlanView[]; applies: PlanApply[] };

/** One read, with its state: loading, failed (and why), or its answer; `reload` reads again. */
function useLoad<T>(path: string): [Load<T>, (f: (d: T) => T) => void, () => void] {
  const [state, setState] = useState<Load<T>>({ kind: 'loading' });
  const [round, setRound] = useState(0);
  useEffect(() => {
    let live = true;
    get<T>(path).then((data) => { if (live) setState({ kind: 'ok', data }); }, (e: Error) => { if (live) setState({ kind: 'error', message: e.message }); });
    return () => { live = false; };
  }, [path, round]);
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

const KIND = { plan: 'Plan', approved: 'Approved', apply: 'Apply', drift: 'Drift', 'out-of-band': 'Out of band', marked: 'Marked' } as const;
const KIND_TONE = { plan: 'text-muted-foreground', approved: 'text-ok', apply: 'text-ok', drift: 'text-warn', 'out-of-band': 'text-warn', marked: 'text-muted-foreground' } as const;

export function Infra() {
  const now = useServerNow();
  const [plans, changePlans, reloadPlans] = useLoad<Plans>('/api/infra-plans');
  const [changes, changeChanges, reloadChanges] = useLoad<OutOfBandList>('/api/out-of-band');
  const onPlan = (plan: PlanView) => changePlans((d) => ({ ...d, plans: d.plans.map((p) => (p.id === plan.id ? plan : p)) }));
  const waiting = plans.kind === 'ok' ? plans.data.plans.filter((p) => planState(p, now).kind === 'waiting').length : 0;
  const timeline = plans.kind === 'ok' && changes.kind === 'ok' ? infraTimeline(plans.data.plans, plans.data.applies, changes.data.changes) : [];
  return (
    <div className="max-w-3xl space-y-3">
      <p className="text-sm text-muted-foreground">No apply without a plan. A job records the plan of each infrastructure change; the vault mints a credential that changes infrastructure only for a plan an admin approved, made at the commit its branch is at now, and less than an hour old. A plan that adds an AWS resource without the MAP tag fails, and nobody approves it.</p>
      <Panel title="Plans" icon={FileDiff} count={waiting || ''} bodyClassName="space-y-3">
        <NotYet state={plans} what="plans" retry={reloadPlans} />
        {plans.kind === 'ok' && plans.data.plans.length === 0 && (
          <Empty>No plans yet. A job records one with POST /job/infra-plans before it applies a change: <code>terraform plan</code>, <code>helm diff</code> or an Argo CD diff. Then the plan waits here for an admin.</Empty>
        )}
        {plans.kind === 'ok' && plans.data.plans.length > 0 && <PlanList plans={plans.data.plans} applies={plans.data.applies} onPlan={onPlan} />}
      </Panel>
      <Panel title="Applies and drift" icon={History} count={timeline.length || ''} list>
        {plans.kind !== 'ok' ? <NotYet state={plans} what="plans" retry={reloadPlans} />
          : changes.kind !== 'ok' ? <NotYet state={changes} what="out-of-band changes" retry={reloadChanges} />
          : timeline.length === 0 ? <Empty>Nothing yet. Each plan, approval, apply and out-of-band change shows here, newest first.</Empty>
          : (
            <ul data-slot="infra-timeline" className="space-y-1.5 text-sm">
              {timeline.map((e, i) => (
                <li key={`${e.at} ${e.kind} ${i}`} className="flex gap-2">
                  <span className={`w-24 shrink-0 text-xs ${KIND_TONE[e.kind]}`}>{KIND[e.kind]}</span>
                  <span className="min-w-0 flex-1 break-words">{e.words}</span>
                  <time className="num shrink-0 text-xs text-muted-foreground" dateTime={e.at}>{e.at}</time>
                </li>
              ))}
            </ul>
          )}
      </Panel>
      {changes.kind === 'ok'
        ? <OutOfBandChanges view={changes.data} onView={changeChanges} />
        : <Panel title="Out-of-band changes" icon={ShieldAlert}><NotYet state={changes} what="out-of-band changes" retry={reloadChanges} /></Panel>}
    </div>
  );
}
