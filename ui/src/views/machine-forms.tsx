// The Machines view's forms (design.md "Machines from the UI", issues #18, #74): attach a machine over
// ssh, edit an attached one's lanes, executors and label, edit a local one's lane count. The ssh target is picked from ~/.ssh/config's Host
// aliases, never typed; herdr's path is resolved by the daemon over ssh. Phone width first: every
// field stacks, every control is at least 36 px tall.
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { addBody, addProblem, editBody, type MachineDraft, type MachineEditDraft, type MachineKind } from '@/model/machines';
import type { MachineEdit, MachinesConfig, PluginsEdit } from '@/model/wire';

const SELECT = 'h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-base md:text-sm dark:bg-input/30';

function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="grid gap-1 text-xs">
      <span className="font-medium text-foreground/90">{label}</span>
      {children}
      {hint && <span className="text-muted-foreground">{hint}</span>}
    </label>
  );
}

function ExecutorChecks({ all, picked, onChange, disabled }: { all: string[]; picked: string[]; onChange: (next: string[]) => void; disabled: boolean }) {
  if (!all.length) return <div className="text-xs text-muted-foreground">no executor instances in plugins.yaml</div>;
  return (
    <fieldset className="grid gap-1 text-xs">
      <legend className="mb-1 font-medium text-foreground/90">executors it runs</legend>
      <div className="flex flex-wrap gap-2">
        {all.map((x) => (
          <label key={x} className="flex min-h-9 items-center gap-2 rounded-lg border px-3 font-mono">
            <input type="checkbox" className="size-4" checked={picked.includes(x)} disabled={disabled}
              onChange={(e) => onChange(e.target.checked ? [...picked, x] : picked.filter((p) => p !== x))} />
            {x}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Attach a machine: name, ssh target (detected), lanes, executors, label. */
export function AddMachineForm({ config, busy, send, onDone }: {
  config: MachinesConfig; busy: boolean; send: (e: MachineEdit, done: string) => Promise<boolean>; onDone: () => void;
}) {
  const [d, setD] = useState<MachineDraft>({
    name: '', ssh: '', lanes: '2',
    executors: config.executors.includes('herdr-claude') ? ['herdr-claude'] : config.executors.slice(0, 1), label: '',
  });
  const set = (over: Partial<MachineDraft>) => setD((x) => ({ ...x, ...over }));
  const problem = addProblem(d, config);
  const submit = async () => { if (await send(addBody(d, config.version), `Attached ${d.name.trim()}`)) onDone(); };
  return (
    <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="name" hint="the machine id; lanes and jobs are stored under it">
          <Input className="h-9" value={d.name} disabled={busy} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="laptop" onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="ssh target" hint={config.ssh.targets.length ? 'a Host alias from ~/.ssh/config' : 'no Host aliases in ~/.ssh/config: add one there first'}>
          <select className={SELECT} value={d.ssh} disabled={busy || !config.ssh.targets.length} onChange={(e) => set({ ssh: e.target.value })}>
            <option value="">choose…</option>
            {config.ssh.targets.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
        <Field label="lanes" hint="jobs it runs at once">
          <Input className="h-9" type="number" inputMode="numeric" min={1} step={1} value={d.lanes} disabled={busy} onChange={(e) => set({ lanes: e.target.value })} />
        </Field>
        <Field label="label" hint="optional; shown instead of the name">
          <Input className="h-9" value={d.label} disabled={busy} placeholder={d.name.trim() || 'spare laptop'} onChange={(e) => set({ label: e.target.value })} />
        </Field>
      </div>
      <ExecutorChecks all={config.executors} picked={d.executors} disabled={busy} onChange={(executors) => set({ executors })} />
      {config.ssh.notes.map((n) => <div key={n} className="text-xs text-warn">{n}</div>)}
      <p className="text-xs text-muted-foreground">
        The daemon finds herdr there over ssh and writes its path. Prepare the machine first:
        {' '}<code className="font-mono break-all">bash scripts/attach-machine.sh {d.ssh || '<ssh-target>'}</code>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="lg" disabled={busy || problem !== null}>{busy ? 'Reaching it over ssh…' : 'Attach machine'}</Button>
        <Button type="button" size="lg" variant="ghost" disabled={busy} onClick={onDone}>Cancel</Button>
        {problem && d.name.trim() !== '' && <span className="text-xs text-muted-foreground">{problem}</span>}
      </div>
    </form>
  );
}

/** Edit an attached machine: lanes, executors, label. How it is reached (ssh, herdr, container, token) is plugins.yaml only. */
export function EditMachineForm({ machine, config, busy, send, onDone }: {
  machine: Extract<MachineKind, { kind: 'attached' }>; config: MachinesConfig; busy: boolean;
  send: (e: Extract<PluginsEdit, { action: 'options' }>, done: string) => Promise<boolean>; onDone: () => void;
}) {
  const name = machine.instance.name;
  const [d, setD] = useState<MachineEditDraft>({ lanes: String(machine.lanes), executors: [...machine.executors], label: machine.label ?? '' });
  const set = (over: Partial<MachineEditDraft>) => setD((x) => ({ ...x, ...over }));
  const body = editBody(machine, d, config.version);
  const lanesOk = /^\d+$/.test(d.lanes.trim()) && Number(d.lanes) >= 1;
  const all = [...config.executors, ...machine.executors.filter((x) => !config.executors.includes(x))];
  const submit = async () => { if (body && await send(body, `Saved ${name}`)) onDone(); };
  return (
    <form className="grid gap-3 rounded-md border p-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="lanes"><Input className="h-9" type="number" inputMode="numeric" min={1} step={1} value={d.lanes} disabled={busy} onChange={(e) => set({ lanes: e.target.value })} /></Field>
        <Field label="label" hint="empty: the name"><Input className="h-9" value={d.label} disabled={busy} placeholder={name} onChange={(e) => set({ label: e.target.value })} /></Field>
      </div>
      <ExecutorChecks all={all} picked={d.executors} disabled={busy} onChange={(executors) => set({ executors })} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="lg" disabled={busy || !body || !lanesOk}>Save {name}</Button>
        <Button type="button" size="lg" variant="ghost" disabled={busy} onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}

/** A local machine's lane count: its instance's `lanes` option (POST /ui/api/plugins). */
export function LocalLanesForm({ lanes, busy, save, onDone }: { lanes: number; busy: boolean; save: (lanes: number) => Promise<boolean>; onDone: () => void }) {
  const [v, setV] = useState(String(lanes));
  const ok = /^\d+$/.test(v.trim());
  const submit = async () => { if (await save(Number(v))) onDone(); };
  return (
    <form className="grid gap-3 rounded-md border p-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <Field label="lanes" hint="jobs this machine runs at once; 0 runs none here">
        <Input className="h-9" type="number" inputMode="numeric" min={0} step={1} value={v} disabled={busy} onChange={(e) => setV(e.target.value)} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="lg" disabled={busy || !ok || Number(v) === lanes}>Save lanes</Button>
        <Button type="button" size="lg" variant="ghost" disabled={busy} onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}
