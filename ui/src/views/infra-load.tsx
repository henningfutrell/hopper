// One read for the Infra and Topology pages (issues #896, #1943): its state — loading, failed (and why), or its answer —
// and the line a panel shows until the answer is in: loading, or the error with Try again.
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Empty } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { get } from '@/lib/api';
import { setPolled } from '@/store/polled';

export type Load<T> = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ok'; data: T };

/** One read, with its state: loading, failed (and why), or its answer; `reload` reads again. No path: nothing to read yet, still loading. Each answer, and each change
 *  to it (an approve, a mark), is also the shared one, so the nav badge and Needs you change with the page (issue #1193). */
export function useLoad<T>(path: string | undefined): [Load<T>, (f: (d: T) => T) => void, () => void] {
  const [state, setState] = useState<Load<T>>({ kind: 'loading' });
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (path === undefined) return;
    let live = true;
    get<T>(path).then((data) => { if (live) setState({ kind: 'ok', data }); }, (e: Error) => { if (live) setState({ kind: 'error', message: e.message }); });
    return () => { live = false; };
  }, [path, round]);
  useEffect(() => { if (path !== undefined && state.kind === 'ok') setPolled(path, state.data); }, [path, state]);
  const change = useCallback((f: (d: T) => T) => setState((s) => (s.kind === 'ok' ? { kind: 'ok', data: f(s.data) } : s)), []);
  return [state, change, () => { setState({ kind: 'loading' }); setRound((n) => n + 1); }];
}

/** Loading, or the error with Try again; nothing when the answer is in. */
export function NotYet({ state, what, retry }: { state: Load<unknown>; what: string; retry: () => void }) {
  if (state.kind === 'loading') return <Empty>Loading {what}…</Empty>;
  if (state.kind === 'error') {
    return (
      <div data-slot="infra-error" className="flex flex-wrap items-center gap-2 rounded-md border border-bad/40 bg-bad/5 p-3 text-sm text-bad">
        <AlertTriangle className="size-4" /><span className="break-words">The {what} cannot be read: {state.message}</span>
        <Button size="sm" variant="outline" className="ml-auto" onClick={retry}><RefreshCw />Try again</Button>
      </div>
    );
  }
  return null;
}
