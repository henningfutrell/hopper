// The failures settings (issue #509), an admin's: the retry limit and backoff, the grouping threshold, which
// decisions act by themselves, and how long records are kept. Saved to the daemon, applied without a restart.
// Keyed by the saved values, so a save starts the form from them again.
import { Settings2 } from 'lucide-react';
import { useState } from 'react';
import { Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { FailureSettings } from '@/model/wire';
import { saveFailureSettings } from '@/store';

type NumberKey = Exclude<keyof FailureSettings, 'auto'>;
const NUMBERS: { key: NumberKey; label: string; step?: string }[] = [
  { key: 'maxAttempts', label: 'Retries per job' },
  { key: 'backoffSec', label: 'First wait (s)' },
  { key: 'backoffFactor', label: 'Wait factor', step: '0.5' },
  { key: 'backoffMaxSec', label: 'Longest wait (s)' },
  { key: 'groupThreshold', label: 'Jobs to flag a cause' },
  { key: 'groupWindowMin', label: 'Within (min)' },
  { key: 'retentionDays', label: 'Keep records (days)' },
];
const AUTO: { key: keyof FailureSettings['auto']; label: string }[] = [
  { key: 'retry', label: 'Retry transient failures' },
  { key: 'hold', label: 'Hold jobs for open problems' },
  { key: 'redirect', label: 'Redirect jobs to another machine' },
];

function Form({ settings }: { settings: FailureSettings }) {
  const [numbers, setNumbers] = useState<Record<NumberKey, string>>(() => Object.fromEntries(NUMBERS.map((n) => [n.key, String(settings[n.key])])) as Record<NumberKey, string>);
  const [auto, setAuto] = useState(settings.auto);
  const [busy, setBusy] = useState(false);
  const changed = NUMBERS.some((n) => Number(numbers[n.key]) !== settings[n.key]) || AUTO.some((a) => auto[a.key] !== settings.auto[a.key]);
  const save = async () => {
    setBusy(true);
    await saveFailureSettings({ ...Object.fromEntries(NUMBERS.map((n) => [n.key, Number(numbers[n.key])])), auto });
    setBusy(false);
  };
  return (
    <div data-section="failure-settings" className="space-y-3 text-sm">
      <p className="text-muted-foreground">
        A transient failure runs again up to {settings.maxAttempts} times, waiting {settings.backoffSec} s, then {settings.backoffFactor}× longer each time, at most {settings.backoffMaxSec} s.
        One signature on {settings.groupThreshold} jobs within {settings.groupWindowMin} min is flagged as a general cause.
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
