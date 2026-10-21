// Vault (issue #558): write-only secrets for jobs. Each is set once — a name, an optional scope saying what
// it reaches, a value — and from then on only its metadata shows: no view, and no answer the page gets, holds a value.
// Replace types a new value over it; Remove deletes it. Templates: an image and the secrets its boxes may ask for,
// approved once by a person and again for a new secret or a new image. A template's operation profiles (issue #584)
// rate its blast radius with its secrets, shown next to it: approving the template approves its read profiles; a write,
// sync or apply profile takes its own explicit approval. The approvals, and what jobs on boxes ask for, are on Access
// requests (issue #897): this page is configuration only, and links a template that waits there. Editing is an admin's. A secret may instead be kept in a vault
// backend (issue #585): the person names the backend and where the value is there, never the value. A minting
// credential (issue #580) says the AWS account or cluster the hopper mints short-lived credentials for from it; it is
// never given to a box, so no template lists it. The hopper's own secrets
// (issue #658): the vault's system scope and its audit trail, read-only (vault-system.tsx). Shared secrets (issue #718):
// what the hopper's admin shares with agents (vault-shared.tsx); a template may name one as shared/<name>. The read
// policy (issue #716, vault-read-policy.tsx): what the hopper approves with no person, for a template a job asks for. The
// template request on the page (issue #708, vault-template-request.tsx): the needs a box's work has, and the template the hopper makes from them.
// The master key's rotation, the hopper's admin's (app/master-key.tsx, issue #659). A template's form, with the limits a
// launch of it may ask for (issue #708): vault-template-form.tsx. Infra plans and out-of-band changes have their own view, Infra (issue #896): a link here.
import { Ban, Boxes, KeyRound, LockKeyhole, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Confirm } from '@/components/confirm';
import { TemplateRadiusBadge, TemplateRadiusReasons } from '@/components/template-radius';
import { Empty, Panel } from '@/components/panel';
import { approvalText, keptText, mintsOf, mintsValueOf, nameProblem, profileText, referenceHint, secretFacts, templateWaits, toolsText, egressText, bastionTargetsText } from '@/model/vault';
import type { Asset, OperationProfile, SharedSecretView, TemplateView, VaultBackendView, VaultSecret } from '@/model/wire';
import { Label, ValueInput } from '@/components/vault-fields';
import { sendVault, setVaultView, useVault, useVaultStore } from '@/store/vault';
import { SystemSecrets } from './vault-system';
import { SharedSecrets } from './vault-shared';
import { ReadPolicy } from './vault-read-policy';
import { SandboxApprovals } from './sandbox-approvals';
import { SandboxStrictness } from './sandbox-strictness';
import { TemplateRequest } from './vault-template-request';
import { sameProfile, TemplateForm } from './vault-template-form';
import { limitsText, type TemplateLimits } from '@/model/sandbox-launch';
import { agentCredentialText } from '@/model/vault-agent-credential';
import { MasterKeyRotation } from '@/app/master-key';
import { CheckAgain, GateRows } from './vault-check';
import { ShortClusters } from './unknown-assets';
import { useCanAdmin } from '@/store/selectors';

type Edit = { action: 'set'; name: string; scope?: string; value: string; mints?: Asset | null } | { action: 'remove'; name: string }
  | { action: 'set-in-backend'; name: string; scope?: string; backend: string; reference: string; mints?: Asset | null } | { action: 'system-in-backend'; name: string; backend: string; reference: string }
  | { action: 'save-template'; name: string; image: string; secrets: string[]; profiles: OperationProfile[]; tools?: string[]; egress?: string[]; bastionTargets?: string[]; limits?: TemplateLimits; agentCredential?: string | null; probeMarks?: Record<string, string> } | { action: 'remove-template' | 'approve-template' | 'revoke-template' | 'check-template'; name: string }
  | ({ action: 'approve-profile'; name: string } & OperationProfile)
  | { action: 'give-credential'; request: string; name: string; kind: string; note?: string; value?: string } | { action: 'decline-credential'; request: string; reason: string };
export type VaultEdit = Edit;
export type Send = (e: Edit, done: string) => Promise<boolean>;

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

/** The form that sets a secret, or replaces `secret`. `mintsFor`: what Mints for starts with, for a new secret (`aws-account/`). */
export function SetForm({ secret, mintsFor, backends, local, busy, send, onDone }: { secret?: VaultSecret; mintsFor?: string; backends: VaultBackendView[]; local: boolean; busy: boolean; send: Send; onDone: () => void }) {
  const [name, setName] = useState(secret?.name ?? '');
  const [scope, setScope] = useState(secret?.scope ?? '');
  const [mintsSaid, setMintsSaid] = useState(secret?.mints ? `${secret.mints.kind}/${secret.mints.name}` : mintsFor ?? '');
  const [value, setValue] = useState('');
  const [kept, setKept] = useState(secret?.backend?.name ?? (local ? '' : backends[0]?.name ?? ''));
  const [reference, setReference] = useState(secret?.backend?.reference ?? '');
  const backend = backends.find((b) => b.name === kept);
  const problem = name ? nameProblem(name.trim()) : undefined;
  const ready = backend ? reference.trim() !== '' : value !== '';
  const mints = mintsOf(mintsSaid);
  const valueShape = mintsValueOf(typeof mints === 'object' ? mints : undefined, backend ? '' : value);
  return (
    <form className="space-y-3" onSubmit={async (e) => {
      e.preventDefault();
      const n = name.trim();
      const minting = { mints: typeof mints === 'object' ? mints : null };
      const edit: Edit = backend ? { action: 'set-in-backend', name: n, scope: scope.trim(), backend: backend.name, reference: reference.trim(), ...minting } : { action: 'set', name: n, scope: scope.trim(), value, ...minting };
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
      <label className="block space-y-1"><Label>Mints for — the hopper mints short-lived credentials from it and never gives it out (optional)</Label>
        <Input className="h-9 font-mono text-sm" value={mintsSaid} maxLength={220} autoCapitalize="off" autoCorrect="off" spellCheck={false}
          placeholder="cluster/lab or aws-account/123456789012" onChange={(e) => setMintsSaid(e.target.value)} />
        {typeof mints === 'string' && <div className="text-xs text-bad">{mints}</div>}</label>
      {backends.length > 0 && <KeptIn backends={backends} kept={kept} local={local} onChange={setKept} />}
      {backend ? (
        <label className="block space-y-1"><Label>Where it is in {backend.name} — read there each time a job asks; the hopper keeps no copy</Label>
          <Input className="h-9 font-mono text-sm" value={reference} required maxLength={500} autoCapitalize="off" autoCorrect="off" spellCheck={false}
            placeholder={referenceHint(backend.plugin)} onChange={(e) => setReference(e.target.value)} />
          {(backend.problem ?? backend.setup) && <div className="text-xs text-warn break-words">{backend.problem ?? backend.setup}</div>}</label>
      ) : (
        <label className="block space-y-1"><Label>Value — kept encrypted; never shown again, to anyone</Label>
          <ValueInput value={value} onChange={setValue} />
          {valueShape.shape && <div className="text-xs text-muted-foreground break-words">{valueShape.shape}</div>}
          {valueShape.problem && <div className="text-xs text-bad">{valueShape.problem}</div>}</label>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || !ready || !name.trim() || problem !== undefined || typeof mints === 'string' || valueShape.problem !== undefined}>{secret ? 'Replace' : 'Set secret'}</Button>
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

function TemplateItem({ t, secrets, shared, can, busy, send }: { t: TemplateView; secrets: VaultSecret[]; shared: SharedSecretView[]; can: boolean; busy: boolean; send: Send }) {
  const [editing, setEditing] = useState(false);
  const waiting = templateWaits(t) || (t.unknownAssets?.length ?? 0) > 0;
  return (
    <li className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Boxes className="size-4 text-muted-foreground" />
        <span className="font-mono text-sm font-medium break-all">{t.name}</span>
        <TemplateRadiusBadge radius={t.radius} />
        <span className={`text-xs ${waiting ? 'text-warn' : 'text-muted-foreground'}`}>{approvalText(t)}</span>
      </div>
      <TemplateRadiusReasons radius={t.radius} />
      <ShortClusters t={t} can={can} />
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Image</dt><dd className="font-mono break-all">{t.image}</dd>
        <dt className="text-muted-foreground">Tools</dt><dd className="font-mono break-words">{toolsText(t)}</dd>
        <dt className="text-muted-foreground">Egress</dt><dd className="font-mono break-words">{egressText(t)}</dd>
        {t.bastionTargets?.length ? <><dt className="text-muted-foreground">Bastion targets</dt><dd className="font-mono break-words">{bastionTargetsText(t)}</dd></> : null}
        <dt className="text-muted-foreground">Scope</dt><dd className="font-mono break-words">{t.secrets.join(', ') || 'none'}</dd>
        <dt className="text-muted-foreground">Profiles</dt><dd className="font-mono break-words">{t.profiles.map((p) => `${profileText(p)}${t.pending.profiles.some((x) => sameProfile(x, p)) ? ' (waits)' : ''}`).join(', ') || 'none'}</dd>
        <dt className="text-muted-foreground">Limits</dt><dd className="break-words">{limitsText(t.limits)}</dd>
        <dt className="text-muted-foreground">Agent credential</dt><dd className="break-words">{agentCredentialText(t)}</dd>
        <dt className="text-muted-foreground">Gives now</dt><dd className="font-mono break-words">{t.gives.join(', ') || 'nothing'}</dd>
        <GateRows t={t} />
      </dl>
      {editing ? <TemplateForm t={t} secrets={secrets} shared={shared} busy={busy} send={send} onDone={() => setEditing(false)} /> : (
        <div className="flex flex-wrap gap-2">
          {waiting && <a href="#approvals/access-requests" data-template-waits={t.name} className="inline-flex h-8 items-center text-sm text-warn hover:underline">Approve on Access requests →</a>}
          {t.approval && (
            <Confirm title={`Revoke the approval of ${t.name}?`} action="Revoke" onConfirm={() => void send({ action: 'revoke-template', name: t.name }, `${t.name}: approval revoked`)}
              description="Its boxes take no new job and get nothing from the vault until a person approves it again. Jobs that run there now keep running.">
              <Button size="sm" variant="outline" disabled={!can || busy}><Ban />Revoke</Button>
            </Confirm>
          )}
          <CheckAgain t={t} can={can} busy={busy} send={send} />
          <Button size="sm" variant="outline" disabled={!can || busy} onClick={() => setEditing(true)}><Pencil />Edit</Button>
          <Confirm title={`Remove ${t.name}?`} action="Remove" onConfirm={() => void send({ action: 'remove-template', name: t.name }, `${t.name}: removed`)}
            description="Its boxes keep running, take no new job, and get nothing from the vault.">
            <Button size="sm" variant="destructive" disabled={!can || busy}><Trash2 />Remove</Button>
          </Confirm>
        </div>
      )}
    </li>
  );
}

export function Vault() {
  const can = useCanAdmin();
  const view = useVault();
  const busy = useVaultStore((s) => s.busy);
  const error = useVaultStore((s) => s.error);
  const [adding, setAdding] = useState(false);
  const [addingTemplate, setAddingTemplate] = useState(false);
  const send: Send = sendVault;
  const setView = setVaultView;

  const secrets = view?.secrets ?? [];
  const templates = view?.templates ?? [];
  const shared = view?.shared ?? [];
  const backends = view?.backends ?? [];
  // A value kept in the hopper needs its master key; a secret kept in a backend does not.
  const local = view !== null && view.problem === undefined;
  return (
    <div className="max-w-2xl space-y-3">
      <p data-slot="vault-infra-link" className="text-sm text-muted-foreground">Plans, applies and out-of-band changes of infrastructure are on <a href="#infra" className="underline">Infra</a>.</p>
      <Panel title="Vault" icon={LockKeyhole} count={secrets.length || ''} bodyClassName="space-y-3"
        action={can && !adding ? <Button size="sm" onClick={() => setAdding(true)} disabled={busy || (!local && backends.length === 0)}><Plus />Add secret</Button> : undefined}>
        <p className="text-sm text-muted-foreground">Secrets for jobs, set once and never read back: no page and no API answer shows a value, to any role. Each is kept encrypted in the hopper's database, or in a vault backend you add in Plugins (HashiCorp Vault, 1Password, Bitwarden): then the hopper reads it there each time a job asks, and keeps no copy.</p>
        {view?.problem && <p className="text-sm text-bad break-words">{view.problem}</p>}
        {!view && error && <p className="text-sm text-bad break-words">Could not read the vault: {error}</p>}
        {adding && <div className="rounded-md border p-3"><SetForm backends={backends} local={local} busy={busy} send={send} onDone={() => setAdding(false)} /></div>}
        {view && secrets.length === 0 && !adding && <Empty>No secrets yet.</Empty>}
        {secrets.length > 0 && <ul className="space-y-2">{secrets.map((s) => <SecretItem key={s.id} s={s} backends={backends} local={local} can={can} busy={busy} send={send} />)}</ul>}
      </Panel>
      <Panel title="Templates" icon={Boxes} count={templates.length || ''} bodyClassName="space-y-3"
        action={can && !addingTemplate ? <Button size="sm" onClick={() => setAddingTemplate(true)} disabled={busy}><Plus />Add template</Button> : undefined}>
        <p className="text-sm text-muted-foreground">A template is an image and the secrets its boxes may ask for. A sandbox box added from Machines with a template gets those secrets, once you approve the template: never more, whatever job runs in it.</p>
        {addingTemplate && <div className="rounded-md border p-3"><TemplateForm secrets={secrets} shared={shared} busy={busy} send={send} onDone={() => setAddingTemplate(false)} /></div>}
        {view && templates.length === 0 && !addingTemplate && <Empty>No templates yet.</Empty>}
        {templates.length > 0 && <ul className="space-y-2">{templates.map((t) => <TemplateItem key={t.name} t={t} secrets={secrets} shared={shared} can={can} busy={busy} send={send} />)}</ul>}
      </Panel>
      {view && <TemplateRequest onView={setView} />}
      {view && <SandboxApprovals approvals={view.sandboxApprovals} remembered={view.rememberedWrites ?? []} can={can} busy={busy} />}
      {view && <SandboxStrictness />}
      {view && <ReadPolicy entries={view.readPolicy ?? []} onView={setView} />}
      {view && <SharedSecrets shared={shared} onView={setView} />}
      {view && <SystemSecrets system={view.system} backends={backends} can={can} busy={busy} send={send} />}
      {view && <MasterKeyRotation />}
    </div>
  );
}
