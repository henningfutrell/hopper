// Resources (issue #947, design.md "Stack resources"): what every container of the hopper's stack and each of its sandbox
// boxes uses now — by its service: CPU, memory against its limit, network, disk, restarts and uptime —, and what its
// Postgres and OpenFGA do. Read from GET /api/resources when the page opens and every READ_EVERY_MS while it is shown; a part
// that cannot be read says why. The machines' own resources over time are on Usage and Machines (issue #560).
import { AlertTriangle, Boxes, Container, Database, RefreshCw, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Empty, Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { get } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  containerTone, cpuText, diskText, memoryFrac, memoryText, networkText, openFgaLines, postgresLines, restartsText, uptimeText, volumesText,
} from '@/model/stack-resources';
import type { ContainerReading, StackResources } from '@/model/wire';
import { useServerNow } from '@/store/selectors';

/** CPU is the use since the read before: a read this often keeps it current. */
const READ_EVERY_MS = 10_000;

type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ok'; data: StackResources };

function useResources(): [Load, () => void] {
  const [state, setState] = useState<Load>({ kind: 'loading' });
  const [round, setRound] = useState(0);
  useEffect(() => {
    let live = true;
    const read = () => {
      if (document.visibilityState === 'hidden') return;
      get<StackResources>('/api/resources').then((data) => { if (live) setState({ kind: 'ok', data }); }, (e: Error) => { if (live) setState({ kind: 'error', message: e.message }); });
    };
    read();
    const timer = setInterval(read, READ_EVERY_MS);
    return () => { live = false; clearInterval(timer); };
  }, [round]);
  return [state, () => { setState({ kind: 'loading' }); setRound((n) => n + 1); }];
}

const TONE = { ok: 'text-ok', warn: 'text-warn', bad: 'text-bad' } as const;

function Metric({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="num break-words text-sm">{children}</div>
    </div>
  );
}

function ContainerRow({ c, now }: { c: ContainerReading; now: number }) {
  const mem = memoryFrac(c);
  const volumes = volumesText(c);
  return (
    <li data-slot="container-row" className="space-y-2 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-medium">{c.service}</span>
        <span className={cn('text-xs', TONE[containerTone(c)])}>{c.health ? `${c.state}, ${c.health}` : c.state}</span>
        <span className="text-xs text-muted-foreground">{uptimeText(c, now)}</span>
        <span className="text-xs text-muted-foreground">{restartsText(c)}</span>
        <span className="ml-auto truncate text-xs text-muted-foreground" title={`${c.name} · ${c.image}`}>{c.image}</span>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <Metric label="CPU">{cpuText(c)}</Metric>
        <Metric label="Memory">
          {memoryText(c)}
          {mem !== undefined && (
            <div className="mt-1 h-1 rounded-full bg-muted"><div className={cn('h-1 rounded-full', mem > 0.9 ? 'bg-bad' : mem > 0.75 ? 'bg-warn' : 'bg-ok')} style={{ width: `${mem * 100}%` }} /></div>
          )}
        </Metric>
        <Metric label="Network">{networkText(c)}</Metric>
        <Metric label="Disk">{diskText(c)}</Metric>
      </div>
      {volumes && <div className="text-xs text-muted-foreground">Volumes: <span className="num">{volumes}</span></div>}
    </li>
  );
}

function Problem({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-warn/40 bg-warn/5 p-3 text-sm">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" /><span className="break-words">{children}</span>
    </div>
  );
}

function Lines({ slot, lines }: { slot: string; lines: { label: string; text: string }[] }) {
  return (
    <dl data-slot={slot} className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
      {lines.map((l) => (
        <div key={l.label} className="min-w-0">
          <dt className="text-[11px] text-muted-foreground">{l.label}</dt>
          <dd className="num break-words text-sm">{l.text}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Resources() {
  const now = useServerNow();
  const [state, reload] = useResources();
  if (state.kind === 'loading') return <div className="max-w-4xl"><Empty>Reading the stack…</Empty></div>;
  if (state.kind === 'error') {
    return (
      <div data-slot="resources-error" className="flex max-w-4xl flex-wrap items-center gap-2 rounded-md border border-bad/40 bg-bad/5 p-3 text-sm text-bad">
        <AlertTriangle className="size-4" /><span className="break-words">The stack resources cannot be read: {state.message}</span>
        <Button size="sm" variant="outline" className="ml-auto" onClick={reload}><RefreshCw />Try again</Button>
      </div>
    );
  }
  const { containers, postgres, openfga } = state.data;
  const list = 'containers' in containers ? containers.containers : [];
  const stack = list.filter((c) => c.group === 'stack');
  const boxes = list.filter((c) => c.group === 'sandbox');
  return (
    <div className="max-w-4xl space-y-3">
      <p className="text-sm text-muted-foreground">What each part of the hopper&apos;s stack uses now, by its service. CPU is the use since the read before; the page reads again every 10 seconds while it is open. Network and disk count since the container started; OpenFGA&apos;s checks count since it started.</p>
      <Panel title="Containers" icon={Container} count={stack.length || ''}>
        {'problem' in containers ? <Problem>{containers.problem}</Problem>
          : stack.length === 0 ? <Empty>No container of the hopper&apos;s compose project. A hopper on the computer itself has none.</Empty>
          : <ul className="divide-y">{stack.map((c) => <ContainerRow key={c.name} c={c} now={now} />)}</ul>}
      </Panel>
      {boxes.length > 0 && (
        <Panel title="Sandbox boxes" icon={Boxes} count={boxes.length}>
          <ul className="divide-y">{boxes.map((c) => <ContainerRow key={c.name} c={c} now={now} />)}</ul>
        </Panel>
      )}
      <Panel title="Postgres" icon={Database}>
        {'problem' in postgres ? <Problem>{postgres.problem}</Problem> : <Lines slot="postgres-reading" lines={postgresLines(postgres)} />}
      </Panel>
      <Panel title="OpenFGA" icon={ShieldCheck}>
        {'problem' in openfga ? <Problem>{openfga.problem}</Problem> : <Lines slot="openfga-reading" lines={openFgaLines(openfga)} />}
      </Panel>
    </div>
  );
}
