// The telemetry summary (issue #1486, design.md "Telemetry summary") on the Resources page: the slowest actions, how long
// each kind of job span lasts, and the GitHub calls by route, from GET /api/telemetry. Read when shown and every
// `everyMs` while the page is open; a read the daemon refuses says why, and the rest of the page still shows.
import { Activity, AlertTriangle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Empty, Panel } from '@/components/panel';
import { get } from '@/lib/api';
import { exportText, githubTotalText, msText } from '@/model/telemetry';
import type { GitHubUseStat, TelemetrySummary as Summary, TimingStat } from '@/model/wire';

type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ok'; data: Summary };

function useSummary(everyMs: number): Load {
  const [state, setState] = useState<Load>({ kind: 'loading' });
  useEffect(() => {
    let live = true;
    const read = () => {
      if (document.visibilityState === 'hidden') return;
      get<Summary>('/api/telemetry').then((data) => { if (live) setState({ kind: 'ok', data }); }, (e: Error) => { if (live) setState({ kind: 'error', message: e.message }); });
    };
    read();
    const timer = setInterval(read, everyMs);
    return () => { live = false; clearInterval(timer); };
  }, [everyMs]);
  return state;
}

const TH = 'py-1 pr-3 text-right font-normal';
const TD = 'num py-1 pr-3 text-right';

function Timings({ slot, title, first, stats, empty }: { slot: string; title: string; first: string; stats: TimingStat[]; empty: string }) {
  return (
    <div className="space-y-1">
      <h3 className="text-xs font-medium uppercase text-muted-foreground">{title}</h3>
      {stats.length === 0 ? <p className="text-xs text-muted-foreground">{empty}</p> : (
        <div className="overflow-x-auto">
          <table data-slot={slot} className="w-full text-left text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr><th className="py-1 pr-3 font-normal">{first}</th><th className={TH}>Count</th><th className={TH}>Mean</th><th className={TH}>p95</th><th className={TH}>Max</th></tr>
            </thead>
            <tbody>
              {stats.map((s) => (
                <tr key={s.name} className="border-t">
                  <td className="py-1 pr-3 break-all font-mono text-xs">{s.name}</td><td className={TD}>{s.count}</td>
                  <td className={TD}>{msText(s.meanMs)}</td><td className={TD}>{msText(s.p95Ms)}</td><td className={TD}>{msText(s.maxMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function GitHubUse({ stats }: { stats: GitHubUseStat[] }) {
  if (stats.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <table data-slot="telemetry-github" className="w-full text-left text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr><th className="py-1 pr-3 font-normal">Route</th><th className={TH}>Calls</th><th className={TH}>From the cache</th><th className={TH}>Errors</th><th className={TH}>Mean</th><th className={TH}>p95</th></tr>
        </thead>
        <tbody>
          {stats.map((s) => (
            <tr key={s.name} className="border-t">
              <td className="py-1 pr-3 break-all font-mono text-xs">{s.name}</td><td className={TD}>{s.count}</td><td className={TD}>{s.cacheHits}</td>
              <td className={TD}>{s.errors}</td><td className={TD}>{msText(s.meanMs)}</td><td className={TD}>{msText(s.p95Ms)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TelemetrySummary({ everyMs }: { everyMs: number }) {
  const state = useSummary(everyMs);
  return (
    <Panel title="Telemetry" icon={Activity}>
      <div data-slot="telemetry-summary" className="space-y-4">
        {state.kind === 'loading' ? <Empty>Reading the telemetry…</Empty>
          : state.kind === 'error' ? (
            <div className="flex items-start gap-2 rounded-md border border-warn/40 bg-warn/5 p-3 text-sm">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" /><span className="break-words">The telemetry summary cannot be read: {state.message}</span>
            </div>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">{exportText(state.data.exporting)} Times are over the last samples of each; counts are since the start.</p>
              <Timings slot="telemetry-actions" title="Slowest actions" first="Action" stats={state.data.actions} empty="No action yet." />
              <Timings slot="telemetry-job-spans" title="Job spans" first="Job span" stats={state.data.jobSpans} empty="No job span ended yet." />
              <div className="space-y-1">
                <h3 className="text-xs font-medium uppercase text-muted-foreground">GitHub use</h3>
                <p className="text-xs text-muted-foreground">{githubTotalText(state.data)}</p>
                <GitHubUse stats={state.data.github} />
              </div>
            </>
          )}
      </div>
    </Panel>
  );
}
