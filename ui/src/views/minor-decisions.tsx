// Minor decisions (issue #550), in Settings: bounded choices Jev makes first, before an escalation level, a model or a
// person. Whether Jev can be asked now; per decision point its mode and threshold (an admin's, saved to the daemon,
// applied from the next decision) and its record over the window — asked, applied, the agreement rate a person flips
// it to active on —; then the newest picks, each with its options, what Jev picked and how sure, what became of it and
// what was decided, and Override (an operator's): what it should have been, which counts in the agreement rate.
import { Scale } from 'lucide-react';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { Empty, Panel } from '@/components/panel';
import { FIELD } from '@/components/plugin-form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { usePoll } from '@/hooks/use-poll';
import { get, post } from '@/lib/api';
import { clock } from '@/model/format';
import { MODE_TEXT, pickDecided, pickSummary, rate } from '@/model/minor-decisions';
import type { DecisionPointView, MinorDecisionMode, MinorDecisionPickView, MinorDecisionsView } from '@/model/wire';
import { useCanAdmin, useCanOperate, useJobName } from '@/store/selectors';

const MODES: MinorDecisionMode[] = ['off', 'shadow', 'active'];
const POLL_MS = 10_000;

function Point({ p, onSaved }: { p: DecisionPointView; onSaved: () => void }) {
  const admin = useCanAdmin();
  const [mode, setMode] = useState(p.mode);
  const [threshold, setThreshold] = useState(String(Math.round(p.threshold * 100)));
  const [busy, setBusy] = useState(false);
  const t = Number(threshold) / 100;
  const changed = mode !== p.mode || t !== p.threshold;
  const save = async () => {
    setBusy(true);
    try {
      await post(`/ui/api/minor-decisions/points/${p.point}`, { mode, threshold: t });
      toast.success(`${p.label}: saved`);
      onSaved();
    } catch (e) { toast.error((e as Error).message); }
    setBusy(false);
  };
  return (
    <div data-point={p.point} className="space-y-2 border-b pb-3 last:border-b-0 last:pb-0">
      <div>
        <div className="text-sm font-medium">{p.label}</div>
        <p className="text-xs text-muted-foreground">{p.describe}</p>
      </div>
      <div className="flex flex-wrap items-end gap-2 text-sm">
        <label className="grid gap-1"><span className="text-xs text-muted-foreground">Mode</span>
          <select className={`${FIELD} h-8 w-60 text-sm`} aria-label={`${p.label}: mode`} value={mode} disabled={!admin || busy}
            onChange={(e) => setMode(e.target.value as MinorDecisionMode)}>
            {MODES.map((m) => <option key={m} value={m}>{MODE_TEXT[m]}</option>)}
          </select></label>
        <label className="grid gap-1"><span className="text-xs text-muted-foreground">Confidence needed (%)</span>
          <Input type="number" min={0} max={100} className="h-8 w-28" aria-label={`${p.label}: confidence needed`} value={threshold} disabled={!admin || busy}
            onChange={(e) => setThreshold(e.target.value)} /></label>
        {admin && <Button size="sm" disabled={busy || !changed || !(t >= 0 && t <= 1)} onClick={() => void save()}>Save</Button>}
      </div>
      <dl className="grid grid-cols-3 gap-2 text-xs sm:grid-cols-6">
        {([['Asked', p.asked], ['Picked', p.picked], ['Applied', p.applied], ['Compared', p.compared], ['Agreement', rate(p.agreement)], ['Overridden', p.overridden]] as const).map(([k, v]) => (
          <div key={k}><dt className="text-muted-foreground">{k}</dt><dd className="num font-medium" data-figure={k}>{v}</dd></div>
        ))}
      </dl>
    </div>
  );
}

function PickRow({ p, label, onSaved }: { p: MinorDecisionPickView; label: string; onSaved: () => void }) {
  const canAct = useCanOperate();
  const [actual, setActual] = useState(p.actual ?? p.pick ?? p.options[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const nameOf = useJobName();
  const override = async () => {
    setBusy(true);
    try {
      await post(`/ui/api/minor-decisions/picks/${p.pickId}/override`, { actual });
      toast.success('Override recorded');
      onSaved();
    } catch (e) { toast.error((e as Error).message); }
    setBusy(false);
  };
  const decided = pickDecided(p);
  return (
    <li data-pick={p.pickId} className="space-y-1 border-b py-2 text-xs last:border-b-0">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="num font-mono text-muted-foreground" title={p.at}>{clock(p.at)}</span>
        <span className="font-medium">{label}</span>
        {p.jobId && <span className="min-w-0 truncate text-muted-foreground">{nameOf(p.jobId)}</span>}
      </div>
      <div>{pickSummary(p)}</div>
      {decided && <div className="text-muted-foreground">{decided}</div>}
      {canAct && p.options.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <select className={`${FIELD} h-7 w-72 text-xs`} aria-label="What it should have been" value={actual} disabled={busy} onChange={(e) => setActual(e.target.value)}>
            {p.options.map((o) => <option key={o.id} value={o.id}>{o.label} ({o.id})</option>)}
          </select>
          <Button size="xs" variant="outline" disabled={busy} onClick={() => void override()}>Override</Button>
        </div>
      )}
    </li>
  );
}

export function MinorDecisions() {
  const [view, setView] = useState<MinorDecisionsView | undefined>();
  const load = useCallback(async () => setView(await get<MinorDecisionsView>('/api/minor-decisions')), []);
  usePoll(load, POLL_MS);
  const reload = () => { load().catch(() => {}); };
  if (!view) return <Panel title="Minor decisions" icon={Scale}><Empty>loading</Empty></Panel>;
  const labelOf = (point: string) => view.points.find((p) => p.point === point)?.label ?? point;
  return (
    <div className="space-y-3">
      <Panel title="Minor decisions" icon={Scale}>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Jev makes small, bounded decisions first, before a model or a person. In shadow it only records what it would pick, next
            to what was decided; active, a pick it is sure enough of is applied. Anything that deletes, sends, publishes, pays, changes
            permissions or runs on a gated machine always goes on to the next step. Figures over the last {view.windowDays} days.
          </p>
          <p data-jev={view.jev.available ? 'on' : 'off'} className="text-sm">
            {view.jev.available ? 'Jev is on.' : `Jev is off: ${view.jev.why ?? 'it cannot be asked'}. Each decision is made as before.`}
          </p>
          {view.points.map((p) => <Point key={`${p.point}:${p.mode}:${p.threshold}`} p={p} onSaved={reload} />)}
        </div>
      </Panel>
      <Panel title="Recent picks" icon={Scale} count={view.recent.length} list>
        {view.recent.length ? (
          <ul>{view.recent.map((p) => <PickRow key={`${p.pickId}:${p.actual ?? ''}`} p={p} label={labelOf(p.point)} onSaved={reload} />)}</ul>
        ) : <Empty>no picks yet</Empty>}
      </Panel>
    </div>
  );
}
