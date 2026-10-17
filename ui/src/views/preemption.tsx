// Preemption (issue #1525), in Settings, an admin's: whether a job of higher priority takes the lane of a running job of
// lower priority, and how long a job runs before it may be preempted, in minutes. Saved to the daemon and read on each
// Decision, without a restart.
import { ArrowUpFromLine } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { get, post, RoleRefused, SessionRejected } from '@/lib/api';
import { preemptionPatch, preemptionSummary, type PreemptionDraft } from '@/model/preemption';
import type { PreemptionSettings } from '@/model/wire';
import { useHopper } from '@/store';

function Form({ view, onSaved }: { view: PreemptionSettings; onSaved: (v: PreemptionSettings) => void }) {
  const [draft, setDraft] = useState<PreemptionDraft>({ enabled: view.enabled, minRunMinutes: String(view.minRunMinutes) });
  const [busy, setBusy] = useState(false);
  const checked = preemptionPatch(view, draft);
  const save = async () => {
    if (!checked.ok || !checked.patch) return;
    setBusy(true);
    try {
      onSaved(await post<PreemptionSettings>('/ui/api/preemption', checked.patch));
      toast.success('Preemption saved');
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
      toast.error(e instanceof RoleRefused ? 'Only an admin changes preemption' : (e as Error).message);
    }
    setBusy(false);
  };
  return (
    <div data-slot="preemption" className="space-y-3 text-sm">
      <p data-slot="preemption-summary" className="font-medium">{preemptionSummary(view)}</p>
      <p className="text-xs text-muted-foreground">
        When a job of higher priority waits and every lane it may use is busy, the hopper parks the running job of lowest priority
        (of those, the one that started last) and gives its lane to the waiting job. The parked job keeps its work tree and session.
        It goes back in the queue ahead of the other jobs of its priority, and resumes from where it stopped. Only a strictly higher
        priority preempts. A job is never preempted before it has run for the minimum run time.
      </p>
      <label className="flex flex-wrap items-center gap-2">
        <span className="min-w-56">Preempt lower-priority jobs</span>
        <Switch checked={draft.enabled} disabled={busy} aria-label="Preempt lower-priority jobs" onCheckedChange={(on) => setDraft({ ...draft, enabled: on })} />
      </label>
      <label className="flex flex-wrap items-center gap-2">
        <span className="min-w-56">Minimum run time</span>
        <Input className="h-8 w-24" inputMode="decimal" aria-label="Minimum run time" disabled={busy} value={draft.minRunMinutes} onChange={(e) => setDraft({ ...draft, minRunMinutes: e.target.value })} />
        <span className="text-xs text-muted-foreground">minutes</span>
      </label>
      {!checked.ok && <p role="alert" className="text-xs text-destructive">{checked.error}</p>}
      <Button size="sm" disabled={busy || !checked.ok || !checked.patch} onClick={() => void save()}>Save</Button>
    </div>
  );
}

/** Read when shown; keyed by the saved values, so a save starts the form from them. */
export function Preemption() {
  const [view, setView] = useState<PreemptionSettings | null>(null);
  // An answer without both parts is refused, never read as off.
  useEffect(() => { get<PreemptionSettings>('/api/preemption').then((v) => { if (typeof v?.enabled === 'boolean' && typeof v.minRunMinutes === 'number') setView(v); }, () => {}); }, []);
  return (
    <Panel title="Preemption" icon={ArrowUpFromLine} className="max-w-3xl">
      {view ? <Form key={JSON.stringify(view)} view={view} onSaved={setView} /> : <p className="text-sm text-muted-foreground">Loading…</p>}
    </Panel>
  );
}
