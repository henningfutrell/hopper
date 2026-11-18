// The claude-analytics usage source's panel on Usage (issue #2966, design.md "Daily usage from the Analytics API"): daily
// usage of Claude Enterprise seats, one row per matched account (cost, tokens, sessions, commits, pull requests, lines),
// labelled daily and one day late; "no account matched" for each account no user of the organization matched; the "analytics
// key not configured" state with its steps; the trend of the kept days (part 4, GET /api/usage/daily?days=30), stacked by
// account. Under it, the Claude Analytics API key: its status for everyone
// (GET /api/claude-analytics-key), and for an admin a write-only form that sets or removes it (POST /ui/api/claude-analytics-key).
import { KeyRound } from 'lucide-react';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { TokenDaysChart } from '@/charts/token-days';
import { Empty } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { usePoll } from '@/hooks/use-poll';
import { get, post } from '@/lib/api';
import { saveError } from '@/model/access-status';
import { dailyTrend, dayFacts } from '@/model/daily-usage';
import { tokenCount } from '@/model/token-ledger';
import { keyStatus } from '@/model/minor-decisions';
import type { AnalyticsKeyView, DailyUsageTrend, UsageSourceReport } from '@/model/wire';
import { useCanAdmin } from '@/store/selectors';

/** A source that reads daily usage: the claude-analytics source, read or not configured yet. */
export const readsDailyUsage = (s: UsageSourceReport): boolean => s.daily !== undefined || s.notConfigured !== undefined || s.informational === true;

export function DailyUsageView({ source }: { source: UsageSourceReport }) {
  const read = source.daily;
  return (
    <div className="grid gap-2" data-slot="usage-daily">
      {source.notConfigured && <p className="text-xs text-warn break-words" data-slot="usage-daily-not-configured">{source.notConfigured}</p>}
      {read ? (
        <>
          <p className="text-xs text-muted-foreground" data-slot="usage-daily-label">Daily, one day late: {read.date} (UTC), from the Analytics API.</p>
          {read.days.length ? (
            <ul className="grid gap-2">
              {read.days.map((d) => {
                const f = dayFacts(d);
                return (
                  <li key={d.account} className="grid gap-0.5 border-b pb-2 text-sm last:border-b-0 last:pb-0" data-slot="usage-daily-row">
                    <div className="flex flex-wrap items-baseline gap-x-2"><span className="min-w-0 truncate font-medium">{d.account}</span>
                      <span className="num font-semibold">{f.cost}</span><span className="num text-muted-foreground">{f.tokens}</span></div>
                    <div className="num text-xs text-muted-foreground">{f.work}</div>
                  </li>
                );
              })}
            </ul>
          ) : <Empty>no matched account used Claude Code on {read.date}</Empty>}
          {read.unmatched.length > 0 && (
            <ul className="grid gap-0.5 text-xs text-muted-foreground" data-slot="usage-daily-unmatched">
              {read.unmatched.map((a) => <li key={a}>{a}: no account matched</li>)}
            </ul>
          )}
        </>
      ) : !source.notConfigured && <Empty>no daily usage read yet</Empty>}
      <DailyTrendChart />
      <AnalyticsKeyField />
    </div>
  );
}

const TREND_DAYS = 30;

/** The kept days of daily usage, the last 30 up to yesterday, stacked by account: read again every 10 minutes. */
function DailyTrendChart() {
  const [trend, setTrend] = useState<DailyUsageTrend | undefined>();
  const load = useCallback(async () => {
    const t = await get<DailyUsageTrend>(`/api/usage/daily?days=${TREND_DAYS}`).catch(() => undefined);
    if (t && Array.isArray(t.daily)) setTrend(t);
  }, []);
  usePoll(load, 10 * 60_000);
  if (!trend) return null;
  const { days, stacks } = dailyTrend(trend.daily, trend.days, trend.to);
  const cost = trend.daily.reduce((n, d) => n + d.costCents, 0) / 100;
  const tokens = days.reduce((n, d) => n + d.tokens, 0);
  return (
    <div className="grid gap-2 border-t pt-2" data-slot="usage-daily-trend">
      <p className="text-xs text-muted-foreground">
        Trend, {trend.days} days to {trend.to} (UTC): <span className="num font-medium text-foreground">${cost.toFixed(2)} · {tokenCount(tokens)} tokens</span>
      </p>
      {trend.daily.length === 0 ? <Empty>No day kept yet: the trend fills one day at each read of the Analytics API.</Empty> : (
        <>
          <TokenDaysChart days={days} stacks={stacks} height={160} />
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {stacks.map((st) => (
              <span key={st.key} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className="size-2 rounded-sm" style={{ background: st.color }} /><span>{st.key}</span>
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** The Claude Analytics API key: write-only. The value typed is sent once and cleared; it is never shown again. */
function AnalyticsKeyField() {
  const canAdmin = useCanAdmin();
  const [k, setK] = useState<AnalyticsKeyView | undefined>();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | undefined>();
  const load = useCallback(async () => { const v = await get<AnalyticsKeyView>('/api/claude-analytics-key'); if (v) setK(v); }, []);
  usePoll(load, 60_000);
  if (!k) return null;
  const send = async (body: Record<string, unknown>, done: string) => {
    setBusy(true);
    setFailed(undefined);
    try {
      setK(await post<AnalyticsKeyView>('/ui/api/claude-analytics-key', body));
      toast.success(done);
      setValue('');
    } catch (e) {
      const why = saveError((e as Error).message);
      setFailed(why);
      toast.error(why);
    }
    setBusy(false);
  };
  return (
    <div className="space-y-2 border-t pt-2" data-slot="usage-analytics-key">
      <div className="flex items-center gap-2 text-sm font-medium"><KeyRound className="size-4" />Claude Analytics API key</div>
      <p className="text-sm" data-slot="usage-analytics-key-status">{keyStatus(k)}</p>
      {k.problem && <p className="text-xs text-destructive">{k.problem}</p>}
      {canAdmin && (
        <div className="flex flex-wrap items-center gap-2">
          <Input type="password" autoComplete="off" spellCheck={false} className="h-8 w-80" aria-label="Claude Analytics API key"
            placeholder={k.set ? 'a new key, to replace it' : 'paste the key'} value={value} disabled={busy} onChange={(e) => setValue(e.target.value)} />
          <Button size="sm" disabled={busy || !value.trim()} onClick={() => void send({ action: 'set', value }, 'Claude Analytics API key checked and saved')}>{k.set ? 'Replace' : 'Save'}</Button>
          {k.set && <Button size="sm" variant="outline" disabled={busy} onClick={() => void send({ action: 'remove' }, 'Claude Analytics API key removed')}>Remove</Button>}
        </div>
      )}
      {failed && <p className="text-xs text-destructive" data-slot="usage-analytics-key-failed">{failed}</p>}
    </div>
  );
}
