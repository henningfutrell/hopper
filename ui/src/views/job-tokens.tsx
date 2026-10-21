// A job's token use on its job view (issue #2302, the token ledger): GET /api/jobs/:id/tokens, read again as the job's
// state changes — its totals and estimated cost, then one row per model, then its waste signals (part 4). Counts only, as the
// daemon keeps them.
import { Coins } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Empty, Panel } from '@/components/panel';
import { get } from '@/lib/api';
import { tokenLine, usd, WASTE_NAMES } from '@/model/token-ledger';
import type { Job, JobTokenView } from '@/model/wire';

export function JobTokens({ job }: { job: Job }) {
  const [view, setView] = useState<JobTokenView | null>(null);
  useEffect(() => {
    let gone = false;
    get<JobTokenView>(`/api/jobs/${encodeURIComponent(job.id)}/tokens`).then((v) => { if (!gone) setView(v); }, () => { if (!gone) setView(null); });
    return () => { gone = true; };
  }, [job.id, job.status]);
  if (!view) return null;
  return (
    <Panel title="Tokens" icon={Coins} bodyClassName="space-y-1 p-3 text-sm">
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
