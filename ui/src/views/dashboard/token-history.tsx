// The Dashboard's tokens over time (issue #2302, design.md "The token ledger"), beside the usage graph: the token ledger
// by UTC day over the last 30 days, stacked by repository or account — GET /api/usage/tokens?by=day&split=…, read again
// every five minutes. Its total is the ledger's for the same days, so the stacks reconcile with the job ledger. Counts only.
import { Coins } from 'lucide-react';
import { useCallback, useState } from 'react';
import { TokenDaysChart } from '@/charts/token-days';
import { Empty, Panel } from '@/components/panel';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { usePoll } from '@/hooks/use-poll';
import { get } from '@/lib/api';
import { TOKEN_SPLITS, type TokenSplit } from '@/model/dashboard-layout';
import { tokenDays, tokenLine, tokensOf, usd, tokenCount } from '@/model/token-ledger';
import type { TokenRollupRow, TokenTotals } from '@/model/wire';

const DAYS = 30;
const DAY = 86_400_000;
const SPLIT_NAMES: Record<TokenSplit, string> = { repo: 'Repository', account: 'Account' };

interface ByDay { total: TokenTotals; groups: TokenRollupRow[] }

/** `split` is the dashboard layout's; choosing another on the panel sets it there. */
export function TokenHistoryPanel({ split, onSplit }: { split: TokenSplit; onSplit: (s: TokenSplit) => void }) {
  const [read, setRead] = useState<{ split: TokenSplit; data: ByDay } | null>(null);
  const today = new Date().toISOString().slice(0, 10);
  const since = new Date(Date.parse(`${today}T00:00:00.000Z`) - (DAYS - 1) * DAY).toISOString().slice(0, 10);
  const load = useCallback(
    () => get<ByDay>(`/api/usage/tokens?${new URLSearchParams({ by: 'day', split, since })}`).then((data) => { if (data?.groups) setRead({ split, data }); }),
    [split, since],
  );
  usePoll(load, 5 * 60_000);
  const data = read?.split === split ? read.data : null;
  const { days, stacks } = tokenDays(data?.groups ?? [], DAYS, today);
  return (
    <Panel title="Tokens over time" icon={Coins} count={`${DAYS} d`} action={
      <Tabs value={split} onValueChange={(v) => onSplit(v as TokenSplit)}>
        <TabsList className="h-7">{TOKEN_SPLITS.map((s) => <TabsTrigger key={s} value={s} className="px-2 text-xs">{SPLIT_NAMES[s]}</TabsTrigger>)}</TabsList>
      </Tabs>
    }>
      {data === null ? <Empty>Loading…</Empty> : tokensOf(data.total) === 0 ? (
        <Empty>No token use in the last {DAYS} days. The hopper reads it from each job&apos;s agent session at its checkpoints and as its run ends.</Empty>
      ) : (
        <div className="grid gap-2">
          <div data-slot="token-history-total" className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{tokenCount(tokensOf(data.total))} tokens · {usd(data.total)}</span> estimated · {tokenLine(data.total)}
          </div>
          <TokenDaysChart days={days} stacks={stacks} />
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {stacks.map((s) => (
              <span key={s.key} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className="size-2 rounded-sm" style={{ background: s.color }} /><span data-slot="token-history-stack">{s.key}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}
