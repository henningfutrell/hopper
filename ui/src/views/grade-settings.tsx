// The grade settings (issue #2845), in Settings, an admin's: the weight of each grade signal, the revert window, the cost
// and time scales, and grade-aware routing with the graded jobs it needs. Saved to the daemon (POST /ui/api/grades/settings);
// a change of the weights, the window or a scale grades the kept grades again at the next grade pass.
import { Award } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { get, post, RoleRefused, SessionRejected } from '@/lib/api';
import { draftOf, gradeSettingsPatch, gradeSettingsSummary, SIGNAL_NAMES, SIGNALS, type GradeSettingsDraft } from '@/model/grades';
import type { GradeSettings } from '@/model/wire';
import { useHopper } from '@/store';

function Field({ label, hint, value, disabled, onChange }: { label: string; hint: string; value: string; disabled: boolean; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-wrap items-center gap-2">
      <span className="min-w-56">{label}</span>
      <Input className="h-8 w-24" inputMode="decimal" aria-label={label} disabled={disabled} value={value} onChange={(e) => onChange(e.target.value)} />
      <span className="text-xs text-muted-foreground">{hint}</span>
    </label>
  );
}

function Form({ view, onSaved }: { view: GradeSettings; onSaved: (v: GradeSettings) => void }) {
  const [draft, setDraft] = useState<GradeSettingsDraft>(() => draftOf(view));
  const [busy, setBusy] = useState(false);
  const checked = gradeSettingsPatch(view, draft);
  const save = async () => {
    if (!checked.ok || !checked.patch) return;
    setBusy(true);
    try {
      onSaved(await post<GradeSettings>('/ui/api/grades/settings', checked.patch));
      toast.success('Grade settings saved');
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
      toast.error(e instanceof RoleRefused ? 'Only an admin changes the grade settings' : (e as Error).message);
    }
    setBusy(false);
  };
  return (
    <div data-slot="grade-settings" className="space-y-3 text-sm">
      <p data-slot="grade-settings-summary" className="font-medium">{gradeSettingsSummary(view)}</p>
      <p className="text-xs text-muted-foreground">
        The automatic grade is the weighted mean of its signals, 0 to 100. A weight of 0 leaves a signal out. A change of a
        weight, the revert window or a scale grades the jobs of the last 90 days again.
      </p>
      {SIGNALS.map((g) => (
        <Field key={g} label={`Weight of ${SIGNAL_NAMES[g]}`} hint="0 to 100" value={draft.weights[g]} disabled={busy}
          onChange={(v) => setDraft({ ...draft, weights: { ...draft.weights, [g]: v } })} />
      ))}
      <Field label="Revert window" hint="days: a revert this soon after the merge lowers the grade" value={draft.revertWindowDays} disabled={busy} onChange={(revertWindowDays) => setDraft({ ...draft, revertWindowDays })} />
      <Field label="Cost scale" hint="dollars: this estimated cost gives half the cost signal" value={draft.costScaleUsd} disabled={busy} onChange={(costScaleUsd) => setDraft({ ...draft, costScaleUsd })} />
      <Field label="Time scale" hint="minutes: this wall time gives half the time signal" value={draft.timeScaleMinutes} disabled={busy} onChange={(timeScaleMinutes) => setDraft({ ...draft, timeScaleMinutes })} />
      <label className="flex flex-wrap items-center gap-2">
        <span className="min-w-56">Grade-aware routing</span>
        <Switch checked={draft.routingOn} disabled={busy} aria-label="Grade-aware routing" onCheckedChange={(routingOn) => setDraft({ ...draft, routingOn })} />
        <span className="text-xs text-muted-foreground">a routing rule that sets the executor still wins</span>
      </label>
      <Field label="Minimum graded jobs" hint="each executor needs this many on matching work" value={draft.minSamples} disabled={busy} onChange={(minSamples) => setDraft({ ...draft, minSamples })} />
      {!checked.ok && <p role="alert" className="text-xs text-destructive">{checked.error}</p>}
      <Button size="sm" disabled={busy || !checked.ok || !checked.patch} onClick={() => void save()}>Save</Button>
    </div>
  );
}

/** Read when shown; keyed by the saved values, so a save starts the form from them. */
export function GradeSettingsView() {
  const [view, setView] = useState<GradeSettings | null>(null);
  // An answer without every part is refused, never read as the defaults.
  useEffect(() => {
    get<GradeSettings>('/api/grades/settings').then((v) => {
      if (v?.weights && typeof v.revertWindowDays === 'number' && typeof v.routing?.on === 'boolean') setView(v);
    }, () => {});
  }, []);
  return (
    <Panel title="Grades" icon={Award} className="max-w-3xl">
      {view ? <Form key={JSON.stringify(view)} view={view} onSaved={setView} /> : <p className="text-sm text-muted-foreground">Loading…</p>}
    </Panel>
  );
}
