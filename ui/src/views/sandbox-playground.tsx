// The sandbox playground on Machines (issue #1410, design.md "The sandbox playground"): start many sandboxes in one action
// (agent or template, how many, CPUs, memory, time limit), see each one's state, and destroy one, a selection or all.
// GET /api/sandbox-playground reads them; an admin starts them (POST /ui/api/sandbox-playground) and destroys them (POST
// /ui/api/sandbox-playground/destroy). A playground sandbox is no machine: it is not in the machines list and takes no lane.
import { useCallback, useEffect, useState } from 'react';
import { Boxes } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Empty, Panel } from '@/components/panel';
import { get } from '@/lib/api';
import { EMPTY_DRAFT, playgroundBody, playgroundStateText, type PlaygroundDraft } from '@/model/sandbox-playground';
import { allows } from '@/model/roles';
import type { PlaygroundView, TemplateView, VaultView } from '@/model/wire';
import { actFor, useHopper } from '@/store';

const POLL_MS = 3_000;

export function SandboxPlaygroundPanel() {
  const canAct = useHopper((s) => allows(s.user, 'admin'));
  const [view, setView] = useState<PlaygroundView | null | undefined>(undefined);
  const [templates, setTemplates] = useState<TemplateView[]>([]);
  const [draft, setDraft] = useState<PlaygroundDraft>(EMPTY_DRAFT);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // An answer that is no playground view hides the panel, as a failed read does (issue #1435).
  const read = useCallback(() => get<PlaygroundView>('/api/sandbox-playground')
    .then((v) => setView(Array.isArray(v?.sandboxes) ? v : null), () => setView(null)), []);
  useEffect(() => {
    void read();
    get<VaultView>('/api/vault').then((v) => setTemplates(Array.isArray(v?.templates) ? v.templates : []), () => setTemplates([]));
    const timer = setInterval(() => { void read(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [read]);

  if (view === undefined) return <Panel title="Sandbox playground" icon={Boxes}><Empty>loading</Empty></Panel>;
  if (view === null) return null;
  const body = playgroundBody(draft, view.limits);
  const set = (k: keyof PlaygroundDraft) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setDraft({ ...draft, [k]: e.target.value });
  const start = async () => {
    if (typeof body === 'string') return;
    if ((await actFor('/ui/api/sandbox-playground', body, `Starting ${body.count === 1 ? 'a sandbox' : `${body.count} sandboxes`}`)).ok) await read();
  };
  const destroy = async (ask: { ids: string[] } | { all: true }) => {
    if ((await actFor('/ui/api/sandbox-playground/destroy', ask, 'Destroyed')).ok) { setPicked(new Set()); await read(); }
  };
  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const { limits, running, sandboxes } = view;
  const now = new Date();

  return (
    <Panel title="Sandbox playground" icon={Boxes} count={sandboxes.length || undefined} bodyClassName="space-y-3">
      <p className="text-xs text-muted-foreground">
        Start many sandboxes at once to try things. A playground sandbox is not a machine: it takes no lane and gets no job.
        Each is destroyed with all its files when you destroy it, at its time limit, or when the hopper starts again.
        {' '}{running.all} of {limits.maxConcurrent} run now ({running.yours} of your {limits.maxPerUser}).
      </p>
      {view.problem && <p role="alert" className="text-xs text-warn">{view.problem}</p>}
      {canAct && (
        <form className="flex flex-wrap items-end gap-2 text-sm" onSubmit={(e) => { e.preventDefault(); void start(); }}>
          <label className="grid gap-1 text-xs">How many
            <Input type="number" min={1} step={1} className="h-8 w-20" value={draft.count} onChange={set('count')} />
          </label>
          <label className="grid gap-1 text-xs">Template
            <select className="h-8 rounded-md border bg-background px-2 text-sm" value={draft.template} onChange={set('template')}>
              <option value="">none (the claude box)</option>
              {templates.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-xs">CPUs
            <Input type="number" min={0.1} step={0.1} max={limits.max.cpus} className="h-8 w-20" placeholder={String(limits.defaults.cpus)} value={draft.cpus} onChange={set('cpus')} />
          </label>
          <label className="grid gap-1 text-xs">Memory (MiB)
            <Input type="number" min={1} step={1} max={limits.max.memoryMb} className="h-8 w-24" placeholder={String(limits.defaults.memoryMb)} value={draft.memoryMb} onChange={set('memoryMb')} />
          </label>
          <label className="grid gap-1 text-xs">Time limit (minutes)
            <Input type="number" min={1} step={1} max={limits.max.ttlMinutes} className="h-8 w-24" placeholder={String(limits.defaults.ttlMinutes)} value={draft.ttlMinutes} onChange={set('ttlMinutes')} />
          </label>
          <Button type="submit" size="sm" disabled={typeof body === 'string' || view.problem !== undefined}>Start</Button>
          {typeof body === 'string' && <span role="alert" className="text-xs text-destructive">{body}</span>}
        </form>
      )}
      {sandboxes.length === 0 ? <Empty>no playground sandboxes</Empty> : (
        <>
          {canAct && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={picked.size === 0} onClick={() => void destroy({ ids: [...picked] })}>Destroy selected ({picked.size})</Button>
              <Button size="sm" variant="destructive" onClick={() => void destroy({ all: true })}>Destroy all</Button>
            </div>
          )}
          <ul className="divide-y text-sm" data-slot="playground-sandboxes">
            {sandboxes.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2 py-1.5">
                {canAct && <input type="checkbox" aria-label={`Select ${s.name}`} checked={picked.has(s.id)} onChange={() => toggle(s.id)} />}
                <span className="font-mono text-xs">{s.name}</span>
                <span className="text-xs text-muted-foreground">{s.template ?? s.agent} · {s.size.cpus} CPU · {s.size.memoryMb} MiB</span>
                <span className={`text-xs ${s.state === 'failed' ? 'text-bad' : s.state === 'running' ? 'text-ok' : 'text-muted-foreground'}`}>{playgroundStateText(s, now)}</span>
                {canAct && <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void destroy({ ids: [s.id] })}>Destroy</Button>}
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}
