// Settings → Vault (issue #558): write-only secrets for jobs. Each is set once — a name, an optional scope saying what
// it reaches, a value — and from then on only its metadata shows: no view, and no answer the page gets, holds a value.
// Replace types a new value over it; Remove deletes it. Templates: an image and the secrets its boxes may ask for,
// approved once by a person and again for a new secret or a new image. Editing is an admin's. A secret may instead be
// kept in a vault backend (issue #585): the person names the backend and where the value is there, never the value.
import { Boxes, Check, KeyRound, LockKeyhole, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Confirm } from '@/components/confirm';
import { Empty, Panel } from '@/components/panel';
import { get, post, SessionRejected } from '@/lib/api';
import { approvalText, DEFAULT_BOX_IMAGE, keptText, nameProblem, referenceHint, secretFacts } from '@/model/vault';
import type { TemplateView, VaultBackendView, VaultSecret, VaultView } from '@/model/wire';
import { useHopper } from '@/store';
import { useCanAdmin } from '@/store/selectors';

type Edit = { action: 'set'; name: string; scope?: string; value: string } | { action: 'remove'; name: string }
  | { action: 'set-in-backend'; name: string; scope?: string; backend: string; reference: string }
  | { action: 'save-template'; name: string; image: string; secrets: string[] } | { action: 'remove-template' | 'approve-template'; name: string };
type Send = (e: Edit, done: string) => Promise<boolean>;

function Label({ children }: { children: React.ReactNode }) {
  return <div className="text-xs font-medium text-muted-foreground">{children}</div>;
}

/** A write-only value: never filled in from the hopper, never remembered by the browser. */
function ValueInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Input className="h-9 font-mono text-sm" type="password" value={value} required maxLength={65536}
      autoComplete="new-password" autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(e) => onChange(e.target.value)} />
  );
}

/** Where the value is kept: in the hopper (`''`), or in one of the vault backends, by name. */
function KeptIn({ backends, kept, local, onChange }: { backends: VaultBackendView[]; kept: string; local: boolean; onChange: (k: string) => void }) {
  const choices = [...(local ? [{ name: '', label: 'This hopper' }] : []), ...backends.map((b) => ({ name: b.name, label: b.name }))];
  return (
    <div className="space-y-1"><Label>Kept in — this hopper, or a vault backend you added in Plugins</Label>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Kept in">
        {choices.map((c) => (
          <button key={c.name} type="button" role="radio" aria-checked={kept === c.name} onClick={() => onChange(c.name)}
            className={`min-h-8 rounded-md border px-2 text-xs transition-colors ${kept === c.name ? 'border-primary bg-primary text-primary-foreground' : 'border-input text-muted-foreground hover:bg-muted'}`}>{c.label}</button>
        ))}
      </div>
    </div>
  );
}

function SetForm({ secret, backends, local, busy, send, onDone }: { secret?: VaultSecret; backends: VaultBackendView[]; local: boolean; busy: boolean; send: Send; onDone: () => void }) {
  const [name, setName] = useState(secret?.name ?? '');
  const [scope, setScope] = useState(secret?.scope ?? '');
  const [value, setValue] = useState('');
  const [kept, setKept] = useState(secret?.backend?.name ?? (local ? '' : backends[0]?.name ?? ''));
  const [reference, setReference] = useState(secret?.backend?.reference ?? '');
  const backend = backends.find((b) => b.name === kept);
  const problem = name ? nameProblem(name.trim()) : undefined;
  const ready = backend ? reference.trim() !== '' : value !== '';
  return (
    <form className="space-y-3" onSubmit={async (e) => {
      e.preventDefault();
      const n = name.trim();
      const edit: Edit = backend ? { action: 'set-in-backend', name: n, scope: scope.trim(), backend: backend.name, reference: reference.trim() } : { action: 'set', name: n, scope: scope.trim(), value };
      const ok = await send(edit, secret ? `${n}: replaced` : `${n}: set`);
      setValue('');
      if (ok) onDone();
    }}>
      {!secret && (
        <label className="block space-y-1"><Label>Name — how a job asks for it; fixed once set</Label>
          <Input className="h-9 font-mono text-sm" value={name} required autoCapitalize="off" autoCorrect="off" spellCheck={false}
            placeholder="KUBE_TOKEN" onChange={(e) => setName(e.target.value)} />
          {problem && <div className="text-xs text-bad">{problem}</div>}</label>
      )}
      <label className="block space-y-1"><Label>Scope — what it reaches, in your words (optional)</Label>
        <Input className="h-9 text-sm" value={scope} maxLength={200} placeholder="k3s lab, namespace default, read-only" onChange={(e) => setScope(e.target.value)} /></label>
      {backends.length > 0 && <KeptIn backends={backends} kept={kept} local={local} onChange={setKept} />}
      {backend ? (
        <label className="block space-y-1"><Label>Where it is in {backend.name} — read there each time a job asks; the hopper keeps no copy</Label>
          <Input className="h-9 font-mono text-sm" value={reference} required maxLength={500} autoCapitalize="off" autoCorrect="off" spellCheck={false}
            placeholder={referenceHint(backend.plugin)} onChange={(e) => setReference(e.target.value)} />
          {(backend.problem ?? backend.setup) && <div className="text-xs text-warn break-words">{backend.problem ?? backend.setup}</div>}</label>
      ) : (
        <label className="block space-y-1"><Label>Value — kept encrypted; never shown again, to anyone</Label>
          <ValueInput value={value} onChange={setValue} /></label>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || !ready || !name.trim() || problem !== undefined}>{secret ? 'Replace' : 'Set secret'}</Button>
        <Button type="button" variant="outline" disabled={busy} onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}

function SecretItem({ s, backends, local, can, busy, send }: { s: VaultSecret; backends: VaultBackendView[]; local: boolean; can: boolean; busy: boolean; send: Send }) {
  const [replacing, setReplacing] = useState(false);
  return (
    <li className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <KeyRound className="size-4 text-muted-foreground" />
        <span className="font-mono text-sm font-medium break-all">{s.name}</span>
        <span className="text-xs text-muted-foreground">{keptText(s)}</span>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        {secretFacts(s).map((f) => <div key={f.label} className="contents"><dt className="text-muted-foreground">{f.label}</dt><dd className="break-words">{f.value}</dd></div>)}
      </dl>
      {replacing ? <SetForm secret={s} backends={backends} local={local} busy={busy} send={send} onDone={() => setReplacing(false)} /> : (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={!can || busy} onClick={() => setReplacing(true)}><RefreshCw />Replace</Button>
          <Confirm title={`Remove ${s.name}?`} action="Remove" onConfirm={() => void send({ action: 'remove', name: s.name }, `${s.name}: removed`)}
            description="The secret is deleted. A job that asks for it afterwards gets nothing.">
            <Button size="sm" variant="destructive" disabled={!can || busy}><Trash2 />Remove</Button>
          </Confirm>
        </div>
      )}
    </li>
  );
}

/** A template's form: its name (fixed once saved), its image, and the vault secrets its boxes may ask for. */
function TemplateForm({ t, secrets, busy, send, onDone }: { t?: TemplateView; secrets: VaultSecret[]; busy: boolean; send: Send; onDone: () => void }) {
  const [name, setName] = useState(t?.name ?? '');
  const [image, setImage] = useState(t?.image ?? DEFAULT_BOX_IMAGE);
  const [scope, setScope] = useState<string[]>(t?.secrets ?? []);
  const toggle = (n: string) => setScope(scope.includes(n) ? scope.filter((x) => x !== n) : [...scope, n]);
  return (
    <form className="space-y-3" onSubmit={async (e) => {
      e.preventDefault();
      if (await send({ action: 'save-template', name: name.trim(), image: image.trim(), secrets: scope }, `${name.trim()}: saved`)) onDone();
    }}>
      {!t && (
        <label className="block space-y-1"><Label>Name — its boxes are named hopper-sandbox-&lt;name&gt;</Label>
          <Input className="h-9 font-mono text-sm" value={name} required maxLength={64} pattern="[a-z0-9][a-z0-9._\-]*" autoCapitalize="off" autoCorrect="off" spellCheck={false}
            placeholder="kube" onChange={(e) => setName(e.target.value)} /></label>
      )}
      <label className="block space-y-1"><Label>Image — what its boxes run</Label>
        <Input className="h-9 font-mono text-sm" value={image} required maxLength={300} autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(e) => setImage(e.target.value)} /></label>
      <div className="space-y-1"><Label>Secrets its boxes may ask for</Label>
        {secrets.length === 0 ? <div className="text-xs text-muted-foreground">Add a secret above first.</div> : (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Secrets">
            {secrets.map((s) => {
              const on = scope.includes(s.name);
              return <button key={s.id} type="button" aria-pressed={on} disabled={busy} onClick={() => toggle(s.name)}
                className={`min-h-8 rounded-md border px-2 font-mono text-xs transition-colors ${on ? 'border-primary bg-primary text-primary-foreground' : 'border-input text-muted-foreground hover:bg-muted'}`}>{s.name}</button>;
            })}
          </div>
        )}
      </div>
      <p className="text-xs text-muted-foreground">A new secret or a new image waits for your approval before any box gets it.</p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || !name.trim() || !image.trim()}>Save template</Button>
        <Button type="button" variant="outline" disabled={busy} onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}

function TemplateItem({ t, secrets, can, busy, send }: { t: TemplateView; secrets: VaultSecret[]; can: boolean; busy: boolean; send: Send }) {
  const [editing, setEditing] = useState(false);
  const waiting = !t.approval || t.pending.image || t.pending.secrets.length > 0;
  return (
    <li className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Boxes className="size-4 text-muted-foreground" />
        <span className="font-mono text-sm font-medium break-all">{t.name}</span>
        <span className={`text-xs ${waiting ? 'text-warn' : 'text-muted-foreground'}`}>{approvalText(t)}</span>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Image</dt><dd className="font-mono break-all">{t.image}</dd>
        <dt className="text-muted-foreground">Scope</dt><dd className="font-mono break-words">{t.secrets.join(', ') || 'none'}</dd>
        <dt className="text-muted-foreground">Gives now</dt><dd className="font-mono break-words">{t.gives.join(', ') || 'nothing'}</dd>
        {t.approval && <><dt className="text-muted-foreground">Approved by</dt><dd className="break-words">{t.approval.by} · {new Date(t.approval.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</dd></>}
      </dl>
      {editing ? <TemplateForm t={t} secrets={secrets} busy={busy} send={send} onDone={() => setEditing(false)} /> : (
        <div className="flex flex-wrap gap-2">
          {waiting && (
            <Confirm title={`Approve ${t.name}?`} action="Approve" onConfirm={() => void send({ action: 'approve-template', name: t.name }, `${t.name}: approved`)}
              description={<>Boxes from <span className="font-mono">{t.image}</span> may then ask for <span className="font-mono">{t.secrets.join(', ') || 'nothing'}</span>, whatever job runs in them.</>}>
              <Button size="sm" disabled={!can || busy}><Check />Approve</Button>
            </Confirm>
          )}
          <Button size="sm" variant="outline" disabled={!can || busy} onClick={() => setEditing(true)}><Pencil />Edit</Button>
          <Confirm title={`Remove ${t.name}?`} action="Remove" onConfirm={() => void send({ action: 'remove-template', name: t.name }, `${t.name}: removed`)}
            description="Its boxes keep running, and get nothing from the vault.">
            <Button size="sm" variant="destructive" disabled={!can || busy}><Trash2 />Remove</Button>
          </Confirm>
        </div>
      )}
    </li>
  );
}

export function Vault() {
  const can = useCanAdmin();
  const [view, setView] = useState<VaultView | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addingTemplate, setAddingTemplate] = useState(false);
  const lastChange = useHopper((s) => s.events.find((e) => e.type.startsWith('vault.'))?.id);
  useEffect(() => { get<VaultView>('/api/vault').then(setView, (e: unknown) => toast.error((e as Error).message)); }, [lastChange]);

  const send = async (edit: Edit, done: string): Promise<boolean> => {
    setBusy(true);
    try {
      setView(await post<VaultView>('/ui/api/vault', edit));
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

  const secrets = view?.secrets ?? [];
  const templates = view?.templates ?? [];
  const backends = view?.backends ?? [];
  // A value kept in the hopper needs its token key; a secret kept in a backend does not.
  const local = view !== null && view.problem === undefined;
  return (
    <div className="max-w-2xl space-y-3">
      <Panel title="Vault" icon={LockKeyhole} count={secrets.length || ''} bodyClassName="space-y-3"
        action={can && !adding ? <Button size="sm" onClick={() => setAdding(true)} disabled={busy || (!local && backends.length === 0)}><Plus />Add secret</Button> : undefined}>
        <p className="text-sm text-muted-foreground">Secrets for jobs, set once and never read back: no page and no API answer shows a value, to any role. Each is kept encrypted in the hopper's database, or in a vault backend you add in Plugins (HashiCorp Vault, 1Password, Bitwarden): then the hopper reads it there each time a job asks, and keeps no copy.</p>
        {view?.problem && <p className="text-sm text-bad break-words">{view.problem}</p>}
        {adding && <div className="rounded-md border p-3"><SetForm backends={backends} local={local} busy={busy} send={send} onDone={() => setAdding(false)} /></div>}
        {view && secrets.length === 0 && !adding && <Empty>No secrets yet.</Empty>}
        {secrets.length > 0 && <ul className="space-y-2">{secrets.map((s) => <SecretItem key={s.id} s={s} backends={backends} local={local} can={can} busy={busy} send={send} />)}</ul>}
      </Panel>
      <Panel title="Templates" icon={Boxes} count={templates.length || ''} bodyClassName="space-y-3"
        action={can && !addingTemplate ? <Button size="sm" onClick={() => setAddingTemplate(true)} disabled={busy}><Plus />Add template</Button> : undefined}>
        <p className="text-sm text-muted-foreground">A template is an image and the secrets its boxes may ask for. A sandbox box added from Machines with a template gets those secrets, once you approve the template: never more, whatever job runs in it.</p>
        {addingTemplate && <div className="rounded-md border p-3"><TemplateForm secrets={secrets} busy={busy} send={send} onDone={() => setAddingTemplate(false)} /></div>}
        {view && templates.length === 0 && !addingTemplate && <Empty>No templates yet.</Empty>}
        {templates.length > 0 && <ul className="space-y-2">{templates.map((t) => <TemplateItem key={t.name} t={t} secrets={secrets} can={can} busy={busy} send={send} />)}</ul>}
      </Panel>
    </div>
  );
}
