// Lane tuning (issue #688), on Machines: each machine's lane recommendation — the lanes it can run from its resource
// history and the usage it burns — next to its configured lanes, with the reason and the confidence. Shadow mode changes
// nothing; active mode applies the recommendation within the bounds, and the history lists each change with its reason.
// An admin turns auto-tune on or off per machine, sets the least and most lanes it may recommend and the mode, and undoes
// the last change. Read from GET /api/lanes/plan (`hopper lanes plan` reads the same), again as new machine samples come in.
import { Gauge } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { get, post, RoleRefused, SessionRejected } from '@/lib/api';
import { changeLine, confidenceText, laneTuningPatch, recommendationLine, type LaneTuningDraft } from '@/model/lane-tuning';
import type { LaneChange, LaneRecommendation, LaneTuningPlan } from '@/model/wire';
import { useHopper } from '@/store';
import { useCanAdmin } from '@/store/selectors';

function TuningForm({ r, onSaved }: { r: LaneRecommendation; onSaved: (p: LaneTuningPlan) => void }) {
  const t = r.tuning;
  const [draft, setDraft] = useState<LaneTuningDraft>({ autoTune: t.autoTune, minLanes: String(t.minLanes), maxLanes: String(t.maxLanes), mode: t.mode });
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
      <label className="flex items-center gap-2">
        <Switch checked={draft.mode === 'active'} disabled={busy} aria-label={`Active mode for ${name}`} onCheckedChange={(on) => setDraft({ ...draft, mode: on ? 'active' : 'shadow' })} />Active
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

function Undo({ r, to, onSaved }: { r: LaneRecommendation; to: number; onSaved: (p: LaneTuningPlan) => void }) {
  const [busy, setBusy] = useState(false);
  const undo = async () => {
    setBusy(true);
    try {
      onSaved(await post<LaneTuningPlan>('/ui/api/lanes/undo', { machineId: r.machineId }));
      toast.success(`Lane change undone for ${r.label || r.machineId}`);
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
      toast.error(e instanceof RoleRefused ? 'Only an admin undoes a lane change' : (e as Error).message);
    }
    setBusy(false);
  };
  return <Button size="sm" variant="outline" disabled={busy} onClick={() => void undo()}>Undo: back to {to}</Button>;
}

function Row({ r, admin, changes, onSaved }: { r: LaneRecommendation; admin: boolean; changes: LaneChange[]; onSaved: (p: LaneTuningPlan) => void }) {
  return (
    <li data-slot="lane-recommendation" className="grid gap-1.5 border-b pb-3 last:border-b-0 last:pb-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">{r.label || r.machineId}</span>
        <span data-slot="lane-recommendation-line" className="num">{recommendationLine(r)}</span>
      </div>
      <p className="text-xs text-muted-foreground">{r.reason} <span className="whitespace-nowrap">({confidenceText(r)})</span></p>
      {changes.length > 0 && (
        <ul className="grid gap-0.5 text-xs text-muted-foreground">
          {changes.map((c) => (
            <li key={`${c.at}-${c.kind}`} data-slot="lane-change"><time className="num" dateTime={c.at}>{new Date(c.at).toLocaleString()}</time> · {changeLine(c)}</li>
          ))}
        </ul>
      )}
      {admin && r.undo && <div><Undo r={r} to={r.undo.to} onSaved={onSaved} /></div>}
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
          hopper shows and records each recommendation, and keeps the configured lanes. Active mode: the hopper applies it within the bounds.
        </p>
        {plan ? (
          <ul className="grid gap-3">{plan.machines.map((r) => <Row key={r.machineId} r={r} admin={admin} changes={plan.changes.filter((c) => c.machineId === r.machineId).slice(0, 5)} onSaved={setPlan} />)}</ul>
        ) : <p className="text-sm text-muted-foreground">Loading…</p>}
      </div>
    </Panel>
  );
}
