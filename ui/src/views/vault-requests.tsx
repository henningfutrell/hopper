// Settings → Vault, Asked for (issue #583, design.md "The dynamic vault"): the credentials jobs on boxes asked for and
// the vault does not give. Each card says who waits and why and how to get the credential; an admin gives one — of the
// kind the hopper suggests, or another, in their own words — or declines with a reason. The value is never shown.
import { Check, MessageSquareWarning, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Panel } from '@/components/panel';
import { Label, ValueInput } from '@/components/vault-fields';
import { giveProblem, kindChoices, requestWaiting } from '@/model/vault';
import type { CredentialRequest } from '@/model/wire';
import type { Send } from './vault';

/** A credential request (issue #583): what jobs wait on, how to get the credential, and the admin's answer. */
function RequestItem({ r, can, busy, send }: { r: CredentialRequest; can: boolean; busy: boolean; send: Send }) {
  const [kind, setKind] = useState(r.kinds[0]?.id ?? 'other');
  const [note, setNote] = useState('');
  const [name, setName] = useState(r.existing[0] ?? r.secret);
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const problem = giveProblem({ name, kind, note, value }, r);
  const existing = r.existing.includes(name.trim());
  return (
    <li className="space-y-3 rounded-md border border-warn/50 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <MessageSquareWarning className="size-4 text-warn" />
        <span className="text-sm font-medium">{r.title}</span>
        <span className="text-xs text-muted-foreground">for boxes of <span className="font-mono">{r.template}</span>{r.known ? '' : ' · the hopper has no skill for it: the job said what it takes'}</span>
      </div>
      <ul className="space-y-0.5 text-xs">{requestWaiting(r).map((w) => <li key={w} className="break-words">Waits: {w}</li>)}</ul>
      <p className="text-xs text-muted-foreground break-words">How to get one: {r.setup}</p>
      {can ? (
        <form className="space-y-3" onSubmit={async (e) => {
          e.preventDefault();
          const ok = await send({ action: 'give-credential', request: r.id, name: name.trim(), kind, ...(note.trim() ? { note: note.trim() } : {}), ...(value ? { value } : {}) }, `${r.title}: given as ${name.trim()}`);
          if (ok) setValue('');
        }}>
          <div className="space-y-1" role="radiogroup" aria-label="What you give"><Label>What you give — the first is the hopper's suggestion; any kind works</Label>
            {kindChoices(r).map((k) => (
              <label key={k.id} className="flex items-start gap-2 text-sm">
                <input type="radio" name={`kind-${r.id}`} className="mt-1" checked={kind === k.id} onChange={() => setKind(k.id)} />{k.title}
              </label>
            ))}
          </div>
          {kind === 'other' && (
            <label className="block space-y-1"><Label>What it is, in your words — the job reads this, never the value</Label>
              <Input className="h-9 text-sm" value={note} maxLength={200} placeholder="a team key, read-only" onChange={(e) => setNote(e.target.value)} /></label>
          )}
          <label className="block space-y-1"><Label>Vault secret name{r.existing.length ? ` — or one you set before: ${r.existing.join(', ')}` : ''}</Label>
            <Input className="h-9 font-mono text-sm" value={name} required maxLength={64} autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(e) => setName(e.target.value)} /></label>
          <label className="block space-y-1"><Label>Value — kept encrypted; never shown again, to anyone{existing ? ' (empty: keep the one the vault holds)' : ''}</Label>
            <ValueInput value={value} onChange={setValue} required={!existing} /></label>
          <p className="text-xs text-muted-foreground">Boxes of {r.template} may then ask for it, whatever job runs in them.</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={busy || problem !== undefined}><Check />Give</Button>
            <Input className="h-9 w-56 text-sm" value={reason} maxLength={200} placeholder="Why not (for the job)" aria-label="Why not" onChange={(e) => setReason(e.target.value)} />
            <Button type="button" variant="outline" disabled={busy} onClick={() => void send({ action: 'decline-credential', request: r.id, reason: reason.trim() }, `${r.title}: declined`)}><X />Decline</Button>
          </div>
          {problem && (value || note || kind === 'other') && <div className="text-xs text-muted-foreground">{problem}</div>}
        </form>
      ) : <p className="text-xs text-muted-foreground">An admin gives it here.</p>}
    </li>
  );
}

export function AskedFor({ requests, can, busy, send }: { requests: CredentialRequest[]; can: boolean; busy: boolean; send: Send }) {
  if (requests.length === 0) return null;
  return (
    <Panel title="Asked for" icon={MessageSquareWarning} count={requests.length} bodyClassName="space-y-3">
      <p className="text-sm text-muted-foreground">Jobs on boxes need these credentials, and wait until you give one or decline. Give the kind the hopper suggests, or any other: the job is told what you gave, never the value.</p>
      <ul className="space-y-2">{requests.map((r) => <RequestItem key={r.id} r={r} can={can} busy={busy} send={send} />)}</ul>
    </Panel>
  );
}
