// Auto-park (issue #650), in Settings, an admin's: how long a question waits on a person before its job parks by itself,
// for a job that is not high priority and for a high-priority one, in minutes; 0 turns it off. Saved to the daemon and
// read on each tick, without a restart.
import { CirclePause } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { get, post, RoleRefused, SessionRejected } from '@/lib/api';
import { autoParkPatch, autoParkSummary, type AutoParkDraft } from '@/model/auto-park';
import type { AutoParkSettings } from '@/model/wire';
import { useHopper } from '@/store';

function Form({ view, onSaved }: { view: AutoParkSettings; onSaved: (v: AutoParkSettings) => void }) {
  const [draft, setDraft] = useState<AutoParkDraft>({ minutes: String(view.minutes), highPriorityMinutes: String(view.highPriorityMinutes) });
  const [busy, setBusy] = useState(false);
  const checked = autoParkPatch(view, draft);
  const save = async () => {
    if (!checked.ok || !checked.patch) return;
    setBusy(true);
    try {
      onSaved(await post<AutoParkSettings>('/ui/api/auto-park', checked.patch));
      toast.success('Auto-park saved');
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
      toast.error(e instanceof RoleRefused ? 'Only an admin changes auto-park' : (e as Error).message);
    }
    setBusy(false);
  };
  const field = (key: keyof AutoParkDraft, label: string) => (
    <label className="flex flex-wrap items-center gap-2">
      <span className="min-w-56">{label}</span>
      <Input className="h-8 w-24" inputMode="decimal" aria-label={label} disabled={busy} value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
      <span className="text-xs text-muted-foreground">minutes</span>
    </label>
  );
  return (
    <div data-slot="auto-park" className="space-y-3 text-sm">
      <p data-slot="auto-park-summary" className="font-medium">{autoParkSummary(view)}</p>
      <p className="text-xs text-muted-foreground">
        A parked job frees its machine and keeps its session, work tree and open question. The wait starts when the question reaches a person:
        time at the escalation levels does not count. Your answer puts the job back in the queue, and it goes on in the same session.
        A question that a risk rule or the consequential guard sent to you never parks its job. 0 turns auto-park off.
      </p>
      {field('minutes', 'Jobs that are not high priority')}
      {field('highPriorityMinutes', 'High-priority jobs')}
      {!checked.ok && <p role="alert" className="text-xs text-destructive">{checked.error}</p>}
      <Button size="sm" disabled={busy || !checked.ok || !checked.patch} onClick={() => void save()}>Save</Button>
    </div>
  );
}

/** Read when shown; keyed by the saved values, so a save starts the form from them. */
export function AutoPark() {
  const [view, setView] = useState<AutoParkSettings | null>(null);
  // An answer without its timeouts is refused, never read as off.
  useEffect(() => { get<AutoParkSettings>('/api/auto-park').then((v) => { if (typeof v?.minutes === 'number' && typeof v.highPriorityMinutes === 'number') setView(v); }, () => {}); }, []);
  return (
    <Panel title="Auto-park" icon={CirclePause} className="max-w-3xl">
      {view ? <Form key={JSON.stringify(view)} view={view} onSaved={setView} /> : <p className="text-sm text-muted-foreground">Loading…</p>}
    </Panel>
  );
}
