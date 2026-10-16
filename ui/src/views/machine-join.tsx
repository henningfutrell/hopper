// Add machine (design.md "Joining a machine", issue #308): get one line with a one-time join code
// (POST /ui/api/machines/join), run it on the computer. Nothing is typed into the hopper: the machine joins itself, dials
// in, and shows in the Machines view, online. Attaching over ssh stays behind a link, for a machine that cannot run the
// client. A sandbox never joins as a machine (issue #1349): a job's step runs in a sandbox of its own, burned after it.
// Phone width first: every control stacks.
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { post } from '@/lib/api';
import { joinLine } from '@/model/machines';
import { useHopper } from '@/store';

interface Minted { code: string; expiresAt: string }

const time = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function JoinMachineForm({ onDone, onSsh }: { onDone: () => void; onSsh: () => void }) {
  const [minted, setMinted] = useState<Minted | null>(null);
  const [busy, setBusy] = useState(false);
  const machines = useHopper((s) => s.machines);
  // The machines there were when the line was shown: the first new one online is the one that joined.
  const before = useRef<Set<string> | null>(null);
  const line = minted ? joinLine({ origin: window.location.origin, code: minted.code }) : null;

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
      setMinted(await post<Minted>('/ui/api/machines/join', {}));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const copy = (text: string) => navigator.clipboard?.writeText(text).then(() => toast.success('Copied'), () => toast.error('Clipboard blocked'));

  return (
    <div className="grid gap-3">
      <p className="text-xs text-muted-foreground">
        A computer: this one or another one. Its jobs run as you there. It needs Node.js 24 or later and herdr.
      </p>
      {!line && (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="lg" disabled={busy} onClick={() => void mint()}>{busy ? 'Making a join code…' : 'Show the line'}</Button>
          <Button type="button" size="lg" variant="ghost" disabled={busy} onClick={onDone}>Cancel</Button>
        </div>
      )}
      {line && minted && (
        <div className="grid gap-2 text-xs">
          <span className="font-medium text-foreground/90">Run this in a terminal on the computer:</span>
          <div className="flex flex-wrap items-start gap-2">
            <code className="min-w-0 flex-1 rounded-md border bg-muted/40 p-2 font-mono break-all">{line}</code>
            <Button type="button" size="sm" variant="outline" className="min-h-9" onClick={() => void copy(line)}>Copy</Button>
          </div>
          <span className="text-muted-foreground">
            The code in it works once, until {time(minted.expiresAt)}. The machine shows here, online, when it joins.
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
