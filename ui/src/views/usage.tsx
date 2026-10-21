// Usage: who each part acts as (accounts), every usage reading by source, and what usage does to
// each machine's lanes now (design.md "Usage and accounts (issue #18)"); the usage limits on their graph
// (issue #522) and how long the usage history is kept (issue #385), the settings here, an admin's. Each panel folds, and
// stays folded over a reload (issue #2353).
import { useEffect, useState } from 'react';
import { Gauge as GaugeIcon, History, Layers, MemoryStick, SlidersHorizontal, UserRound } from 'lucide-react';
import { UsageLimitsGraph } from '@/charts/usage-limits';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { get } from '@/lib/api';
import { allows } from '@/model/roles';
import { Empty, Panel } from '@/components/panel';
import { ReadingGauge } from '@/components/reading';
import { StatusBadge, type Tone } from '@/components/status';
import { useNow } from '@/hooks/use-now';
import { usePoll } from '@/hooks/use-poll';
import { accountFacts, executorEffectLines, laneEffectText, orderReadings, serviceLabel, sourceLine, throttleText } from '@/model/usage';
import { bandAt, capAt, limitsProblem, throttleLine, windowLines, type LimitBand } from '@/model/usage-limits';
import type { MachineHistory, MachineLaneEffect, MemoryAlert, PartAccount, UsageHistory, UsageLimitPair, UsageReport } from '@/model/wire';
import { act, refreshUsage, useHopper } from '@/store';
import { MachinesResourcesPanel } from './machine-resources';

const pct = (f: number) => `${Math.round(f * 100)}%`;
const lanes = (n: number) => `${n} ${n === 1 ? 'lane' : 'lanes'}`;
const softLanes = (n: number) => `${n} soft ${n === 1 ? 'lane' : 'lanes'}`;
/** A machine's own usage limits (issue #1860), and its own soft lanes when it names them (issue #2091). */
const ownLimits = (l: UsageLimitPair) => `${pct(l.soft)} / ${pct(l.hard)}${l.softLanes === undefined ? '' : `, ${softLanes(l.softLanes)}`}`;
const BAND_TONE: Record<MachineLaneEffect['band'], Tone> = { free: 'ok', soft: 'warn', hard: 'bad', offline: 'muted' };

function AccountRow({ a }: { a: PartAccount }) {
  return (
    <li className="space-y-1 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-sm font-semibold">{serviceLabel(a.service)}</span>
        <span className="min-w-0 font-mono text-sm break-all">{a.identity ?? <span className="text-muted-foreground">unknown</span>}</span>
      </div>
      <div className="text-[11px] text-muted-foreground">{a.role} <code className="font-mono text-foreground/80">{a.instance}</code></div>
      {accountFacts(a).length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          {accountFacts(a).map(([k, v]) => <div key={k} className="contents"><dt className="text-muted-foreground">{k}</dt><dd className="min-w-0 break-words">{v}</dd></div>)}
        </dl>
      )}
      {a.problem && <div className="text-xs text-warn">{a.problem}</div>}
    </li>
  );
}

function Accounts({ accounts }: { accounts: PartAccount[] }) {
  return (
    <Panel title="Accounts" icon={UserRound} fold="usage.accounts" count={accounts.length || ''}>
      {accounts.length ? <ul className="divide-y">{accounts.map((a) => <AccountRow key={`${a.role}/${a.instance}`} a={a} />)}</ul>
        : <Empty>no part reports an account</Empty>}
    </Panel>
  );
}

function LaneEffect({ usage }: { usage: UsageReport }) {
  const { soft, hard } = usage.limits;
  return (
    <Panel title="Lane effect" icon={Layers} fold="usage.lane-effect" bodyClassName="space-y-3">
      <p className="text-xs text-muted-foreground">
        From <span className="num text-foreground">{pct(soft)}</span> of a throttling budget a machine keeps <span className="num text-foreground">{lanes(usage.limits.softLanes)}</span>; at <span className="num text-foreground">{pct(hard)}</span> lanes stop.
        Informational readings never throttle.
      </p>
      {usage.machines.length ? (
        <ul className="space-y-3">
          {usage.machines.map((m) => (
            <li key={m.machineId} className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{m.label || m.machineId}</span>
                <StatusBadge status={m.band} tone={BAND_TONE[m.band]} />
                <span className="num ml-auto text-sm font-semibold">cap {m.cap}/{m.maxLanes}</span>
              </div>
              <div className="relative h-2 overflow-hidden rounded-full bg-muted" role="img" aria-label={`${m.label}: ${pct(m.usedFrac)} used`}>
                <div className={`h-full rounded-full ${m.band === 'hard' ? 'bg-bad' : m.band === 'soft' ? 'bg-warn' : 'bg-ok'}`} style={{ width: pct(Math.min(1, m.usedFrac)) }} />
                {(m.usageLimits ? [m.usageLimits.soft, m.usageLimits.hard] : [soft, hard]).map((x) => <div key={x} className="absolute top-0 h-full w-0.5 bg-background" style={{ left: pct(x) }} />)}
              </div>
              <div className="num text-xs text-muted-foreground">{pct(m.usedFrac)} used · {laneEffectText(m)}</div>
              {m.throttle && <div className="num text-xs text-muted-foreground" data-throttle={m.machineId}>throttled by {throttleText(m.throttle)}</div>}
              {m.usageLimits && (
                <div className="num text-xs text-muted-foreground" data-own-limits={m.machineId}>its own usage limits: {ownLimits(m.usageLimits)}</div>
              )}
              {executorEffectLines(m).map((line) => <div key={line} className="num text-xs text-muted-foreground">{line}</div>)}
            </li>
          ))}
        </ul>
      ) : <Empty>no machines</Empty>}
    </Panel>
  );
}

function Sources({ usage }: { usage: UsageReport }) {
  const now = useNow();
  if (!usage.sources.length) return <Panel title="Usage" icon={GaugeIcon}><Empty>no usage sources: lanes are capped by machines only</Empty></Panel>;
  return (
    <>
      {usage.sources.map((s) => {
        const line = sourceLine(s, now);
        const readings = orderReadings(usage.readings.filter((r) => r.source === s.name));
        return (
          <Panel key={s.name} title={s.name} icon={GaugeIcon} fold={`usage.source.${s.name}`} count={readings.length || ''} bodyClassName="space-y-3">
            <div className={`text-xs break-words ${line.problem ? 'text-warn' : 'text-muted-foreground'}`}>{line.text}</div>
            {readings.length ? <div className="flex flex-wrap justify-around gap-x-2 gap-y-4">{readings.map((r) => <ReadingGauge key={`${r.window ?? ''}|${r.machineId ?? ''}`} r={r} now={now} />)}</div>
              : <Empty>no readings now</Empty>}
          </Panel>
        );
      })}
    </>
  );
}

const bandSays = (band: LimitBand, n: number) =>
  (band === 'free' ? 'every lane open' : band === 'soft' ? `${lanes(n)} per machine` : 'nothing new starts');
const BAND_TEXT: Record<LimitBand, string> = { free: 'text-ok', soft: 'text-warn', hard: 'text-bad' };
type Limits = Required<UsageLimitPair>;
const same = (a: Limits, b: Limits) => a.soft === b.soft && a.hard === b.hard && a.softLanes === b.softLanes;
const DAY_MS = 86_400_000;

function LimitInput({ id, label, value, disabled, onChange }: { id: string; label: string; value: number; disabled: boolean; onChange: (f: number) => void }) {
  return (
    <label htmlFor={id} className="flex items-center gap-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <Input id={id} type="number" min={0} max={100} step={1} inputMode="numeric" className="num h-8 w-[4.5rem]" disabled={disabled}
        value={Number.isFinite(value) ? Math.round(value * 100) : ''} onChange={(e) => onChange(e.target.value === '' ? Number.NaN : Number(e.target.value) / 100)} />
      <span className="text-muted-foreground">%</span>
    </label>
  );
}

/** The soft lanes (issue #2091): how many lanes each machine keeps from the soft limit to the hard limit. */
function SoftLanesInput({ value, disabled, onChange }: { value: number; disabled: boolean; onChange: (n: number) => void }) {
  return (
    <label htmlFor="usage-soft-lanes" className="flex items-center gap-1.5 text-sm">
      <span className="text-muted-foreground">Soft lanes</span>
      <Input id="usage-soft-lanes" type="number" min={0} step={1} inputMode="numeric" className="num h-8 w-[4.5rem]" disabled={disabled}
        value={Number.isFinite(value) ? value : ''} onChange={(e) => onChange(e.target.value === '' ? Number.NaN : Number(e.target.value))} />
    </label>
  );
}

/**
 * The usage limits (issue #522): usage now and over the last day against the free, soft and hard bands; an admin
 * drags a limit (or types it) and sees the bands, the line's colours and each machine's lane cap follow before
 * saving. A soft limit at or above the hard one is refused here, before the daemon is asked.
 */
function UsageLimits({ usage }: { usage: UsageReport }) {
  const canSet = useHopper((s) => allows(s.user, 'admin'));
  const recorded = useHopper((s) => s.recorded.usage);
  const clock = useNow();
  const saved = usage.limits;
  // The daemon's limits, until the admin starts an edit.
  const [edited, setEdited] = useState<Limits | null>(null);
  const draft = edited ?? { soft: saved.soft, hard: saved.hard, softLanes: saved.softLanes };
  const [history, setHistory] = useState<UsageHistory | null>(null);
  useEffect(() => { get<UsageHistory>('/api/usage/history?range=24h').then(setHistory, () => {}); }, [recorded]);
  const edit = (l: Limits) => setEdited(l);
  const problem = limitsProblem(draft);
  const shown = problem ? { soft: saved.soft, hard: saved.hard, softLanes: saved.softLanes } : draft;
  const online = usage.machines.filter((m) => m.online);
  // The most used online machine, and the window that throttles it (issue #2169).
  const top = online.reduce<(typeof online)[number] | undefined>((a, b) => (!a || b.usedFrac > a.usedFrac ? b : a), undefined);
  const now = top?.usedFrac ?? 0;
  const band = bandAt(now, shown, top?.throttle?.burning);
  const half = (history?.stepMs ?? 0) / 2;
  const points = history ? throttleLine(history.series).map((p) => ({ t: p.t + half, v: p.v })) : [];
  const windows = history ? windowLines(history.series).map((w) => ({ ...w, points: w.points.map((p) => ({ t: p.t + half, v: p.v })) })) : [];
  const dirty = !same(draft, saved);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (problem || !dirty) return;
    if (await act('/ui/api/usage/limits', draft, `Usage limits saved: soft ${pct(draft.soft)}, hard ${pct(draft.hard)}, ${softLanes(draft.softLanes)}`)) {
      await refreshUsage().catch(() => {});
      setEdited(null);
    }
  };
  return (
    <Panel title="Usage limits" icon={SlidersHorizontal} fold="usage.limits" bodyClassName="space-y-3" className="lg:col-span-2">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-1">
        <div>
          <div className="num text-3xl font-semibold tracking-tight" data-slot="usage-now-value">{pct(now)}</div>
          <div className="text-xs text-muted-foreground" data-slot="usage-now-throttle">
            used now, the highest throttling reading{top?.throttle ? `: ${throttleText(top.throttle)}` : ''}
          </div>
        </div>
        <div className={`text-sm font-medium ${BAND_TEXT[band]}`} data-slot="usage-band">{band}: {bandSays(band, shown.softLanes)}</div>
        {online.length > 0 && (
          <ul className="ml-auto flex flex-wrap gap-1.5" aria-label="Lane cap per machine at these limits">
            {online.map((m) => {
              // A machine with its own usage limits (issue #1860) keeps them whatever the user's are; with no soft lanes of its own, the user's apply.
              const cap = capAt(m.maxLanes, m.usedFrac, m.usageLimits ? { softLanes: shown.softLanes, ...m.usageLimits } : shown, m.throttle?.burning);
              return (
                <li key={m.machineId} data-machine-cap={m.machineId} className="num rounded-md border px-2 py-0.5 text-xs">
                  <span className="text-muted-foreground">{m.label || m.machineId}</span>{' '}
                  {cap !== m.cap && <span className="text-muted-foreground line-through">{m.cap}</span>}{cap !== m.cap && ' '}
                  <span className="font-semibold">{cap}</span>/{m.maxLanes} lanes
                  {m.usageLimits && <span className="text-muted-foreground"> · own limits {ownLimits(m.usageLimits)}</span>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <UsageLimitsGraph points={points} windows={windows} now={now} from={history ? Date.parse(history.from) : clock - DAY_MS} to={clock} limits={shown}
        {...(canSet ? { onChange: (l: UsageLimitPair) => edit({ ...draft, soft: l.soft, hard: l.hard }) } : {})} />
      <form className="flex flex-wrap items-center gap-x-4 gap-y-2" onSubmit={save}>
        <LimitInput id="usage-soft-limit" label="Soft" value={draft.soft} disabled={!canSet} onChange={(soft) => edit({ ...draft, soft })} />
        <LimitInput id="usage-hard-limit" label="Hard" value={draft.hard} disabled={!canSet} onChange={(hard) => edit({ ...draft, hard })} />
        <SoftLanesInput value={draft.softLanes} disabled={!canSet} onChange={(n) => edit({ ...draft, softLanes: n })} />
        {canSet && (
          <div className="ml-auto flex items-center gap-2">
            {!same(draft, saved.defaults) && (
              <Button type="button" size="sm" variant="ghost" onClick={() => edit({ ...saved.defaults })}>Defaults ({pct(saved.defaults.soft)} / {pct(saved.defaults.hard)}, {softLanes(saved.defaults.softLanes)})</Button>
            )}
            {dirty && <Button type="button" size="sm" variant="ghost" onClick={() => setEdited(null)}>Undo</Button>}
            <Button type="submit" size="sm" disabled={!!problem || !dirty}>Save</Button>
          </div>
        )}
      </form>
      {problem && <p role="alert" className="text-xs text-bad" data-slot="usage-limits-problem">{problem}</p>}
      <p className="text-xs text-muted-foreground">
        Below the soft limit every lane is open; from the soft limit to the hard limit each machine keeps only the soft lanes (at most its own lanes); at the hard limit nothing new starts.
        Informational readings never throttle. {saved.set
          ? 'Set here, these win over the HOPPER_SOFT_LIMIT and HOPPER_HARD_LIMIT settings of the environment, and apply at once.'
          : 'Until saved here, they come from HOPPER_SOFT_LIMIT and HOPPER_HARD_LIMIT in the environment.'}
      </p>
    </Panel>
  );
}

/** How many days the usage graph's samples are kept; older ones are deleted, at once when it is lowered. */
function HistoryRetention() {
  const canSet = useHopper((s) => allows(s.user, 'admin'));
  const [days, setDays] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  useEffect(() => {
    get<UsageHistory>('/api/usage/history?range=24h').then((h) => { setDays(h.retentionDays); setDraft(String(h.retentionDays)); }, () => {});
  }, []);
  const n = Number(draft);
  const valid = Number.isInteger(n) && n >= 1;
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (valid && await act('/ui/api/usage-history/retention', { days: n }, `Usage history kept for ${n} ${n === 1 ? 'day' : 'days'}`)) setDays(n);
  };
  return (
    <Panel title="Usage history" icon={History} fold="usage.history" bodyClassName="space-y-2">
      <p className="text-xs text-muted-foreground">
        Every reading of every usage source is kept, for the Dashboard's usage graph. Readings older than this are deleted.
      </p>
      {days === null ? <Empty>loading</Empty> : (
        <form className="flex items-center gap-2 text-sm" onSubmit={save}>
          <label htmlFor="history-retention">Keep for</label>
          <Input id="history-retention" type="number" min={1} step={1} inputMode="numeric" className="h-8 w-24" value={draft} disabled={!canSet}
            onChange={(e) => setDraft(e.target.value)} />
          <span>days</span>
          {canSet && <Button type="submit" size="sm" variant="secondary" disabled={!valid || n === days}>Save</Button>}
        </form>
      )}
    </Panel>
  );
}

const GB = 1e9;

/**
 * The memory alert (issue #868): a person is told when a machine's free memory stays under a threshold — Windows' own for
 * a WSL machine, else memory available. Off until an admin sets it.
 */
function MemoryAlertPanel() {
  const canSet = useHopper((s) => allows(s.user, 'admin'));
  const [alert, setAlert] = useState<MemoryAlert | null | undefined>(undefined);
  const [gbDraft, setGbDraft] = useState('');
  const [minDraft, setMinDraft] = useState('');
  const show = (a: MemoryAlert | null) => { setAlert(a); setGbDraft(a ? String(a.freeBytes / GB) : '5'); setMinDraft(a ? String(a.minutes) : '5'); };
  useEffect(() => {
    get<MachineHistory>('/api/machines/history?range=24h').then((h) => show(h.memoryAlert ?? null), () => {});
  }, []);
  const gb = Number(gbDraft);
  const minutes = Number(minDraft);
  const valid = gb > 0 && Number.isInteger(minutes) && minutes >= 0 && minutes <= 1440;
  const save = async (next: MemoryAlert | null) => {
    const done = next ? `Memory alert under ${next.freeBytes / GB} GB free for ${next.minutes} min` : 'Memory alert off';
    if (await act('/ui/api/machines/memory-alert', { alert: next }, done)) show(next);
  };
  return (
    <Panel title="Memory alert" icon={MemoryStick} fold="usage.memory-alert" bodyClassName="space-y-2">
      <p className="text-xs text-muted-foreground">
        Tells you (webhooks and notifiers) when a machine's free memory stays low. On a machine in WSL, this is the free memory of Windows,
        not of the Linux VM: the VM keeps its page cache, which Windows cannot use.
      </p>
      {alert === undefined ? <Empty>loading</Empty> : (
        <form className="flex flex-wrap items-center gap-2 text-sm" onSubmit={(e) => { e.preventDefault(); if (valid) void save({ freeBytes: Math.round(gb * GB), minutes }); }}>
          <label htmlFor="memory-alert-gb">Under</label>
          <Input id="memory-alert-gb" type="number" min={0.1} step={0.1} inputMode="decimal" className="h-8 w-20" value={gbDraft} disabled={!canSet}
            onChange={(e) => setGbDraft(e.target.value)} />
          <label htmlFor="memory-alert-min">GB free for</label>
          <Input id="memory-alert-min" type="number" min={0} max={1440} step={1} inputMode="numeric" className="h-8 w-20" value={minDraft} disabled={!canSet}
            onChange={(e) => setMinDraft(e.target.value)} />
          <span>min</span>
          {canSet && <Button type="submit" size="sm" variant="secondary" disabled={!valid}>{alert ? 'Save' : 'Turn on'}</Button>}
          {canSet && alert && <Button type="button" size="sm" variant="ghost" onClick={() => void save(null)}>Turn off</Button>}
          {!alert && <span className="text-xs text-muted-foreground">off</span>}
        </form>
      )}
    </Panel>
  );
}

export function Usage() {
  const usage = useHopper((s) => s.usage);
  const accounts = useHopper((s) => s.accounts);
  usePoll(refreshUsage, 30_000);
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {usage && <UsageLimits usage={usage} />}
      <MachinesResourcesPanel className="lg:col-span-2" />
      <div className="space-y-3">
        <Accounts accounts={accounts} />
        {usage && <LaneEffect usage={usage} />}
        <HistoryRetention />
        <MemoryAlertPanel />
      </div>
      <div className="space-y-3">{usage ? <Sources usage={usage} /> : <Panel title="Usage" icon={GaugeIcon}><Empty>loading</Empty></Panel>}</div>
    </div>
  );
}
