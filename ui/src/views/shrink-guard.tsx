// Shrink guard (issue #1096), in Settings, an admin's: the percent of a file's lines a job's push that brings in its base
// branch may take before the hopper refuses it. Saved to the daemon and read at each push, without a restart.
import { FileWarning, Info } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { get, post, RoleRefused, SessionRejected } from '@/lib/api';
import { percentDraft, SHRINK_GUARD_NOTE, shrinkGuardSummary } from '@/model/shrink-guard';
import type { ShrinkGuardSettings } from '@/model/wire';
import { useHopper } from '@/store';

function Form({ view, onSaved }: { view: ShrinkGuardSettings; onSaved: (v: ShrinkGuardSettings) => void }) {
  const [draft, setDraft] = useState(String(view.percent));
  const [busy, setBusy] = useState(false);
  const checked = percentDraft(view.percent, draft);
  const save = async () => {
    if (!checked.ok || checked.percent === undefined) return;
    setBusy(true);
    try {
      onSaved(await post<ShrinkGuardSettings>('/ui/api/shrink-guard', { percent: checked.percent }));
      toast.success('Shrink guard saved');
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
      toast.error(e instanceof RoleRefused ? 'Only an admin changes the shrink guard' : (e as Error).message);
    }
    setBusy(false);
  };
  return (
    <div data-slot="shrink-guard" className="space-y-3 text-sm">
      <p role="note" className="flex gap-2 rounded-md border p-3 text-xs text-muted-foreground"><Info className="size-4 shrink-0" />{SHRINK_GUARD_NOTE}</p>
      <p data-slot="shrink-guard-summary" className="font-medium">{shrinkGuardSummary(view)}</p>
      <label className="flex flex-wrap items-center gap-2">
        <span className="min-w-32">Largest shrink</span>
        <Input className="h-8 w-24" inputMode="numeric" aria-label="Largest shrink" disabled={busy} value={draft} onChange={(e) => setDraft(e.target.value)} />
        <span className="text-xs text-muted-foreground">% of a file's lines</span>
      </label>
      {!checked.ok && <p role="alert" className="text-xs text-destructive">{checked.error}</p>}
      <Button size="sm" disabled={busy || !checked.ok || checked.percent === undefined} onClick={() => void save()}>Save</Button>
    </div>
  );
}

/** Read when shown; an answer without `percent` is refused, never read as the default. Keyed by the saved percent. */
export function ShrinkGuard() {
  const [view, setView] = useState<ShrinkGuardSettings | null>(null);
  useEffect(() => { get<ShrinkGuardSettings>('/api/shrink-guard').then((v) => { if (typeof v?.percent === 'number') setView(v); }, () => {}); }, []);
  return (
    <Panel title="Shrink guard" icon={FileWarning} className="max-w-3xl">
      {view ? <Form key={view.percent} view={view} onSaved={setView} /> : <p className="text-sm text-muted-foreground">Loading…</p>}
    </Panel>
  );
}
