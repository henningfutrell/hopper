// Add machine (design.md "Joining a machine", issue #308): pick a computer or a sandbox box, get one line
// with a one-time join code (POST /ui/api/machines/join), run it there. Nothing is typed into the hopper:
// the machine joins itself, dials in, and shows in the Machines view, online. Attaching over ssh stays
// behind a link, for a machine that cannot run the client. Phone width first: every control stacks.
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { post } from '@/lib/api';
import { BOX_AGENTS, boxPlace, joinLine, type BoxAgent, type JoinChoice } from '@/model/machines';
import type { MachinesConfig } from '@/model/wire';
import { useHopper } from '@/store';

interface Minted { code: string; expiresAt: string }

const time = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function Choice({ on, label, hint, onPick, disabled }: { on: boolean; label: string; hint: string; onPick: () => void; disabled: boolean }) {
  return (
    <button type="button" disabled={disabled} onClick={onPick} aria-pressed={on}
      className={`grid min-h-16 gap-1 rounded-lg border p-3 text-left text-xs transition-colors ${on ? 'border-primary bg-primary/5' : 'hover:bg-muted/40'}`}>
      <span className="text-sm font-medium text-foreground">{label}</span>
      <span className="text-muted-foreground">{hint}</span>
    </button>
  );
}

export function JoinMachineForm({ config, onDone, onSsh }: { config: MachinesConfig; onDone: () => void; onSsh: () => void }) {
  const [kind, setKind] = useState<JoinChoice['kind']>('computer');
  const [engine, setEngine] = useState<'podman' | 'docker'>('podman');
  const [agent, setAgent] = useState<BoxAgent>(BOX_AGENTS[0]);
  const [minted, setMinted] = useState<Minted | null>(null);
  const [busy, setBusy] = useState(false);
  const machines = useHopper((s) => s.machines);
  // The machines there were when the line was shown: the first new one online is the one that joined.
  const before = useRef<Set<string> | null>(null);
  const choice: JoinChoice = kind === 'computer' ? { kind } : { kind, agent, engine };
  const line = minted ? joinLine(choice, { origin: window.location.origin, code: minted.code, join: boxPlace(config, String(config.port ?? window.location.port)) }) : null;

  useEffect(() => {
    if (!before.current) return;
    const joined = machines.find((m) => m.online && m.client && !before.current!.has(m.id));
    if (joined) {
      toast.success(`${joined.label || joined.id} joined, online`);
      onDone();
    }
  }, [machines, onDone]);

  const mint = async () => {
    setBusy(true);
    try {
      before.current = new Set(machines.map((m) => m.id));
      setMinted(await post<Minted>('/ui/api/machines/join'));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const copy = (text: string) => navigator.clipboard?.writeText(text).then(() => toast.success('Copied'), () => toast.error('Clipboard blocked'));

  return (
    <div className="grid gap-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <Choice on={kind === 'computer'} disabled={busy} onPick={() => setKind('computer')} label="A computer"
          hint="this computer or another one: its jobs run as you there. It needs Node.js 24 or later and herdr." />
        <Choice on={kind === 'box'} disabled={busy} onPick={() => setKind('box')} label="A sandbox box"
          hint="a locked-down container on the computer the hopper runs on: its jobs reach nothing of that computer." />
      </div>
      {kind === 'box' && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">agent</span>
          {BOX_AGENTS.map((a) => <Button key={a} type="button" size="sm" variant={agent === a ? 'default' : 'outline'} className="min-h-9" onClick={() => setAgent(a)}>{a}</Button>)}
          <span className="ml-2 text-muted-foreground">engine</span>
          {(['podman', 'docker'] as const).map((e) => <Button key={e} type="button" size="sm" variant={engine === e ? 'default' : 'outline'} className="min-h-9" onClick={() => setEngine(e)}>{e}</Button>)}
        </div>
      )}
      {!line && (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="lg" disabled={busy} onClick={() => void mint()}>{busy ? 'Making a join code…' : 'Show the line'}</Button>
          <Button type="button" size="lg" variant="ghost" disabled={busy} onClick={onDone}>Cancel</Button>
        </div>
      )}
      {line && minted && (
        <div className="grid gap-2 text-xs">
          <span className="font-medium text-foreground/90">
            {kind === 'computer' ? 'Run this in a terminal on the computer:' : 'Run this on the computer the hopper runs on:'}
          </span>
          <div className="flex flex-wrap items-start gap-2">
            <code className="min-w-0 flex-1 rounded-md border bg-muted/40 p-2 font-mono break-all">{line}</code>
            <Button type="button" size="sm" variant="outline" className="min-h-9" onClick={() => void copy(line)}>Copy</Button>
          </div>
          <span className="text-muted-foreground">
            The code in it works once, until {time(minted.expiresAt)}. The machine shows here, online, when it joins.
            {kind === 'box' && <> Then sign its agent in once: <code className="font-mono">{engine} exec -it hopper-sandbox-{agent} {agent}</code> — the sign-in stays in the box&apos;s home volume.</>}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">Waiting for it to join…</span>
            <Button type="button" size="sm" variant="ghost" className="min-h-9" onClick={() => setMinted(null)}>Another line</Button>
            <Button type="button" size="sm" variant="ghost" className="min-h-9" onClick={onDone}>Close</Button>
          </div>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        A machine that cannot run the client? <button type="button" className="underline underline-offset-2" onClick={onSsh}>Attach it over ssh instead</button>.
      </p>
    </div>
  );
}
