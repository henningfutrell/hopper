// A job's token use on its job view (issue #2302, the token ledger): GET /api/jobs/:id/tokens, read again as the job's
// state changes — its totals and estimated cost, then one row per model, then its waste signals (part 4). Counts only, as the
// daemon keeps them. Above them, the model routing chose for it, why, and its budget against its spend (issue #2848); a
// person's job budget against its spend, and, while the job has not ended, a form to set it (part 2, an operator's).
import { Coins } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Empty, Panel } from '@/components/panel';
import { get } from '@/lib/api';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { post, RoleRefused, SessionRejected } from '@/lib/api';
import { jobBudgetLine, jobBudgetPatch, type JobBudgetDraft } from '@/model/model-routing';
import { modelRouteLines, tokenLine, usd, WASTE_NAMES } from '@/model/token-ledger';
import type { Job, JobTokenView } from '@/model/wire';
import { useHopper } from '@/store';

const ENDED = ['finished', 'failed', 'cancelled', 'rejected'];

/** A person's job budget on this job: either cap, 0 takes it off. The job view reads the job again after a save. */
function JobBudgetForm({ job }: { job: Job }) {
  const own = job.jobBudget;
  const [draft, setDraft] = useState<JobBudgetDraft>({ jobTokens: String(own?.jobTokens ?? 0), jobCostUsd: String(own?.jobCostUsd ?? 0) });
  const [busy, setBusy] = useState(false);
  const checked = jobBudgetPatch(own, draft);
  const save = async () => {
    if (!checked.ok || !checked.patch) return;
    setBusy(true);
    try {
      await post<Job>(`/ui/api/jobs/${encodeURIComponent(job.id)}/budget`, checked.patch);
      toast.success('Job budget set');
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
      toast.error(e instanceof RoleRefused ? 'Only an operator sets a job budget' : (e as Error).message);
    }
    setBusy(false);
  };
  const field = (key: keyof JobBudgetDraft, label: string) => (
    <Input className="h-7 w-28" inputMode="decimal" aria-label={label} placeholder={label} disabled={busy} value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
  );
  return (
    <div data-slot="job-budget-form" className="flex flex-wrap items-center gap-2 pb-1 text-xs">
      <span className="text-muted-foreground">Job budget (0: off)</span>
      {field('jobTokens', 'Tokens')}
      {field('jobCostUsd', 'US dollars')}
      <Button size="sm" variant="outline" disabled={busy || !checked.ok || !checked.patch} onClick={() => void save()}>Set</Button>
      {!checked.ok && <span role="alert" className="text-destructive">{checked.error}</span>}
    </div>
  );
}

export function JobTokens({ job }: { job: Job }) {
  const [view, setView] = useState<JobTokenView | null>(null);
  useEffect(() => {
    let gone = false;
    get<JobTokenView>(`/api/jobs/${encodeURIComponent(job.id)}/tokens`).then((v) => { if (!gone) setView(v); }, () => { if (!gone) setView(null); });
    return () => { gone = true; };
  }, [job.id, job.status]);
  if (!view) return null;
  const spent = view.sessions > 0 ? view.total : undefined;
  const route = job.spec.modelRoute ? modelRouteLines(job.spec.modelRoute, spent) : undefined;
  const own = jobBudgetLine(job.jobBudget, spent);
  return (
    <Panel title="Tokens" icon={Coins} bodyClassName="space-y-1 p-3 text-sm">
      {route && (
        <div className="space-y-0.5 pb-1">
          <div data-slot="job-model-route" className="font-medium">{route.route}</div>
          <div data-slot="job-model-why" className="text-xs text-muted-foreground">{route.why}</div>
          <div data-slot="job-model-budget" className="text-xs text-muted-foreground">{route.budget}</div>
        </div>
      )}
      {own && <div data-slot="job-own-budget" className="text-xs text-muted-foreground">{own}</div>}
      {!ENDED.includes(job.status) && <JobBudgetForm key={JSON.stringify(job.jobBudget ?? null)} job={job} />}
      {view.sessions === 0 ? <Empty><span data-slot="job-tokens-none">No token use read: its agent session was not read yet, or its executor keeps none.</span></Empty> : (
        <>
          <div data-slot="job-tokens-total"><span className="font-medium">{usd(view.total)}</span> estimated · {tokenLine(view.total)}</div>
          {view.models.map((m) => (
            <div key={m.model} data-slot="job-tokens-model" className="text-xs text-muted-foreground"><span className="font-mono">{m.model}</span>: {usd(m)} · {tokenLine(m)}</div>
          ))}
          {(view.waste ?? []).map((w) => (
            <div key={w.kind} data-slot="job-tokens-waste" className="text-xs text-warn"><span className="font-medium">{WASTE_NAMES[w.kind]}</span>: {w.why}</div>
          ))}
        </>
      )}
    </Panel>
  );
}
