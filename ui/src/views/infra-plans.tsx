// Infra → Plans (issues #870, #896, design.md "Infra plans: no apply without a plan"): every plan of an infrastructure
// change the user's jobs recorded, newest first, with its state and who it waits for, its summary in plain words, its
// risk callouts, blast radius and checks, the applies minted against it, and the raw plan on demand. A person approves a
// plan here, by its risk: an operator a low-risk plan in uat only, an admin any other, after a confirmation when it is
// high risk. Until it is stale, the vault mints the credential an apply that names it asks, if its branch is still at the
// plan's commit. An admin turns auto-approve on: the hopper then approves a low-risk uat plan when it is kept, and it is
// still shown here. A job never approves one, and nothing here changes a plan. The page loads the plans (infra.tsx).
import { Check } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Confirm } from '@/components/confirm';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { get, post, RoleRefused, SessionRejected } from '@/lib/api';
import { applyLine, askedLine, planApprove, planExplainer, planHeadline, planState } from '@/model/infra-plans';
import type { InfraPlan, InfraPlanSettings, PlanApply, PlanView } from '@/model/wire';
import { useHopper } from '@/store';
import { useCanAdmin, useCanOperate, useServerNow } from '@/store/selectors';

const TONE = { waiting: 'text-warn', approved: 'text-ok', stale: 'text-muted-foreground', failed: 'text-destructive' } as const;
const LEVEL = { low: 'text-ok', high: 'text-warn' } as const;

function refused(e: unknown, role: string): void {
  if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
  toast.error(e instanceof RoleRefused ? `Only ${role} does this` : (e as Error).message);
}

/** The raw plan (the `terraform show` text, the diff), read when the person opens it. */
function RawPlan({ id }: { id: string }) {
  const [text, setText] = useState<string | null>(null);
  const load = (open: boolean): void => {
    if (!open || text !== null) return;
    get<{ plan: InfraPlan }>(`/api/infra-plans/${id}`).then((r) => setText(r.plan.text), (e: Error) => setText(`The plan cannot be read: ${e.message}`));
  };
  return (
    <details className="text-xs" onToggle={(e) => load(e.currentTarget.open)}>
      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Show the plan</summary>
      <pre className="mt-1 max-h-96 overflow-auto rounded bg-muted p-2 whitespace-pre-wrap break-words">{text ?? 'Loading…'}</pre>
    </details>
  );
}

/** The auto-approve switch: an admin turns it on or off; `onSettings` takes the settings the change answered. */
export function AutoApprove({ settings, onSettings }: { settings: InfraPlanSettings; onSettings: (s: InfraPlanSettings) => void }) {
  const admin = useCanAdmin();
  const [busy, setBusy] = useState(false);
  const change = async (on: boolean): Promise<void> => {
    setBusy(true);
    try {
      onSettings((await post<{ settings: InfraPlanSettings }>('/ui/api/infra-plans/settings', { autoApprove: on })).settings);
      toast.success(on ? 'Auto-approve on' : 'Auto-approve off');
    } catch (e) {
      refused(e, 'an admin');
    }
    setBusy(false);
  };
  return (
    <label className="flex items-center gap-2 text-sm">
      <Switch checked={settings.autoApprove} disabled={busy || !admin} aria-label="Auto-approve low-risk uat plans" onCheckedChange={(on) => void change(on)} />
      The hopper approves a low-risk plan in uat only when a job records it. It still shows here.
    </label>
  );
}

/** The plans, each with its applies; `onPlan` takes a plan an approval changed. */
export function PlanList({ plans, applies, onPlan }: { plans: PlanView[]; applies: PlanApply[]; onPlan: (p: PlanView) => void }) {
  const can = { operate: useCanOperate(), admin: useCanAdmin() };
  const now = useServerNow();
  const [busy, setBusy] = useState(false);
  const approve = async (id: string): Promise<void> => {
    setBusy(true);
    try {
      const { plan } = await post<{ plan: PlanView }>('/ui/api/infra-plans', { action: 'approve', plan: id });
      onPlan(plan);
      toast.success(`plan ${id.slice(0, 8)} approved`);
    } catch (e) {
      refused(e, 'an operator or an admin');
    }
    setBusy(false);
  };
  return (
    <ul className="space-y-2">{plans.map((p) => {
      const state = planState(p, now);
      const why = planExplainer(p);
      const offer = planApprove(p, now, can);
      const button = <Button size="sm" disabled={busy} onClick={offer.confirm ? undefined : () => void approve(p.id)}><Check />Approve</Button>;
      const mine = applies.filter((a) => a.plan === p.id);
      return (
        <li key={p.id} data-slot="infra-plan" className="space-y-1 rounded-md border p-3">
          {why && <p className="text-sm font-medium break-words">{why.words} <span className={`text-xs font-normal ${LEVEL[why.level]}`}>{why.level} risk</span></p>}
          <p className="text-sm break-words">{planHeadline(p)}</p>
          {why && <ul className="list-disc pl-5 text-xs text-muted-foreground">{why.lines.map((l) => <li key={l} className={l.startsWith('Failed:') ? 'text-destructive' : ''}>{l}</li>)}</ul>}
          <p className="text-xs text-muted-foreground">plan {p.id.slice(0, 8)} by job {p.job.slice(0, 8)}{p.read ? `, made with ${p.read}` : ''}{p.file ? `, plan file ${p.file.size} bytes` : ''}</p>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`text-xs ${TONE[state.kind]}`}>{state.words}</span>
            {offer.show && (offer.confirm
              ? <Confirm title="Approve this high-risk plan?" action="Approve" description={offer.confirm} onConfirm={() => void approve(p.id)}>{button}</Confirm>
              : button)}
          </div>
          {p.asked && state.kind === 'waiting' && <p data-slot="infra-plan-asked" className="text-xs text-warn break-words">{askedLine(p.asked)}</p>}
          {mine.length > 0 && (
            <ul data-slot="infra-plan-applies" className="space-y-0.5 text-xs">
              {mine.map((a) => <li key={`${a.at} ${a.job}`} className="break-words">Applied {a.at}: {applyLine(a)}</li>)}
            </ul>
          )}
          <RawPlan id={p.id} />
        </li>
      );
    })}</ul>
  );
}
