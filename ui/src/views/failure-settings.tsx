// The failures settings (issue #509), an admin's: the retry limit and backoff, the grouping threshold, which
// decisions act by themselves, how long records are kept; whether a job handed off to a person tells the webhooks,
// and how long a cleared hand-off is kept (issue #516); how recent a timed-out job's output must be for it to count as
// at work, and whether such a job goes on by itself (issue #630). Saved to the daemon, applied without a restart.
// Keyed by the saved values, so a save starts the form from them again.
import { Settings2 } from 'lucide-react';
import { useState } from 'react';
import { Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { FailureSettings } from '@/model/wire';
import { saveFailureSettings } from '@/store';

type NumberKey = Exclude<keyof FailureSettings, 'auto' | 'handoffNotify'>;
const NUMBERS: { key: NumberKey; label: string; step?: string }[] = [
  { key: 'maxAttempts', label: 'Retries per job' },
  { key: 'backoffSec', label: 'First wait (s)' },
  { key: 'backoffFactor', label: 'Wait factor', step: '0.5' },
  { key: 'backoffMaxSec', label: 'Longest wait (s)' },
  { key: 'groupThreshold', label: 'Jobs to flag a cause' },
  { key: 'groupWindowMin', label: 'Within (min)' },
  { key: 'activeWindowMin', label: 'Timed out: output within (min)' },
  { key: 'retentionDays', label: 'Keep records (days)' },
  { key: 'handoffRetentionDays', label: 'Keep cleared hand-offs (days)' },
];
const AUTO: { key: keyof FailureSettings['auto']; label: string }[] = [
  { key: 'retry', label: 'Retry transient failures' },
  { key: 'hold', label: 'Hold jobs for open problems' },
  { key: 'redirect', label: 'Redirect jobs to another machine' },
  { key: 'continue', label: 'Continue timed-out jobs still at work' },
];

function Form({ settings }: { settings: FailureSettings }) {
  const [numbers, setNumbers] = useState<Record<NumberKey, string>>(() => Object.fromEntries(NUMBERS.map((n) => [n.key, String(settings[n.key])])) as Record<NumberKey, string>);
  const [auto, setAuto] = useState(settings.auto);
  const [notify, setNotify] = useState(settings.handoffNotify);
  const [busy, setBusy] = useState(false);
  const changed = NUMBERS.some((n) => Number(numbers[n.key]) !== settings[n.key]) || AUTO.some((a) => auto[a.key] !== settings.auto[a.key]) || notify !== settings.handoffNotify;
  const save = async () => {
    setBusy(true);
    await saveFailureSettings({ ...Object.fromEntries(NUMBERS.map((n) => [n.key, Number(numbers[n.key])])), auto, handoffNotify: notify });
    setBusy(false);
  };
  return (
    <div data-section="failure-settings" className="space-y-3 text-sm">
      <p className="text-muted-foreground">
        A transient failure runs again up to {settings.maxAttempts} times, waiting {settings.backoffSec} s, then {settings.backoffFactor}× longer each time, at most {settings.backoffMaxSec} s.
        One signature on {settings.groupThreshold} jobs within {settings.groupWindowMin} min is flagged as a general cause.
        A timed-out job with pane output in its last {settings.activeWindowMin} min, commits pushed or a pull request open goes on; a silent one runs again once.
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {NUMBERS.map((n) => (
          <label key={n.key} className="grid gap-1"><span className="text-xs text-muted-foreground">{n.label}</span>
            <Input type="number" step={n.step ?? '1'} className="h-8" aria-label={n.label} value={numbers[n.key]} disabled={busy}
              onChange={(e) => setNumbers({ ...numbers, [n.key]: e.target.value })} /></label>
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {AUTO.map((a) => (
          <label key={a.key} className="flex items-center gap-2">
            <input type="checkbox" checked={auto[a.key]} disabled={busy} onChange={(e) => setAuto({ ...auto, [a.key]: e.target.checked })} />{a.label}
          </label>
        ))}
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={notify} disabled={busy} onChange={(e) => setNotify(e.target.checked)} />Tell webhooks when a job needs a person
        </label>
      </div>
      <Button size="sm" disabled={busy || !changed} onClick={() => void save()}>Save</Button>
    </div>
  );
}

export function FailureSettingsPanel({ settings }: { settings: FailureSettings }) {
  return (
    <Panel title="Failures settings" icon={Settings2}>
      <Form key={JSON.stringify(settings)} settings={settings} />
    </Panel>
  );
}
