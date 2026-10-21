// The Machines page's layout (issue #2352): a section a person collapses, the Cards / List toggle in the machines
// section's header (the Jobs view's Graph / List control), and the list view — one row per machine, its name, status,
// lanes in use of its max, CPU, memory, disk, version and a warning marker if it has an alert; a click on a row expands
// it in place to that machine's card, with every action the card has. The mode and the collapsed sections are kept per
// browser (hooks/use-machines-layout.ts).
import { ChevronDown, ChevronRight, LayoutGrid, List, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { StatusBadge, TEXT } from '@/components/status';
import { setMachinesMode, toggleMachinesSection, useMachinesCollapsed, useMachinesMode } from '@/hooks/use-machines-layout';
import { useNow } from '@/hooks/use-now';
import { machineHasAlert, machineRow } from '@/model/machine-list';
import type { MachineView } from '@/model/wire';
import { cn } from '@/lib/utils';
import { MachineCard, type Ctx } from './machine-card';

/** A section of the Machines page: its header folds it, and the fold is remembered. */
export function MachinesSection({ id, title, count, action, children }: { id: string; title: string; count?: number; action?: React.ReactNode; children: React.ReactNode }) {
  const open = !useMachinesCollapsed().includes(id);
  return (
    <section data-slot="machines-section" data-section={id} data-open={open ? '' : undefined} className="space-y-3">
      <div className="flex min-h-9 items-center gap-2">
        <button type="button" onClick={() => toggleMachinesSection(id)} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-muted/40">
          {open ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
          <h2 className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">{title}</h2>
          {count !== undefined && <span className="num text-[11px] text-muted-foreground/70">{count}</span>}
        </button>
        {open && action}
      </div>
      {open && children}
    </section>
  );
}

/** Cards or List, the Jobs view's segmented control. */
export function MachinesModeToggle() {
  const mode = useMachinesMode();
  return (
    <div role="group" aria-label="View mode" className="inline-flex rounded-md border">
      <button type="button" data-slot="machines-mode-cards" aria-pressed={mode === 'cards'} onClick={() => setMachinesMode('cards')} className={cn('inline-flex items-center gap-1 px-2 py-1 text-xs', mode === 'cards' && 'bg-muted')}><LayoutGrid className="size-3.5" />Cards</button>
      <button type="button" data-slot="machines-mode-list" aria-pressed={mode === 'list'} onClick={() => setMachinesMode('list')} className={cn('inline-flex items-center gap-1 border-l px-2 py-1 text-xs', mode === 'list' && 'bg-muted')}><List className="size-3.5" />List</button>
    </div>
  );
}

function MachineRow({ m, ctx, open, onToggle, now }: { m: MachineView; ctx: Ctx; open: boolean; onToggle: () => void; now: number }) {
  const row = machineRow(m);
  const alert = machineHasAlert(m, now);
  const cell = 'num shrink-0 text-xs text-muted-foreground';
  return (
    <li data-slot="machine-row" data-machine={m.id} data-open={open ? '' : undefined}>
      <button type="button" onClick={onToggle} aria-expanded={open} aria-label={`${m.label || m.id}: ${open ? 'hide' : 'show'} its card`}
        className="flex w-full min-w-0 items-center gap-3 px-3 py-2 text-left hover:bg-muted/40">
        {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={m.id}>{m.label || m.id}</span>
        {alert && <TriangleAlert data-slot="machine-row-alert" aria-label="has an alert" className={cn('size-3.5 shrink-0', TEXT.warn)} />}
        <StatusBadge status={m.online ? 'online' : 'offline'} />
        <span className={cell} title="lanes in use of its max">lanes {row.lanes}</span>
        <span className={cn(cell, 'hidden sm:inline')}>CPU {row.cpu}</span>
        <span className={cn(cell, 'hidden sm:inline')}>mem {row.memory}</span>
        <span className={cn(cell, 'hidden md:inline')}>disk {row.disk}</span>
        <span className={cn(cell, 'hidden md:inline w-20 truncate text-right font-mono')} title="client release">{row.version}</span>
      </button>
      {open && <div className="border-t p-3"><MachineCard m={m} ctx={ctx} /></div>}
    </li>
  );
}

/** The list view: one row per machine; a click expands a row in place to its card. */
export function MachineList({ machines, ctx }: { machines: readonly MachineView[]; ctx: Ctx }) {
  const now = useNow();
  const [open, setOpen] = useState<string | null>(null);
  return (
    <ul data-slot="machine-list" className="divide-y rounded-lg border bg-card">
      {machines.map((m) => <MachineRow key={m.id} m={m} ctx={ctx} now={now} open={open === m.id} onToggle={() => setOpen((o) => (o === m.id ? null : m.id))} />)}
    </ul>
  );
}
