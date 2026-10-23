// Delivery forecasts (issue #2554 part 7), in Settings → Delivery: each scheduled repository's open promotion set and the
// two before it — their steps and times on the owner's wall clock (the schedule's time zone), the person a gate waits on,
// and a button that clears the gate —; a change looked up by its job id, issue or pull request; and the forecast's error
// per week or day, from the delivery ledger.
import { Gauge, PackageCheck, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { get, post, RoleRefused, SessionRejected } from '@/lib/api';
import { changeQuery, durationText, forecastRows, gatesToClear, stepLabel, timeZoneOf, zonedTime } from '@/model/delivery-forecast';
import type { DeliveryForecast, DeliveryForecastView, DeliveryLedgerView, DeliverySettingsView, PromotionSetForecastView, StepForecast } from '@/model/wire';
import { useHopper } from '@/store';

const BROWSER_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

function Steps({ f, tz }: { f: DeliveryForecast; tz: string }) {
  const rows = forecastRows(f, tz);
  return (
    <table className="w-full text-xs">
      <thead className="text-muted-foreground"><tr><th className="py-1 text-left font-normal">Step</th><th className="text-left font-normal">Expected end (p50)</th><th className="text-left font-normal">p90</th><th className="text-left font-normal">Basis</th><th className="text-left font-normal">Gate</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.step} data-step={r.step} className={r.current ? 'font-medium' : undefined}>
            <td className="py-0.5">{r.label}{r.set ? <span className="ml-1 text-muted-foreground">({r.set})</span> : null}</td>
            <td className="num">{r.end ?? '—'}</td><td className="num">{r.endP90 ?? '—'}</td>
            <td className="text-muted-foreground">{r.basis}</td><td>{r.gate ?? ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Where the forecast stands: the wait on a person, the slip, and the time left by kind. */
function Standing({ f, tz }: { f: DeliveryForecast; tz: string }) {
  const r = f.normal.remaining;
  return (
    <div className="space-y-0.5 text-xs">
      <p>In <span className="font-medium">{stepLabel(f.step)}</span> since {zonedTime(f.since, tz)}{f.normal.productionAt ? <> · in production by {zonedTime(f.normal.productionAt, tz)}{f.normal.productionAtP90 && f.normal.productionAtP90 !== f.normal.productionAt ? ` (p90 ${zonedTime(f.normal.productionAtP90, tz)})` : ''}</> : null}</p>
      {f.wait && <p data-slot="delivery-wait" className="text-warn">Waiting on {f.wait.owner} since {zonedTime(f.wait.since, tz)}</p>}
      {f.slipping && <p data-slot="delivery-slipping" className="text-bad">Slipping ({f.slipping.blocker.replace('_', ' ')}): expected by {zonedTime(f.slipping.expectedEnd, tz)}</p>}
      {r && <p className="text-muted-foreground">Time left: {durationText(r.humanMs)} a person&apos;s wait, {durationText(r.scheduleMs)} to a cutoff, {durationText(r.machineMs)} machine time</p>}
      {f.expedited?.productionAt && <p>Expedited: in production by {zonedTime(f.expedited.productionAt, tz)}</p>}
    </div>
  );
}

function SetCard({ repo, view, tz, onCleared }: { repo: string; view: PromotionSetForecastView; tz: string; onCleared: () => void }) {
  const [busy, setBusy] = useState(false);
  const clear = async (step: StepForecast['step']) => {
    setBusy(true);
    try {
      await post('/ui/api/delivery-gate', { repo, set: view.set.set, step });
      toast.success(`${stepLabel(step)} of set ${view.set.set} cleared`);
      onCleared();
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
      toast.error(e instanceof RoleRefused ? 'Only an operator clears a delivery gate' : (e as Error).message);
    }
    setBusy(false);
  };
  return (
    <div data-slot="promotion-set" data-set={view.set.set} className="space-y-2 rounded-md border p-3">
      <p className="text-sm font-medium">Set {view.set.set}
        <span className="ml-2 text-xs font-normal text-muted-foreground">cutoff {zonedTime(view.set.cutoffAt, tz)} · test gate {zonedTime(view.set.testGateAt, tz)} · production {zonedTime(view.set.productionAt, tz)}</span>
      </p>
      {view.deliveredAt ? <p className="text-xs">Delivered {zonedTime(view.deliveredAt, tz)}</p> : view.forecast ? <><Standing f={view.forecast} tz={tz} /><Steps f={view.forecast} tz={tz} /></> : null}
      <p className="text-xs text-muted-foreground">{view.changes.length === 0 ? 'No changes in it yet.' : `Changes: ${view.changes.map((c) => `${c.issue ?? c.pullRequest ?? c.jobId}${c.expected ? ' (expected)' : ''}${c.expedited ? ' (expedited)' : ''}`).join(', ')}`}</p>
      {!view.deliveredAt && gatesToClear(view.forecast).map((g) => (
        <Button key={g.step} size="sm" variant="outline" disabled={busy} onClick={() => void clear(g.step)}>Clear {stepLabel(g.step).toLowerCase()} ({g.owner})</Button>
      ))}
    </div>
  );
}

/** The open set and the two before it, newest first. */
function RepoSets({ repo, tz }: { repo: string; tz: string }) {
  const [sets, setSets] = useState<PromotionSetForecastView[] | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    const at = (q: Record<string, string>) => get<PromotionSetForecastView>(`/api/delivery-forecast?${new URLSearchParams({ repo, ...q }).toString()}`);
    at({}).then(async (open) => [open, ...await Promise.all([1, 2].filter((k) => open.set.set - k >= 1).map((k) => at({ set: String(open.set.set - k) })))])
      .then(setSets, () => setSets([]));
  }, [repo, round]);
  const load = () => setRound((r) => r + 1);
  return (
    <div data-slot="repo-sets" className="space-y-2">
      <p className="text-sm font-medium">{repo} <span className="text-xs font-normal text-muted-foreground">times in {tz}</span></p>
      {sets === null ? <p className="text-xs text-muted-foreground">Loading…</p> : sets.length === 0 ? <p className="text-xs text-muted-foreground">No open promotion set.</p>
        : sets.map((s) => <SetCard key={s.set.set} repo={repo} view={s} tz={tz} onCleared={load} />)}
    </div>
  );
}

function FindChange({ settings }: { settings: DeliverySettingsView['settings'] }) {
  const [text, setText] = useState('');
  const [found, setFound] = useState<DeliveryForecastView | null>(null);
  const [problem, setProblem] = useState('');
  const look = async () => {
    const q = changeQuery(text);
    if (!q) return;
    try { setFound(await get<DeliveryForecastView>(`/api/delivery-forecast?${q}`)); setProblem(''); } catch (e) { setFound(null); setProblem((e as Error).message); }
  };
  const tz = timeZoneOf(settings, found?.repo, BROWSER_ZONE);
  return (
    <div data-slot="delivery-find" className="space-y-2">
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void look(); }}>
        <Input className="h-8" value={text} placeholder="job id, owner/repo#N or pull request URL" aria-label="A change to forecast" onChange={(e) => setText(e.target.value)} />
        <Button size="sm" type="submit" disabled={!changeQuery(text)}><Search className="size-3.5" />Forecast</Button>
      </form>
      {problem && <p className="text-xs text-bad">{problem}</p>}
      {found && (
        <div className="space-y-2 rounded-md border p-3">
          <p className="text-sm font-medium">{found.issue ?? found.pullRequest ?? found.jobId} <span className="text-xs font-normal text-muted-foreground">times in {tz}</span></p>
          {found.deliveredAt ? <p className="text-xs">Delivered {zonedTime(found.deliveredAt, tz)}</p> : found.forecast ? <><Standing f={found.forecast} tz={tz} /><Steps f={found.forecast} tz={tz} /></> : null}
        </div>
      )}
    </div>
  );
}

function AccuracyOverTime() {
  const [period, setPeriod] = useState<'week' | 'day'>('week');
  const [view, setView] = useState<DeliveryLedgerView | null>(null);
  useEffect(() => { get<DeliveryLedgerView>(`/api/delivery-ledger?period=${period}`).then((v) => { if (Array.isArray(v?.overTime?.points)) setView(v); }, () => {}); }, [period]);
  return (
    <div data-slot="delivery-accuracy" className="space-y-2">
      <div className="flex items-center gap-2 text-xs">
        <span>Forecast error per</span>
        {(['week', 'day'] as const).map((p) => <Button key={p} size="sm" variant={p === period ? 'default' : 'outline'} onClick={() => setPeriod(p)}>{p}</Button>)}
        {view && <span className="text-muted-foreground">in {view.overTime.timeZone}</span>}
      </div>
      {!view ? <p className="text-xs text-muted-foreground">Loading…</p> : view.overTime.points.length === 0 ? <p className="text-xs text-muted-foreground">No step with a prediction has ended yet.</p> : (
        <table className="w-full text-xs">
          <thead className="text-muted-foreground"><tr><th className="py-1 text-left font-normal">From</th><th className="text-left font-normal">Step</th><th className="text-left font-normal">Samples</th><th className="text-left font-normal">Mean error</th></tr></thead>
          <tbody>{view.overTime.points.map((p) => (
            <tr key={`${p.start} ${p.step}`}><td className="num py-0.5">{p.start}</td><td>{stepLabel(p.step)}</td><td className="num">{p.samples}</td><td className="num">{durationText(p.meanAbsErrorMs)}</td></tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
}

export function DeliveryForecasts() {
  const [settings, setSettings] = useState<DeliverySettingsView['settings'] | null>(null);
  useEffect(() => { get<DeliverySettingsView>('/api/delivery-settings').then((v) => { if (v?.settings?.repos) setSettings(v.settings); }, () => {}); }, []);
  const scheduled = settings ? Object.entries(settings.repos).filter(([, r]) => r.schedule).map(([repo, r]) => ({ repo, tz: r.schedule!.timeZone })) : [];
  return (
    <div className="max-w-3xl space-y-4">
      <Panel title="Promotion sets" icon={PackageCheck}>
        <div className="space-y-4 text-sm">
          {settings === null ? <p className="text-muted-foreground">Loading…</p> : scheduled.length === 0 ? <p className="text-xs text-muted-foreground">No repository has a promotion set schedule yet: set one in the delivery settings below.</p>
            : scheduled.map((s) => <RepoSets key={s.repo} repo={s.repo} tz={s.tz} />)}
        </div>
      </Panel>
      <Panel title="Forecast a change" icon={Search}>{settings ? <FindChange settings={settings} /> : <p className="text-sm text-muted-foreground">Loading…</p>}</Panel>
      <Panel title="Forecast accuracy" icon={Gauge}><AccuracyOverTime /></Panel>
    </div>
  );
}
