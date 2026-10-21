// The token budget (issue #2302, part 3), in Settings, an admin's: the most one job may spend, in tokens or in estimated
// cost, before it is paused; 0 turns that cap off. Saved to the daemon (POST /ui/api/token-budget) and read at each
// checkpoint, without a restart. A paused job is parked, and Needs you lists it under Budgets.
import { Coins } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { get, post, RoleRefused, SessionRejected } from '@/lib/api';
import { tokenBudgetPatch, tokenBudgetSummary, type TokenBudgetDraft } from '@/model/token-ledger';
import type { TokenBudgetSettings } from '@/model/wire';
import { useHopper } from '@/store';

function Form({ view, onSaved }: { view: TokenBudgetSettings; onSaved: (v: TokenBudgetSettings) => void }) {
  const [draft, setDraft] = useState<TokenBudgetDraft>({ jobTokens: String(view.jobTokens), jobCostUsd: String(view.jobCostUsd) });
  const [busy, setBusy] = useState(false);
  const checked = tokenBudgetPatch(view, draft);
  const save = async () => {
    if (!checked.ok || !checked.patch) return;
    setBusy(true);
    try {
      onSaved(await post<TokenBudgetSettings>('/ui/api/token-budget', checked.patch));
      toast.success('Token budget saved');
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
      toast.error(e instanceof RoleRefused ? 'Only an admin changes the token budget' : (e as Error).message);
    }
    setBusy(false);
  };
  const field = (key: keyof TokenBudgetDraft, label: string, unit: string) => (
    <label className="flex flex-wrap items-center gap-2">
      <span className="min-w-56">{label}</span>
      <Input className="h-8 w-32" inputMode="decimal" aria-label={label} disabled={busy} value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
      <span className="text-xs text-muted-foreground">{unit}</span>
    </label>
  );
  return (
    <div data-slot="token-budget" className="space-y-3 text-sm">
      <p data-slot="token-budget-summary" className="font-medium">{tokenBudgetSummary(view)}</p>
      <p className="text-xs text-muted-foreground">
        The hopper reads what each job spends from its agent session at each checkpoint. A job that reaches a cap is parked: it frees its machine
        and keeps its session and work tree. It is not stopped. Needs you lists it under Budgets. Pick it up to let it go on: it then gets a whole
        budget again, counted from what it had spent. Tokens count input, output, cache read and cache write. 0 turns a cap off.
      </p>
      {field('jobTokens', 'Tokens per job', 'tokens')}
      {field('jobCostUsd', 'Estimated cost per job', 'US dollars')}
      {!checked.ok && <p role="alert" className="text-xs text-destructive">{checked.error}</p>}
      <Button size="sm" disabled={busy || !checked.ok || !checked.patch} onClick={() => void save()}>Save</Button>
    </div>
  );
}

/** Read when shown; keyed by the saved values, so a save starts the form from them. */
export function TokenBudget() {
  const [view, setView] = useState<TokenBudgetSettings | null>(null);
  useEffect(() => { get<TokenBudgetSettings>('/api/token-budget').then((v) => { if (typeof v?.jobTokens === 'number' && typeof v.jobCostUsd === 'number') setView(v); }, () => {}); }, []);
  return (
    <Panel title="Token budget" icon={Coins} className="max-w-3xl">
      {view ? <Form key={JSON.stringify(view)} view={view} onSaved={setView} /> : <p className="text-sm text-muted-foreground">Loading…</p>}
    </Panel>
  );
}
