// The Machines view's forms (design.md "Machines from the UI", issues #18, #74, #142, #205, #260): add this machine
// (no ssh target: its name and herdr session), attach a machine over ssh, edit an attached one's name, lanes, executors, label and how it is reached, edit a local one's name and
// lane count, edit the machine defaults a new machine starts from. On attach the ssh target is picked from
// ~/.ssh/config's Host aliases, never typed; herdr's path is resolved by the daemon over ssh when one of the
// machine's executors needs herdr. Phone width first: every field stacks, every control is at least 36 px tall.
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { addBody, addProblem, defaultsBody, DETAILS, editBody, editDraft, editProblem, localBody, newDraft, newThisDraft, thisBody, thisProblem, type LocalDraft, type MachineDefaultsDraft, type MachineDraft, type MachineEditDraft, type MachineKind, type ThisDraft } from '@/model/machines';
import type { MachineDefaultsEdit, MachineEdit, MachinesConfig, PluginsEdit } from '@/model/wire';

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
  if (!all.length) return <div className="text-xs text-muted-foreground">no executor instances configured</div>;
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

/** Add this machine (issue #260): no ssh target — its name, the herdr session its jobs run in (started by the hopper), lanes, label. */
export function AddThisMachineForm({ config, busy, send, onDone }: {
  config: MachinesConfig; busy: boolean; send: (e: MachineEdit, done: string) => Promise<boolean>; onDone: () => void;
}) {
  const [d, setD] = useState<ThisDraft>(newThisDraft);
  const set = (over: Partial<ThisDraft>) => setD((x) => ({ ...x, ...over }));
  const problem = thisProblem(d, config);
  const submit = async () => { if (await send(thisBody(d, config.version), `Added this machine as ${d.name.trim()}`)) onDone(); };
  return (
    <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="name" hint="the machine id; lanes and jobs are stored under it">
          <Input className="h-9" value={d.name} disabled={busy} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="workstation" onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="herdr session" hint="where its jobs run; the hopper starts it when it is not running">
          <Input className="h-9 font-mono" value={d.session} disabled={busy} autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(e) => set({ session: e.target.value })} />
        </Field>
        <Field label="lanes" hint="jobs it runs at once">
          <Input className="h-9" type="number" inputMode="numeric" min={1} step={1} value={d.lanes} disabled={busy} onChange={(e) => set({ lanes: e.target.value })} />
        </Field>
        <Field label="label" hint="optional; shown instead of the name">
          <Input className="h-9" value={d.label} disabled={busy} placeholder={d.name.trim() || 'workstation'} onChange={(e) => set({ label: e.target.value })} />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="lg" disabled={busy || problem !== null}>{busy ? 'Starting its herdr session…' : 'Add this machine'}</Button>
        <Button type="button" size="lg" variant="ghost" disabled={busy} onClick={onDone}>Cancel</Button>
        {problem && d.name.trim() !== '' && <span className="text-xs text-muted-foreground">{problem}</span>}
      </div>
    </form>
  );
}

/** Attach a machine: name, ssh target (detected), lanes, executors, label. */
export function AddMachineForm({ config, busy, send, onDone }: {
  config: MachinesConfig; busy: boolean; send: (e: MachineEdit, done: string) => Promise<boolean>; onDone: () => void;
}) {
  const [d, setD] = useState<MachineDraft>(() => newDraft(config));
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
        When an executor it runs needs herdr (herdr-claude), the daemon finds herdr there over ssh and writes its path; otherwise it
        only checks the machine answers over ssh. Prepare the machine first:
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

/** Edit an attached machine: its name, lanes, executors, label, and how it is reached — its connection's details (issue #205). */
export function EditMachineForm({ machine, config, busy, send, onDone }: {
  machine: Extract<MachineKind, { kind: 'attached' }>; config: MachinesConfig; busy: boolean;
  send: (e: Extract<PluginsEdit, { action: 'options' }>, done: string) => Promise<boolean>; onDone: () => void;
}) {
  const name = machine.machine.name;
  const [d, setD] = useState<MachineEditDraft>(() => editDraft(machine));
  const set = (over: Partial<MachineEditDraft>) => setD((x) => ({ ...x, ...over }));
  const detail = (key: string, v: string) => setD((x) => ({ ...x, details: { ...x.details, [key]: v } }));
  const problem = editProblem(machine, d, config);
  const body = problem ? null : editBody(machine, d, config.version);
  const all = [...config.executors, ...machine.executors.filter((x) => !config.executors.includes(x))];
  const targets = `ssh-targets-${name}`;
  const submit = async () => { if (body && await send(body, body.rename ? `Renamed ${name} to ${body.rename}` : `Saved ${name}`)) onDone(); };
  return (
    <form className="grid gap-3 rounded-md border p-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="name" hint="the machine id; refused while a job runs there, waits there or is pinned to it">
          <Input className="h-9" value={d.name} disabled={busy} autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="label" hint="empty: the name"><Input className="h-9" value={d.label} disabled={busy} placeholder={d.name.trim() || name} onChange={(e) => set({ label: e.target.value })} /></Field>
        <Field label="lanes"><Input className="h-9" type="number" inputMode="numeric" min={1} step={1} value={d.lanes} disabled={busy} onChange={(e) => set({ lanes: e.target.value })} /></Field>
        {(DETAILS[machine.machine.connection] ?? []).map((f) => (
          <Field key={f.key} label={f.label} hint={f.hint}>
            <Input className="h-9 font-mono" value={d.details[f.key] ?? ''} disabled={busy} autoCapitalize="none" autoCorrect="off" spellCheck={false}
              list={f.key === 'ssh' ? targets : undefined} onChange={(e) => detail(f.key, e.target.value)} />
          </Field>
        ))}
      </div>
      {machine.machine.connection === 'ssh' && (
        <>
          <datalist id={targets}>{config.ssh.targets.map((t) => <option key={t} value={t} />)}</datalist>
          <label className="flex min-h-9 items-center gap-2 text-xs">
            <input type="checkbox" className="size-4" checked={d.herdr} disabled={busy} onChange={(e) => set({ herdr: e.target.checked })} />
            runs herdr (off: probed over ssh alone; herdr-claude does not run there)
          </label>
        </>
      )}
      <ExecutorChecks all={all} picked={d.executors} disabled={busy} onChange={(executors) => set({ executors })} />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="lg" disabled={busy || !body}>Save {name}</Button>
        <Button type="button" size="lg" variant="ghost" disabled={busy} onClick={onDone}>Cancel</Button>
        {problem && <span className="text-xs text-muted-foreground">{problem}</span>}
      </div>
    </form>
  );
}

/** The machine defaults (issue #142): the lanes and executors a new machine starts with. */
export function MachineDefaultsForm({ config, busy, send, onDone }: {
  config: MachinesConfig; busy: boolean; send: (e: MachineDefaultsEdit, done: string) => Promise<boolean>; onDone: () => void;
}) {
  const [d, setD] = useState<MachineDefaultsDraft>({ lanes: String(config.defaults.lanes), executors: [...config.defaults.executors] });
  const set = (over: Partial<MachineDefaultsDraft>) => setD((x) => ({ ...x, ...over }));
  const body = defaultsBody(d, config.version);
  const all = [...config.executors, ...config.defaults.executors.filter((x) => !config.executors.includes(x))];
  const submit = async () => { if (body && await send(body, 'Saved the machine defaults')) onDone(); };
  return (
    <form className="grid gap-3 rounded-md border p-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <Field label="lanes" hint="jobs a new machine runs at once">
        <Input className="h-9" type="number" inputMode="numeric" min={1} step={1} value={d.lanes} disabled={busy} onChange={(e) => set({ lanes: e.target.value })} />
      </Field>
      <ExecutorChecks all={all} picked={d.executors} disabled={busy} onChange={(executors) => set({ executors })} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="lg" disabled={busy || !body}>Save defaults</Button>
        <Button type="button" size="lg" variant="ghost" disabled={busy} onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}

/** A local machine's name and lane count: its instance's `lanes` option (POST /ui/api/plugins, issue #205). */
export function LocalMachineForm({ machine, config, busy, send, onDone }: {
  machine: Extract<MachineKind, { kind: 'local' }>; config: MachinesConfig; busy: boolean;
  send: (e: Extract<PluginsEdit, { action: 'options' }>, done: string) => Promise<boolean>; onDone: () => void;
}) {
  const name = machine.machine.name;
  const [d, setD] = useState<LocalDraft>({ name, lanes: String(machine.lanes), session: typeof machine.machine.options?.session === 'string' ? machine.machine.options.session : '' });
  const taken = d.name.trim() !== name && config.machines.some((m) => m.name === d.name.trim());
  const body = taken ? null : localBody(machine, d, config.version);
  const submit = async () => { if (body && await send(body, body.rename ? `Renamed ${name} to ${body.rename}` : `Saved ${name}`)) onDone(); };
  return (
    <form className="grid gap-3 rounded-md border p-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="name" hint={taken ? `a machine is already named ${d.name.trim()}` : 'the machine id; refused while a job runs here, waits here or is pinned to it'}>
          <Input className="h-9" value={d.name} disabled={busy} autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(e) => setD((x) => ({ ...x, name: e.target.value }))} />
        </Field>
        <Field label="lanes" hint="jobs this machine runs at once; 0 runs none here">
          <Input className="h-9" type="number" inputMode="numeric" min={0} step={1} value={d.lanes} disabled={busy} onChange={(e) => setD((x) => ({ ...x, lanes: e.target.value }))} />
        </Field>
        <Field label="herdr session" hint="where its jobs run; the hopper starts it when it is not running. Empty: herdr-claude's own">
          <Input className="h-9 font-mono" value={d.session ?? ''} disabled={busy} autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(e) => setD((x) => ({ ...x, session: e.target.value }))} />
        </Field>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="lg" disabled={busy || !body}>Save {name}</Button>
        <Button type="button" size="lg" variant="ghost" disabled={busy} onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}
