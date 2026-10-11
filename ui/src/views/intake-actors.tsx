// Settings → Intake (issue #652), an admin's: the trusted actors — the GitHub logins whose issues, labels and
// assignments start the user's jobs. None named: the connected login only. Any other issue is a request card in Sources.
import { UserCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { get, post, RoleRefused, SessionRejected } from '@/lib/api';
import { actorsOf } from '@/model/intake-actors';
import { useHopper } from '@/store';

interface View { actors: string[] }

function Form({ view, onSaved }: { view: View; onSaved: (v: View) => void }) {
  const [text, setText] = useState(view.actors.join('\n'));
  const [busy, setBusy] = useState(false);
  const actors = actorsOf(text);
  const changed = JSON.stringify(actors) !== JSON.stringify(view.actors);
  const save = async () => {
    setBusy(true);
    try {
      onSaved(await post<View>('/ui/api/intake-actors', { actors }));
      toast.success('Trusted actors saved');
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
      toast.error(e instanceof RoleRefused ? 'Only an admin changes the trusted actors' : (e as Error).message);
    }
    setBusy(false);
  };
  return (
    <div data-slot="intake-actors" className="space-y-3 text-sm">
      <p className="text-xs text-muted-foreground">
        An issue becomes a job only when a trusted actor wrote it, added its label and assigned it to you. Apps and bots never are.
        Any other issue shows in Sources as a request: you read it and approve it.
      </p>
      <p data-slot="intake-actors-summary" className="font-medium">
        {view.actors.length === 0 ? 'Trusted now: your connected GitHub login only' : `Trusted now: ${view.actors.join(', ')}`}
      </p>
      <label className="grid gap-1">
        <span className="text-xs text-muted-foreground">GitHub logins, one per line (empty: your connected login only)</span>
        <textarea aria-label="Trusted actors" className="min-h-24 rounded-md border bg-background p-2 font-mono text-xs" value={text} disabled={busy} onChange={(e) => setText(e.target.value)} />
      </label>
      <Button size="sm" disabled={busy || !changed} onClick={() => void save()}>Save</Button>
    </div>
  );
}

/** Read when shown; keyed by the saved list, so a save starts the form from it. */
export function IntakeActors() {
  const [view, setView] = useState<View | null>(null);
  useEffect(() => { get<View>('/api/intake-actors').then((v) => { if (Array.isArray(v?.actors)) setView(v); }, () => {}); }, []);
  return (
    <Panel title="Intake: trusted actors" icon={UserCheck} className="max-w-3xl">
      {view ? <Form key={view.actors.join(',')} view={view} onSaved={setView} /> : <p className="text-sm text-muted-foreground">Loading…</p>}
    </Panel>
  );
}
