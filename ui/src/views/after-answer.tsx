// The work after each person's act (issue #1194, design.md "Actions answer at once"): an act answers first, and its slow
// work runs after, on a queue. Per act, how long that work waited on its queue apart from how long it ran, so a slow act
// shows whether it waited behind other work or was slow itself. Read from GET /api/sources when Sources opens, and again
// on a click; nothing when no act ran since the daemon started.
import { Timer } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { get } from '@/lib/api';
import { afterAnswerRows, ms } from '@/model/after-answer';
import { ago } from '@/model/format';
import type { AfterAnswerTiming } from '@/model/wire';
import { useServerNow } from '@/store/selectors';

export function AfterAnswer() {
  const now = useServerNow();
  const [timings, setTimings] = useState<AfterAnswerTiming[]>([]);
  const read = useCallback(() => {
    get<{ afterAnswer?: AfterAnswerTiming[] }>('/api/sources').then((r) => setTimings(r.afterAnswer ?? []), () => {});
  }, []);
  useEffect(read, [read]);
  if (!timings.length) return null;
  const rows = afterAnswerRows(timings);
  return (
    <Panel title="Work after an act" icon={Timer} count={rows.length} list
      action={<Button size="sm" variant="ghost" onClick={read}>Read again</Button>}>
      <div data-after-answer className="space-y-1 text-xs">
        <p className="text-muted-foreground">Each act answers first. Its slow work runs after: here, how long it waited on its queue, and how long it ran (p50 / p95).</p>
        <table className="w-full">
          <thead className="text-[11px] text-muted-foreground">
            <tr><th className="text-left font-normal">act</th><th className="text-right font-normal">runs</th><th className="text-right font-normal">wait</th><th className="text-right font-normal">run</th><th className="text-right font-normal">last</th></tr>
          </thead>
          <tbody className="num">
            {rows.map((r) => (
              <tr key={r.key} data-after-answer-act={r.name}>
                <td className="font-mono">{r.name}</td>
                <td className="text-right">{r.count}</td>
                <td className="text-right">{ms(r.wait.p50)} / {ms(r.wait.p95)}</td>
                <td className="text-right">{ms(r.run.p50)} / {ms(r.run.p95)}</td>
                <td className="text-right text-muted-foreground" title={r.lastAt}>{ago(r.lastAt, now)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
