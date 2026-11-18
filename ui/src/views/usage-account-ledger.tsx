// A usage source with no usage limits (issue #2966): an Enterprise plan, or one the source is told has none (issue #2932),
// gives no session or weekly window to show. Its panel shows the account's token ledger in their place: tokens and the
// estimated cost today and over 7 days, and the last 30 days (GET /api/usage/tokens?by=day&split=account, read again every five
// minutes). Only the jobs the hopper ran, at list price: not the billed cost, and not other work on the same account.
import { useCallback, useState } from 'react';
import { TokenDaysChart } from '@/charts/token-days';
import { Empty } from '@/components/panel';
import { usePoll } from '@/hooks/use-poll';
import { get } from '@/lib/api';
import { accountLedger, tokenCount, usd, type TokenSum } from '@/model/token-ledger';
import type { TokenRollupRow } from '@/model/wire';

const DAYS = 30;
const DAY = 86_400_000;

/** The ledger by day split by account, for the last 30 UTC days; read only while `on` (a source has no usage limits). */
export function useAccountDays(on: boolean): { today: string; groups: TokenRollupRow[] | null } {
  const [groups, setGroups] = useState<TokenRollupRow[] | null>(null);
  const today = new Date().toISOString().slice(0, 10);
  const since = new Date(Date.parse(`${today}T00:00:00.000Z`) - (DAYS - 1) * DAY).toISOString().slice(0, 10);
  const load = useCallback(async () => {
    if (!on) return;
    const data = await get<{ groups?: TokenRollupRow[] }>(`/api/usage/tokens?${new URLSearchParams({ by: 'day', split: 'account', since })}`);
    if (data?.groups) setGroups(data.groups);
  }, [on, since]);
  usePoll(load, 5 * 60_000);
  return { today, groups };
}

const sumText = (s: TokenSum): string => `${tokenCount(s.tokens)} tokens · ${usd(s)}`;

/** The account's token ledger on its usage source's panel. `account`: who the source reads; absent, not known yet. */
export function AccountLedgerView({ account, today, groups }: { account: string | undefined; today: string; groups: TokenRollupRow[] | null }) {
  if (!account) return <Empty>no usage limits; the account is not known yet, so its token ledger cannot be shown</Empty>;
  if (groups === null) return <Empty>Loading…</Empty>;
  const ledger = accountLedger(groups, account, DAYS, today);
  return (
    <div className="grid gap-2" data-slot="usage-account-ledger">
      <div className="grid grid-cols-2 gap-2">
        <div><div className="num text-lg font-semibold" data-slot="usage-account-today">{sumText(ledger.today)}</div><div className="text-xs text-muted-foreground">today (UTC)</div></div>
        <div><div className="num text-lg font-semibold" data-slot="usage-account-week">{sumText(ledger.week)}</div><div className="text-xs text-muted-foreground">last 7 days</div></div>
      </div>
      {ledger.days.some((d) => d.tokens > 0) ? <TokenDaysChart days={ledger.days} stacks={ledger.stacks} height={140} />
        : <Empty>no token use by the hopper&apos;s jobs on this account in the last {DAYS} days</Empty>}
      <p className="text-xs text-muted-foreground" data-slot="usage-account-note">
        No usage limits: estimated from the hopper&apos;s own jobs (list prices). Work outside the hopper on this account is not counted, and this is not the billed cost.
      </p>
    </div>
  );
}
