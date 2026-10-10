// Lane tuning (issue #688), on Machines: each machine's lane recommendation — the lanes it can run from its resource
// history and the usage it burns — next to its configured lanes, with the reason and the confidence. Shadow: nothing
// changes the configured lanes. An admin turns auto-tune on or off per machine and sets the least and most lanes it may
// recommend. Read from GET /api/lanes/plan (`hopper lanes plan` reads the same), again as new machine samples come in.
import { Gauge } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { get, post, RoleRefused, SessionRejected } from '@/lib/api';
import { confidenceText, laneTuningPatch, recommendationLine, type LaneTuningDraft } from '@/model/lane-tuning';
import type { LaneRecommendation, LaneTuningPlan } from '@/model/wire';
import { useHopper } from '@/store';
import { useCanAdmin } from '@/store/selectors';

function TuningForm({ r, onSaved }: { r: LaneRecommendation; onSaved: (p: LaneTuningPlan) => void }) {
  const t = r.tuning;
  const [draft, setDraft] = useState<LaneTuningDraft>({ autoTune: t.autoTune, minLanes: String(t.minLanes), maxLanes: String(t.maxLanes) });
  const [busy, setBusy] = useState(false);
  const checked = laneTuningPatch(t, draft);
  const save = async () => {
    if (!checked.ok || !checked.patch) return;
    setBusy(true);
    try {
      onSaved(await post<LaneTuningPlan>('/ui/api/lanes/tuning', { machineId: r.machineId, ...checked.patch }));
      toast.success(`Lane tuning saved for ${r.label || r.machineId}`);
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
      toast.error(e instanceof RoleRefused ? 'Only an admin changes lane tuning' : (e as Error).message);
    }
    setBusy(false);
  };
  const name = r.label || r.machineId;
  return (
    <div data-slot="lane-tuning-form" className="flex flex-wrap items-center gap-3 text-xs">
      <label className="flex items-center gap-2">
        <Switch checked={draft.autoTune} disabled={busy} aria-label={`Auto-tune ${name}`} onCheckedChange={(autoTune) => setDraft({ ...draft, autoTune })} />Auto-tune
      </label>
      <label className="flex items-center gap-1.5">Least
        <Input className="h-7 w-14" inputMode="numeric" aria-label={`Least lanes for ${name}`} disabled={busy} value={draft.minLanes} onChange={(e) => setDraft({ ...draft, minLanes: e.target.value })} />
      </label>
      <label className="flex items-center gap-1.5">Most
        <Input className="h-7 w-14" inputMode="numeric" aria-label={`Most lanes for ${name}`} disabled={busy} value={draft.maxLanes} onChange={(e) => setDraft({ ...draft, maxLanes: e.target.value })} />
      </label>
      <Button size="sm" variant="outline" disabled={busy || !checked.ok || !checked.patch} onClick={() => void save()}>Save</Button>
      {!checked.ok && <span role="alert" className="text-destructive">{checked.error}</span>}
    </div>
  );
}

function Row({ r, admin, onSaved }: { r: LaneRecommendation; admin: boolean; onSaved: (p: LaneTuningPlan) => void }) {
  return (
    <li data-slot="lane-recommendation" className="grid gap-1.5 border-b pb-3 last:border-b-0 last:pb-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">{r.label || r.machineId}</span>
        <span data-slot="lane-recommendation-line" className="num">{recommendationLine(r)}</span>
      </div>
      <p className="text-xs text-muted-foreground">{r.reason} <span className="whitespace-nowrap">({confidenceText(r)})</span></p>
      {admin && <TuningForm key={JSON.stringify(r.tuning)} r={r} onSaved={onSaved} />}
    </li>
  );
}

export function LaneTuningPanel() {
  const admin = useCanAdmin();
  const recorded = useHopper((s) => s.recorded.machine);
  const [plan, setPlan] = useState<LaneTuningPlan | null>(null);
  const load = useCallback(() => { get<LaneTuningPlan>('/api/lanes/plan').then((p) => { if (Array.isArray(p?.machines)) setPlan(p); }, () => {}); }, []);
  useEffect(load, [load, recorded]);
  return (
    <Panel title="Lane tuning" icon={Gauge}>
      <div className="grid gap-3">
        <p className="text-xs text-muted-foreground">
          The lanes each machine can run, from its resources over the last {plan?.windowDays ?? 7} days and the usage it burns. Shadow mode: the
          hopper shows and records each recommendation, and keeps the configured lanes.
        </p>
        {plan ? (
          <ul className="grid gap-3">{plan.machines.map((r) => <Row key={r.machineId} r={r} admin={admin} onSaved={setPlan} />)}</ul>
        ) : <p className="text-sm text-muted-foreground">Loading…</p>}
      </div>
    </Panel>
  );
}
