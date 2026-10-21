// Topology → its sources (issue #1943, design.md "The infrastructure topology"). With no source, the page says why — the
// vault mints for no AWS account or Kubernetes cluster, or it does and no read reported yet, and no read-only check
// reported one — and offers what fills it in place: add an AWS account or a cluster (the vault's own form, Mints for
// filled in; an admin's), and Discover now once the vault mints for one. Each source whose last read failed shows its
// error. Discover now (issue #1781 part 3) asks the hopper to read every account and cluster its vault mints for, as its
// schedule does.
import { AlertTriangle, Cloud, Plus, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { post } from '@/lib/api';
import { sourceName } from '@/model/topology';
import type { Asset } from '@/model/wire';
import { sendVault, useVault, useVaultStore } from '@/store/vault';
import { useCanAdmin } from '@/store/selectors';
import { SetForm } from './vault';
import type { SourceView, TopologyGraph } from '../../../src/domain/types.ts';

/** What Discover now answers: how the run ended, and the graph after it. */
type Discovered = { state: string; error?: string; graph: TopologyGraph };

/** Discover now: the hopper's own read of every account and cluster its vault mints for, with what it said. */
export function DiscoverNow({ onGraph }: { onGraph: (g: TopologyGraph) => void }) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; words: string } | undefined>();
  const discover = async () => {
    setBusy(true); setSaid(undefined);
    try {
      const r = await post<Discovered>('/ui/api/topology/discover', {});
      onGraph(r.graph);
      setSaid(r.state === 'done' ? { ok: true, words: 'Discovery read every account and cluster the vault mints for.' }
        : { ok: false, words: `Discovery goes on in the background${r.error ? `: ${r.error}` : ''}.` });
    } catch (e) {
      setSaid({ ok: false, words: `Discovery did not run: ${(e as Error).message}` });
    } finally { setBusy(false); }
  };
  return (
    <div data-slot="topology-discover" className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" disabled={busy} onClick={() => { void discover(); }}><RefreshCw />{busy ? 'Discovering…' : 'Discover now'}</Button>
      {said && <span role="status" className={`text-xs ${said.ok ? 'text-muted-foreground' : 'text-warn'}`}>{said.words}</span>}
    </div>
  );
}

const ADD: Record<Extract<Asset['kind'], 'aws-account' | 'cluster'>, string> = { 'aws-account': 'Add an AWS account', cluster: 'Add a cluster' };

/** No topology source yet: why, and what fills it, in place. `onGraph` absent: no Discover now. */
export function NoSources({ onGraph }: { onGraph?: (g: TopologyGraph) => void }) {
  const can = useCanAdmin();
  const view = useVault();
  const busy = useVaultStore((s) => s.busy);
  const [adding, setAdding] = useState<keyof typeof ADD | undefined>();
  const minting = (view?.secrets ?? []).flatMap((s) => (s.mints ? [`${s.mints.kind}/${s.mints.name}`] : []));
  const local = view !== null && view.problem === undefined;
  const backends = view?.backends ?? [];
  const why = view === null
    ? 'The hopper has no source to read yet: no AWS account or Kubernetes cluster with read access, and no read-only check reported a source.'
    : minting.length === 0
      ? 'The vault mints for no AWS account and no Kubernetes cluster, so the hopper has nothing to read. And no read-only check reported a source.'
      : `The vault mints for ${minting.join(', ')}, but no read reported yet. Discover now reads them now; else the hopper's schedule reads them soon.`;
  return (
    <div data-slot="topology-empty" className="space-y-3 rounded-md border border-dashed p-4 text-sm">
      <p className="flex items-center gap-2 font-medium"><Cloud className="size-4" />No topology yet</p>
      <p className="text-muted-foreground">{why}</p>
      {onGraph && (view === null || minting.length > 0) && <DiscoverNow onGraph={onGraph} />}
      {can ? (
        <div className="flex flex-wrap gap-2">
          {(Object.keys(ADD) as (keyof typeof ADD)[]).map((k) => (
            <Button key={k} size="sm" variant={adding === k ? 'secondary' : 'outline'} disabled={busy || (!local && backends.length === 0)} onClick={() => setAdding(k)}><Plus />{ADD[k]}</Button>
          ))}
        </div>
      ) : <p className="text-muted-foreground">An admin adds an AWS account or a cluster on <a href="#vault" className="underline">Vault</a>.</p>}
      {adding && (
        <div className="rounded-md border p-3">
          <p className="mb-2 text-xs text-muted-foreground">{adding === 'aws-account'
            ? 'A minting credential for an AWS account: its account id after aws-account/, and its keys as JSON. The hopper reads the account as the read role hopper-read, and never gives the credential out.'
            : 'A minting credential for a Kubernetes cluster: its name after cluster/. A cluster in an AWS account the vault mints for needs none: discovery finds it there.'}</p>
          <SetForm key={adding} mintsFor={`${adding}/`} backends={backends} local={local} busy={busy} send={sendVault} onDone={() => setAdding(undefined)} />
        </div>
      )}
      <p className="text-xs text-muted-foreground">A read-only check can report sources too: POST /ui/api/topology/report, with an API token with the scope topology:report.</p>
    </div>
  );
}

/** Each source whose last read failed, with its error; nothing when every last read went through. */
export function ReadErrors({ sources }: { sources: readonly SourceView[] }) {
  const failed = sources.filter((s) => !s.lastRead.ok);
  if (failed.length === 0) return null;
  return (
    <div data-slot="topology-read-errors" role="alert" className="space-y-1 rounded-md border border-bad/40 bg-bad/5 p-3 text-xs text-bad">
      <p className="flex items-center gap-2 font-medium"><AlertTriangle className="size-4" />{failed.length === 1 ? 'One source' : `${failed.length} sources`}: the last read failed</p>
      <ul className="space-y-0.5">
        {failed.map((s) => <li key={s.key} className="break-words"><span className="font-medium">{sourceName(s)}</span>, at {s.lastRead.at}: {s.lastRead.error ?? 'no reason given'}</li>)}
      </ul>
    </div>
  );
}
