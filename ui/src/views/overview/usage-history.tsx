// The Overview's usage graph (issues #385, #502): every account's usage windows over time, one line each however
// many machines read the account, in one graph. The graph range is the user's, saved for them by the hopper.
import { UsageGraphCard } from '@/components/usage-graph-card';
import type { UsageGraphView, UsageHistory } from '@/model/wire';
import { act } from '@/store';

const seriesOf = (h: UsageHistory) => h.series;
const save = (view: UsageGraphView) => { void act('/ui/api/usage-history/view', view); };

export function UsageHistoryPanel() {
  return (
    <UsageGraphCard<UsageHistory> path="/api/usage/history" seriesOf={seriesOf} save={save} title="Usage over time"
      empty="No usage history in this range yet. Every usage source's readings are kept from now on, each time it reads." />
  );
}
