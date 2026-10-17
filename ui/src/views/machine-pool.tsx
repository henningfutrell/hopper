// Add machine's Pod / Kubernetes (issue #1454, design.md "Lane pods of another release"): lane pods of a runner-only Helm
// release join this hopper, whatever runs it (compose too), with a lane pool key the hopper issues here. No restart. The
// key is shown once: only its hash is kept. A new key replaces the one before; pods that joined stay machines.
// Phone width first: every control stacks.
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { get, post } from '@/lib/api';
import { loopbackOnly, podRunnerCommands } from '@/model/machines';
import { useHopper } from '@/store';

interface Issued { key: string; issuedAt: string }

const when = (iso: string): string => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

export function PodMachineForm({ onDone }: { onDone: () => void }) {
  const [issuedAt, setIssuedAt] = useState<string | undefined>();
  const [issued, setIssued] = useState<Issued | null>(null);
  const [url, setUrl] = useState(window.location.origin);
  const [busy, setBusy] = useState(false);
  const machines = useHopper((s) => s.machines);
  const before = useRef<Set<string> | null>(null);

  useEffect(() => {
    get<{ issuedAt?: string }>('/api/machines/pool-key').then((r) => setIssuedAt(r.issuedAt), () => undefined);
  }, []);

  useEffect(() => {
    if (!before.current) return;
    const joined = machines.find((m) => m.online && m.client && !before.current!.has(m.id));
    if (joined) toast.success(`${joined.label || joined.id} joined, online`);
  }, [machines]);

  const act = async (action: 'issue' | 'revoke') => {
    setBusy(true);
    try {
      if (action === 'issue') {
        before.current = new Set(machines.map((m) => m.id));
        const r = await post<Issued>('/ui/api/machines/pool-key', { action });
        setIssued(r);
        setIssuedAt(r.issuedAt);
      } else {
        await post('/ui/api/machines/pool-key', { action });
        setIssued(null);
        setIssuedAt(undefined);
        toast.success('Key revoked: no new pod joins with it');
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const copy = (text: string) => navigator.clipboard?.writeText(text).then(() => toast.success('Copied'), () => toast.error('Clipboard blocked'));
  const commands = issued ? podRunnerCommands({ hopperUrl: url, key: issued.key }) : null;

  return (
    <div className="grid gap-3">
      <p className="text-xs text-muted-foreground">
        Lane pods on a Kubernetes cluster: each pod is one of your machines. They dial out to this hopper, so it needs no
        restart. The pods hold no credential of this computer.
      </p>
      {!issued && (
        <div className="grid gap-2">
          {issuedAt && <span className="text-xs text-muted-foreground">You have a key from {when(issuedAt)}. A new key replaces it: pods that joined stay, new pods need the new key.</span>}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="lg" disabled={busy} onClick={() => void act('issue')}>{busy ? 'Making a key…' : issuedAt ? 'Make a new key' : 'Make a key'}</Button>
            {issuedAt && <Button type="button" size="lg" variant="outline" disabled={busy} onClick={() => void act('revoke')}>Revoke the key</Button>}
            <Button type="button" size="lg" variant="ghost" disabled={busy} onClick={onDone}>Cancel</Button>
          </div>
        </div>
      )}
      {issued && commands && (
        <div className="grid gap-2 text-xs">
          <label className="grid gap-1">
            <span className="font-medium text-foreground/90">The URL the pods reach this hopper at:</span>
            <Input value={url} onChange={(e) => setUrl(e.target.value)} className="font-mono" />
          </label>
          {loopbackOnly(url) && <span className="text-destructive">Pods in a cluster cannot reach this computer at localhost. Use its LAN name or the public URL, one this hopper answers to.</span>}
          <span className="font-medium text-foreground/90">1. Keep the key in a Secret on the cluster:</span>
          <div className="flex flex-wrap items-start gap-2">
            <code className="min-w-0 flex-1 rounded-md border bg-muted/40 p-2 font-mono break-all">{commands.secret}</code>
            <Button type="button" size="sm" variant="outline" className="min-h-9" onClick={() => void copy(commands.secret)}>Copy</Button>
          </div>
          <span className="font-medium text-foreground/90">2. In a checkout of the hopper's repository, install the lane pods:</span>
          <div className="flex flex-wrap items-start gap-2">
            <code className="min-w-0 flex-1 rounded-md border bg-muted/40 p-2 font-mono break-all">{commands.helm}</code>
            <Button type="button" size="sm" variant="outline" className="min-h-9" onClick={() => void copy(commands.helm)}>Copy</Button>
          </div>
          <span className="text-muted-foreground">
            This page shows the key once. Every pod and every restart joins with it, until you make a new key or revoke it.
            Each pod shows here, online, when it joins. Set more pods with lanes.replicas.
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant="ghost" className="min-h-9" onClick={onDone}>Close</Button>
          </div>
        </div>
      )}
    </div>
  );
}
