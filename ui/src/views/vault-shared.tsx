// Vault, shared secrets (issue #718): secrets the hopper's admin shares with every user's agents, or with
// the users named, in place of a copy in each user's vault. Every user sees each one's name — what a template puts in
// its scope —, whose agents may read it, and who set it; never a value. Only the hopper's admin shares, replaces (sharing
// the same name again) or removes one. A job gets it only from a box of an approved template that names it.
import { Plus, Share2, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Confirm } from '@/components/confirm';
import { Empty, Panel } from '@/components/panel';
import { Label, ValueInput } from '@/components/vault-fields';
import { post, SessionRejected } from '@/lib/api';
import { nameProblem } from '@/model/vault';
import { readersOf, sharedReadersText, sharedSecretLine } from '@/model/vault-shared';
import type { SharedSecretView, VaultView } from '@/model/wire';
import { useHopper } from '@/store';
import { useCanAdminInstance } from '@/store/selectors';

type SharedEdit = { action: 'set'; name: string; value: string; scope?: string; readers?: string[] } | { action: 'remove'; name: string };

function ShareForm({ busy, send, onDone }: { busy: boolean; send: (e: SharedEdit, done: string) => Promise<boolean>; onDone: () => void }) {
  const [name, setName] = useState('');
  const [scope, setScope] = useState('');
  const [readers, setReaders] = useState('');
  const [value, setValue] = useState('');
  const n = name.trim().replace(/^shared\//, '');
  const problem = name ? nameProblem(n) : undefined;
  return (
    <form className="space-y-3" onSubmit={async (e) => {
      e.preventDefault();
      const who = readersOf(readers);
      const ok = await send({ action: 'set', name: n, value, ...(scope.trim() ? { scope: scope.trim() } : {}), ...(who ? { readers: who } : {}) }, `shared/${n}: shared`);
      setValue('');
      if (ok) onDone();
    }}>
      <label className="block space-y-1"><Label>Name — a template names it as shared/&lt;name&gt;; the same name again replaces it</Label>
        <Input className="h-9 font-mono text-sm" value={name} required autoCapitalize="off" autoCorrect="off" spellCheck={false}
          placeholder="AWS_DIAG" onChange={(e) => setName(e.target.value)} />
        {problem && <div className="text-xs text-bad">{problem}</div>}</label>
      <label className="block space-y-1"><Label>Scope — what it reaches, in your words (optional)</Label>
        <Input className="h-9 text-sm" value={scope} maxLength={200} placeholder="AWS lab account, read-only" onChange={(e) => setScope(e.target.value)} /></label>
      <label className="block space-y-1"><Label>Readers — user ids whose agents may read it; empty: every user's (optional)</Label>
        <Input className="h-9 font-mono text-sm" value={readers} maxLength={4000} autoCapitalize="off" autoCorrect="off" spellCheck={false}
          placeholder="every user" onChange={(e) => setReaders(e.target.value)} /></label>
      <label className="block space-y-1"><Label>Value — kept encrypted; never shown again, to anyone</Label>
        <ValueInput value={value} onChange={setValue} /></label>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || !n || problem !== undefined || value === ''}>Share secret</Button>
        <Button type="button" variant="outline" disabled={busy} onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}

export function SharedSecrets({ shared, onView }: { shared: SharedSecretView[]; onView: (v: VaultView) => void }) {
  const can = useCanAdminInstance();
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const send = async (edit: SharedEdit, done: string): Promise<boolean> => {
    setBusy(true);
    try {
      onView(await post<VaultView>('/ui/api/vault/shared', edit));
      toast.success(done);
      return true;
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false });
      toast.error((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title="Shared secrets" icon={Share2} count={shared.length || ''} bodyClassName="space-y-3"
      action={can && !adding ? <Button size="sm" onClick={() => setAdding(true)} disabled={busy}><Plus />Share secret</Button> : undefined}>
      <p className="text-sm text-muted-foreground">Secrets the hopper's admin shares with agents, so each user needs no copy of their own. A job gets one only from a box of an approved template that names it, and only when its user is a reader. Never shown.</p>
      {adding && <div className="rounded-md border p-3"><ShareForm busy={busy} send={send} onDone={() => setAdding(false)} /></div>}
      {shared.length === 0 && !adding ? <Empty>None shared.</Empty> : (
        <ul className="space-y-2">
          {shared.map((s) => (
            <li key={s.name} className="space-y-1 rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm font-medium break-all">{s.name}</span>
                <span className="text-xs text-muted-foreground">{sharedReadersText(s)}</span>
              </div>
              {s.scope && <p className="text-xs break-words">{s.scope}</p>}
              <p className="text-xs text-muted-foreground">{sharedSecretLine(s)}</p>
              {can && (
                <Confirm title={`Remove ${s.name}?`} action="Remove" onConfirm={() => void send({ action: 'remove', name: s.name }, `${s.name}: removed`)}
                  description="The secret is deleted for every user. A job that asks for it afterwards gets nothing.">
                  <Button size="sm" variant="destructive" disabled={busy}><Trash2 />Remove</Button>
                </Confirm>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
