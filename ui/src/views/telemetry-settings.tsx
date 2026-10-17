// Telemetry (issue #1486, design.md "Telemetry settings"), in Settings, the hopper's admin's: whether the hopper exports its
// traces, metrics and logs over OTLP, to which endpoint, and which signals. It applies at once. The launch's OTEL_*
// variables win when they name an exporter; a header the collector needs is given at launch, never here.
import { Activity } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { get, post, RoleRefused, SessionRejected } from '@/lib/api';
import { SIGNALS, telemetrySourceLine, toggleSignal } from '@/model/telemetry-settings';
import type { TelemetrySettings as Setting, TelemetrySettingsView } from '@/model/wire';
import { useHopper } from '@/store';

function Form({ view, onSaved }: { view: TelemetrySettingsView; onSaved: (v: TelemetrySettingsView) => void }) {
  const [draft, setDraft] = useState<Setting>(view.settings);
  const [busy, setBusy] = useState(false);
  const changed = JSON.stringify(draft) !== JSON.stringify(view.settings);
  const save = async () => {
    setBusy(true);
    try {
      onSaved(await post<TelemetrySettingsView>('/ui/api/telemetry-settings', draft));
      toast.success(draft.on ? 'Telemetry is on' : 'Telemetry is off');
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
      toast.error(e instanceof RoleRefused ? 'Only the hopper\'s admin changes telemetry' : (e as Error).message);
    }
    setBusy(false);
  };
  return (
    <div data-slot="telemetry-settings" className="space-y-3 text-sm">
      <p data-slot="telemetry-source" className={view.exporting ? 'font-medium' : 'text-xs text-muted-foreground'}>{telemetrySourceLine(view)}</p>
      <label className="flex items-center gap-2">
        <Switch checked={draft.on} disabled={busy} aria-label="Export telemetry" onCheckedChange={(on) => setDraft((d) => ({ ...d, on }))} />
        <span>Export traces, metrics and logs over OTLP</span>
      </label>
      <label className="block space-y-1">
        <span>OTLP endpoint: each signal goes to the endpoint&apos;s /v1/traces, /v1/metrics or /v1/logs</span>
        <Input aria-label="OTLP endpoint" className="font-mono text-xs" placeholder="http://collector:4318" disabled={busy} value={draft.endpoint} onChange={(e) => setDraft((d) => ({ ...d, endpoint: e.target.value }))} />
      </label>
      <div className="flex gap-4">
        {SIGNALS.map((s) => (
          <label key={s} className="flex items-center gap-1">
            <input type="checkbox" className="size-4" checked={draft.signals.includes(s)} disabled={busy} onChange={(e) => setDraft((d) => ({ ...d, signals: toggleSignal(d.signals, s, e.target.checked) }))} />{s}
          </label>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        A header the collector needs (an API key) is given at launch, as OTEL_EXPORTER_OTLP_HEADERS, never here. No secret,
        prompt or token goes out: only ids, enums, durations and counts.
      </p>
      <Button size="sm" disabled={busy || !changed} onClick={() => void save()}>Save</Button>
    </div>
  );
}

export function TelemetrySettings() {
  const [view, setView] = useState<TelemetrySettingsView | null>(null);
  useEffect(() => { void get<TelemetrySettingsView>('/api/telemetry-settings').then((v) => { if (v?.settings) setView(v); }, (e: unknown) => toast.error((e as Error).message)); }, []);
  return (
    <Panel title="Telemetry" icon={Activity} className="max-w-3xl">
      {view ? <Form key={JSON.stringify(view.settings)} view={view} onSaved={setView} /> : <p className="text-sm text-muted-foreground">Loading…</p>}
    </Panel>
  );
}
