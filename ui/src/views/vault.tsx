// Settings → Vault (issue #558): write-only secrets for jobs. Each is set once — a name, an optional scope saying what
// it reaches, a value — and from then on only its metadata shows: no view, and no answer the page gets, holds a value.
// Replace types a new value over it; Remove deletes it. Templates: an image and the secrets its boxes may ask for,
// approved once by a person and again for a new secret or a new image. A template's operation profiles (issue #584)
// rate its blast radius with its secrets, shown next to it: approving the template approves its read profiles; a write,
// sync or apply profile takes its own explicit approval. A minting credential (issue #580) says the AWS account or
// cluster the hopper mints short-lived credentials for from it; it is never given to a box, so no template lists it.
// Editing is an admin's.
import { Boxes, Check, KeyRound, LockKeyhole, Pencil, Plus, RefreshCw, ShieldAlert, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Confirm } from '@/components/confirm';
import { FIELD } from '@/components/plugin-form';
import { TemplateRadiusBadge, TemplateRadiusReasons } from '@/components/template-radius';
import { Empty, Panel } from '@/components/panel';
import { get, post, SessionRejected } from '@/lib/api';
import { approvalText, DEFAULT_BOX_IMAGE, explicitApprovals, highRadius, mintsOf, nameProblem, profileText, secretFacts } from '@/model/vault';
import type { Asset, AssetKind, Operation, OperationProfile, TemplateView, VaultSecret, VaultView } from '@/model/wire';
import { useHopper } from '@/store';
import { useCanAdmin } from '@/store/selectors';

type Edit = { action: 'set'; name: string; scope?: string; value: string; mints?: Asset | null } | { action: 'remove'; name: string }
  | { action: 'save-template'; name: string; image: string; secrets: string[]; profiles: OperationProfile[] } | { action: 'remove-template' | 'approve-template'; name: string }
  | ({ action: 'approve-profile'; name: string } & OperationProfile);
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

function SetForm({ secret, busy, send, onDone }: { secret?: VaultSecret; busy: boolean; send: Send; onDone: () => void }) {
  const [name, setName] = useState(secret?.name ?? '');
  const [scope, setScope] = useState(secret?.scope ?? '');
  const [mintsSaid, setMintsSaid] = useState(secret?.mints ? `${secret.mints.kind}/${secret.mints.name}` : '');
  const [value, setValue] = useState('');
  const problem = name ? nameProblem(name.trim()) : undefined;
  const mints = mintsOf(mintsSaid);
  return (
    <form className="space-y-3" onSubmit={async (e) => {
      e.preventDefault();
      const n = name.trim();
      const ok = await send({ action: 'set', name: n, scope: scope.trim(), value, mints: typeof mints === 'object' ? mints : null }, secret ? `${n}: replaced` : `${n}: set`);
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
      <label className="block space-y-1"><Label>Mints for — the hopper mints short-lived credentials from it and never gives it out (optional)</Label>
        <Input className="h-9 font-mono text-sm" value={mintsSaid} maxLength={220} autoCapitalize="off" autoCorrect="off" spellCheck={false}
          placeholder="cluster/lab or aws-account/123456789012" onChange={(e) => setMintsSaid(e.target.value)} />
        {typeof mints === 'string' && <div className="text-xs text-bad">{mints}</div>}</label>
      <label className="block space-y-1"><Label>Value — kept encrypted; never shown again, to anyone</Label>
        <ValueInput value={value} onChange={setValue} /></label>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || !value || !name.trim() || problem !== undefined || typeof mints === 'string'}>{secret ? 'Replace value' : 'Set secret'}</Button>
        <Button type="button" variant="outline" disabled={busy} onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}

function SecretItem({ s, can, busy, send }: { s: VaultSecret; can: boolean; busy: boolean; send: Send }) {
  const [replacing, setReplacing] = useState(false);
  return (
    <li className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <KeyRound className="size-4 text-muted-foreground" />
        <span className="font-mono text-sm font-medium break-all">{s.name}</span>
        <span className="text-xs text-muted-foreground">value set · write-only</span>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        {secretFacts(s).map((f) => <div key={f.label} className="contents"><dt className="text-muted-foreground">{f.label}</dt><dd className="break-words">{f.value}</dd></div>)}
      </dl>
      {replacing ? <SetForm secret={s} busy={busy} send={send} onDone={() => setReplacing(false)} /> : (
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

const OPERATIONS: Operation[] = ['read', 'write', 'sync', 'apply'];
const ASSET_KINDS: AssetKind[] = ['cluster', 'namespace', 'argocd-app', 'terraform-workspace', 'aws-account', 'aws-role'];
const sameProfile = (a: OperationProfile, b: OperationProfile) => profileText(a) === profileText(b);

/** The operation profiles a template's boxes may ask for: each removable, and one more added from an operation, an asset kind and a name. */
function ProfilesInput({ profiles, busy, onChange }: { profiles: OperationProfile[]; busy: boolean; onChange: (p: OperationProfile[]) => void }) {
  const [operation, setOperation] = useState<Operation>('read');
  const [kind, setKind] = useState<AssetKind>('cluster');
  const [asset, setAsset] = useState('');
  const add = () => {
    const p = { operation, asset: { kind, name: asset.trim() } };
    if (!profiles.some((x) => sameProfile(x, p))) onChange([...profiles, p]);
    setAsset('');
  };
  return (
    <div className="space-y-1"><Label>Operation profiles its boxes may ask for — write, sync and apply each need their own approval</Label>
      {profiles.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Operation profiles">
          {profiles.map((p) => (
            <li key={profileText(p)} className={`flex min-h-8 items-center gap-1 rounded-md border px-2 font-mono text-xs ${highRadius(p) ? 'border-warn' : ''}`}>
              {profileText(p)}
              <button type="button" aria-label={`Remove ${profileText(p)}`} disabled={busy} onClick={() => onChange(profiles.filter((x) => !sameProfile(x, p)))}><X className="size-3" /></button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <select aria-label="Operation" className={`${FIELD} w-24`} value={operation} disabled={busy} onChange={(e) => setOperation(e.target.value as Operation)}>
          {OPERATIONS.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
        <select aria-label="Asset kind" className={`${FIELD} w-44`} value={kind} disabled={busy} onChange={(e) => setKind(e.target.value as AssetKind)}>
          {ASSET_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <Input aria-label="Asset" className="h-8 w-40 font-mono text-xs" value={asset} placeholder="lab" maxLength={200} disabled={busy} autoCapitalize="off" autoCorrect="off" spellCheck={false}
          onChange={(e) => setAsset(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (asset.trim()) add(); } }} />
        <Button type="button" size="sm" variant="outline" disabled={busy || !asset.trim()} onClick={add}><Plus />Add profile</Button>
      </div>
    </div>
  );
}

/** A template's form: its name (fixed once saved), its image, the vault secrets and the operation profiles its boxes may ask for. */
function TemplateForm({ t, secrets: all, busy, send, onDone }: { t?: TemplateView; secrets: VaultSecret[]; busy: boolean; send: Send; onDone: () => void }) {
  // A minting credential is never given to a box: no template's scope lists it.
  const secrets = all.filter((s) => !s.mints);
  const [name, setName] = useState(t?.name ?? '');
  const [image, setImage] = useState(t?.image ?? DEFAULT_BOX_IMAGE);
  const [scope, setScope] = useState<string[]>(t?.secrets ?? []);
  const [profiles, setProfiles] = useState<OperationProfile[]>(t?.profiles ?? []);
  const toggle = (n: string) => setScope(scope.includes(n) ? scope.filter((x) => x !== n) : [...scope, n]);
  return (
    <form className="space-y-3" onSubmit={async (e) => {
      e.preventDefault();
      if (await send({ action: 'save-template', name: name.trim(), image: image.trim(), secrets: scope, profiles }, `${name.trim()}: saved`)) onDone();
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
      <ProfilesInput profiles={profiles} busy={busy} onChange={setProfiles} />
      <p className="text-xs text-muted-foreground">A new secret, a new image or a new profile waits for your approval before any box gets it. A profile you remove loses its approval.</p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || !name.trim() || !image.trim()}>Save template</Button>
        <Button type="button" variant="outline" disabled={busy} onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}

function TemplateItem({ t, secrets, can, busy, send }: { t: TemplateView; secrets: VaultSecret[]; can: boolean; busy: boolean; send: Send }) {
  const [editing, setEditing] = useState(false);
  const waiting = !t.approval || t.pending.image || t.pending.secrets.length > 0 || t.pending.profiles.some((p) => !highRadius(p));
  const explicit = explicitApprovals(t);
  return (
    <li className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Boxes className="size-4 text-muted-foreground" />
        <span className="font-mono text-sm font-medium break-all">{t.name}</span>
        <TemplateRadiusBadge radius={t.radius} />
        <span className={`text-xs ${waiting || explicit.length > 0 ? 'text-warn' : 'text-muted-foreground'}`}>{approvalText(t)}</span>
      </div>
      <TemplateRadiusReasons radius={t.radius} />
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Image</dt><dd className="font-mono break-all">{t.image}</dd>
        <dt className="text-muted-foreground">Scope</dt><dd className="font-mono break-words">{t.secrets.join(', ') || 'none'}</dd>
        <dt className="text-muted-foreground">Profiles</dt><dd className="font-mono break-words">{t.profiles.map((p) => `${profileText(p)}${t.pending.profiles.some((x) => sameProfile(x, p)) ? ' (waits)' : ''}`).join(', ') || 'none'}</dd>
        <dt className="text-muted-foreground">Gives now</dt><dd className="font-mono break-words">{t.gives.join(', ') || 'nothing'}</dd>
        {t.approval && <><dt className="text-muted-foreground">Approved by</dt><dd className="break-words">{t.approval.by} · {new Date(t.approval.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</dd></>}
      </dl>
      {editing ? <TemplateForm t={t} secrets={secrets} busy={busy} send={send} onDone={() => setEditing(false)} /> : (
        <div className="flex flex-wrap gap-2">
          {waiting && (
            <Confirm title={`Approve ${t.name}?`} action="Approve" onConfirm={() => void send({ action: 'approve-template', name: t.name }, `${t.name}: approved`)}
              description={<>Boxes from <span className="font-mono">{t.image}</span> may then ask for <span className="font-mono">{t.secrets.join(', ') || 'nothing'}</span>, whatever job runs in them{t.pending.profiles.some((p) => !highRadius(p)) ? <>, and read <span className="font-mono">{t.pending.profiles.filter((p) => !highRadius(p)).map(profileText).join(', ')}</span></> : null}. A write, sync or apply profile is not approved by this.</>}>
              <Button size="sm" disabled={!can || busy}><Check />Approve</Button>
            </Confirm>
          )}
          {explicit.map((p) => (
            <Confirm key={profileText(p)} title={`Approve ${t.name}: ${profileText(p)}?`} action="Approve" onConfirm={() => void send({ action: 'approve-profile', name: t.name, ...p }, `${t.name}: ${profileText(p)} approved`)}
              description={<>This is a high-radius profile: it changes <span className="font-mono">{p.asset.kind} {p.asset.name}</span>. Every job in a box of <span className="font-mono">{t.name}</span> may then {p.operation} there. An approval for read does not cover this.</>}>
              <Button size="sm" variant="outline" disabled={!can || busy}><ShieldAlert />Approve {profileText(p)}</Button>
            </Confirm>
          ))}
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
  return (
    <div className="max-w-2xl space-y-3">
      <Panel title="Vault" icon={LockKeyhole} count={secrets.length || ''} bodyClassName="space-y-3"
        action={can && !adding ? <Button size="sm" onClick={() => setAdding(true)} disabled={busy || view?.problem !== undefined}><Plus />Add secret</Button> : undefined}>
        <p className="text-sm text-muted-foreground">Secrets for jobs, set once and never read back: no page and no API answer shows a value, to any role. Each is kept encrypted in the hopper's database.</p>
        {view?.problem && <p className="text-sm text-bad break-words">{view.problem}</p>}
        {adding && <div className="rounded-md border p-3"><SetForm busy={busy} send={send} onDone={() => setAdding(false)} /></div>}
        {view && secrets.length === 0 && !adding && <Empty>No secrets yet.</Empty>}
        {secrets.length > 0 && <ul className="space-y-2">{secrets.map((s) => <SecretItem key={s.id} s={s} can={can} busy={busy} send={send} />)}</ul>}
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
