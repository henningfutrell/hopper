// Usage: who each part acts as (accounts), every usage reading by source, and what usage does to
// each machine's lanes now (design.md "Usage and accounts (issue #18)"). Read-only.
import { Gauge as GaugeIcon, Layers, UserRound } from 'lucide-react';
import { Empty, Panel } from '@/components/panel';
import { ReadingGauge } from '@/components/reading';
import { StatusBadge, type Tone } from '@/components/status';
import { useNow } from '@/hooks/use-now';
import { usePoll } from '@/hooks/use-poll';
import { accountFacts, executorEffectLines, laneEffectText, orderReadings, serviceLabel, sourceLine } from '@/model/usage';
import type { MachineLaneEffect, PartAccount, UsageReport } from '@/model/wire';
import { refreshUsage, useHopper } from '@/store';

const pct = (f: number) => `${Math.round(f * 100)}%`;
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
    <Panel title="Accounts" icon={UserRound} count={accounts.length || ''}>
      {accounts.length ? <ul className="divide-y">{accounts.map((a) => <AccountRow key={`${a.role}/${a.instance}`} a={a} />)}</ul>
        : <Empty>no part reports an account</Empty>}
    </Panel>
  );
}

function LaneEffect({ usage }: { usage: UsageReport }) {
  const { soft, hard } = usage.limits;
  return (
    <Panel title="Lane effect" icon={Layers} bodyClassName="space-y-3">
      <p className="text-xs text-muted-foreground">
        Past <span className="num text-foreground">{pct(soft)}</span> of a throttling budget the lane cap scales down; at <span className="num text-foreground">{pct(hard)}</span> lanes stop.
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
                {[soft, hard].map((x) => <div key={x} className="absolute top-0 h-full w-0.5 bg-background" style={{ left: pct(x) }} />)}
              </div>
              <div className="num text-xs text-muted-foreground">{pct(m.usedFrac)} used · {laneEffectText(m)}</div>
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
          <Panel key={s.name} title={s.name} icon={GaugeIcon} count={readings.length || ''} bodyClassName="space-y-3">
            <div className={`text-xs break-words ${line.problem ? 'text-warn' : 'text-muted-foreground'}`}>{line.text}</div>
            {readings.length ? <div className="flex flex-wrap justify-around gap-x-2 gap-y-4">{readings.map((r) => <ReadingGauge key={`${r.window ?? ''}|${r.machineId ?? ''}`} r={r} now={now} />)}</div>
              : <Empty>no readings now</Empty>}
          </Panel>
        );
      })}
    </>
  );
}

export function Usage() {
  const usage = useHopper((s) => s.usage);
  const accounts = useHopper((s) => s.accounts);
  usePoll(refreshUsage, 30_000);
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <div className="space-y-3">
        <Accounts accounts={accounts} />
        {usage && <LaneEffect usage={usage} />}
      </div>
      <div className="space-y-3">{usage ? <Sources usage={usage} /> : <Panel title="Usage" icon={GaugeIcon}><Empty>loading</Empty></Panel>}</div>
    </div>
  );
}
