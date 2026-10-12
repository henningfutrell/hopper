// Settings → Vault, Infra changes (issue #870, design.md "Infra plans: no apply without a plan"): every plan of an
// infrastructure change the user's jobs recorded, newest first, with its state. An admin approves a plan here; until it is
// stale, the vault mints the credential an apply that names it asks, if its branch is still at the plan's commit. A job
// never approves one, and nothing here changes a plan.
import { Check, FileDiff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { get, post, RoleRefused, SessionRejected } from '@/lib/api';
import { planHeadline, planState } from '@/model/infra-plans';
import type { PlanView } from '@/model/wire';
import { useHopper } from '@/store';
import { useCanAdmin, useServerNow } from '@/store/selectors';

const TONE = { waiting: 'text-warn', approved: 'text-ok', stale: 'text-muted-foreground' } as const;

export function InfraChanges() {
  const can = useCanAdmin();
  const now = useServerNow();
  const [plans, setPlans] = useState<PlanView[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    get<{ plans: PlanView[] }>('/api/infra-plans').then((r) => { if (live) setPlans(r.plans); }, () => { if (live) setPlans([]); });
    return () => { live = false; };
  }, []);
  if (!plans || plans.length === 0) return null;
  const approve = async (id: string): Promise<void> => {
    setBusy(true);
    try {
      const { plan } = await post<{ plan: PlanView }>('/ui/api/infra-plans', { action: 'approve', plan: id });
      setPlans((all) => (all ?? []).map((p) => (p.id === id ? plan : p)));
      toast.success(`plan ${id.slice(0, 8)} approved`);
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
      toast.error(e instanceof RoleRefused ? 'Only an admin approves a plan' : (e as Error).message);
    }
    setBusy(false);
  };
  const waiting = plans.filter((p) => planState(p, now).kind === 'waiting').length;
  return (
    <Panel title="Infra changes" icon={FileDiff} count={waiting || ''} bodyClassName="space-y-3">
      <p className="text-sm text-muted-foreground">No apply without a plan. A job records the plan of each infrastructure change; the vault mints a credential that changes infrastructure only for a plan you approved, made at the commit its branch is at now, and less than an hour old.</p>
      <ul className="space-y-2">{plans.map((p) => {
        const state = planState(p, now);
        return (
          <li key={p.id} data-slot="infra-plan" className="space-y-1 rounded-md border p-3">
            <p className="text-sm break-words">{planHeadline(p)}</p>
            <p className="text-xs text-muted-foreground">plan {p.id.slice(0, 8)} by job {p.job.slice(0, 8)}{p.read ? `, made with ${p.read}` : ''}{p.file ? `, plan file ${p.file.size} bytes` : ''}</p>
            <div className="flex flex-wrap items-center gap-2">
              <span className={`text-xs ${TONE[state.kind]}`}>{state.words}</span>
              {can && state.kind === 'waiting' && <Button size="sm" disabled={busy} onClick={() => void approve(p.id)}><Check />Approve</Button>}
            </div>
          </li>
        );
      })}</ul>
    </Panel>
  );
}
