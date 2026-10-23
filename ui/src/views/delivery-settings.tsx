// Delivery settings (issue #2554 part 3), in Settings, an admin's: per repository, its promotion set schedule — the
// weekly cutoffs in the owner's time zone, the minutes to the end of the test gate and to production — and its delivery
// gates, each step a person ends with its owner. Edited as one JSON object; the delivery forecasts read it at once.
import { CalendarClock } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { get, post, RoleRefused, SessionRejected } from '@/lib/api';
import { deliveryPatch } from '@/model/delivery-settings';
import type { DeliverySettingsView } from '@/model/wire';
import { useHopper } from '@/store';

const EXAMPLE = {
  schedule: { timeZone: 'America/Chicago', cutoffs: [{ weekday: 2, time: '14:00' }, { weekday: 4, time: '14:00' }], testGateAfterMinutes: 120, productionAfterMinutes: 1440, epoch: '2026-10-01T00:00:00.000Z', expedite: 'out_of_cadence' },
  gates: { test_gate: { owner: 'release owner' } },
};

function Form({ view, onSaved }: { view: DeliverySettingsView; onSaved: (v: DeliverySettingsView) => void }) {
  const [text, setText] = useState(() => JSON.stringify(view.settings.repos, null, 2));
  const [busy, setBusy] = useState(false);
  const change = deliveryPatch(view.settings, text);
  const patch = 'patch' in change ? change.patch : undefined;
  const save = async () => {
    if (!patch) return;
    setBusy(true);
    try {
      onSaved(await post<DeliverySettingsView>('/ui/api/delivery-settings', patch));
      toast.success('Delivery settings saved');
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
      toast.error(e instanceof RoleRefused ? 'Only an admin changes the delivery settings' : (e as Error).message);
    }
    setBusy(false);
  };
  return (
    <div data-slot="delivery-settings" className="space-y-3 text-sm">
      <p className="text-xs text-muted-foreground">
        Per repository (owner/repo): its promotion set schedule and its delivery gates. A change that ends its landing checks
        before a cutoff is in that cutoff&apos;s set. Weekdays are 1 (Monday) to 7 (Sunday), times are HH:MM in the time zone.
        A gate is a step a person ends ({view.choices.steps.join(', ')}), with its owner.
      </p>
      <Textarea name="delivery-settings" rows={14} className="font-mono text-xs" value={text} disabled={busy} aria-label="Delivery settings as JSON" onChange={(e) => setText(e.target.value)} />
      {'problem' in change && <p data-slot="delivery-settings-problem" className="text-xs text-bad">{change.problem}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy || !patch} onClick={() => void save()}>Save</Button>
        {view.choices.repos.filter((r) => !text.includes(`"${r.toLowerCase()}"`)).slice(0, 1).map((r) => (
          <Button key={r} size="sm" variant="outline" disabled={busy || 'problem' in change}
            onClick={() => setText(JSON.stringify({ ...(JSON.parse(text) as object), [r.toLowerCase()]: EXAMPLE }, null, 2))}>Add {r}</Button>
        ))}
      </div>
    </div>
  );
}

/** Read when shown; keyed by the saved values, so a save starts the form from them. */
export function DeliverySettings() {
  const [view, setView] = useState<DeliverySettingsView | null>(null);
  useEffect(() => { get<DeliverySettingsView>('/api/delivery-settings').then((v) => { if (v?.settings?.repos && Array.isArray(v.choices?.steps)) setView(v); }, () => {}); }, []);
  return (
    <Panel title="Delivery settings" icon={CalendarClock} className="max-w-3xl">
      {view ? <Form key={JSON.stringify(view.settings)} view={view} onSaved={setView} /> : <p className="text-sm text-muted-foreground">Loading…</p>}
    </Panel>
  );
}
