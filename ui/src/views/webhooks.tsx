// Webhook subscriptions and their deliveries, live. The subscriptions are kept in the database
// (issue #78); a UI session edits them through POST /ui/api/webhooks (issue #18): add, edit (url,
// events, active), remove. The signing secret is the hopper's own (issue #451): typed in when adding, or
// made by the hopper; kept encrypted and write-only. The card says only that one is set and when it
// changed, and offers Replace (type a new one) and Rotate (the hopper makes one). A secret the hopper made
// is shown once, here, to copy to the receiver; it is never put in the app's store. Send test event
// (issue #378) posts one signed `webhook.test` and shows the receiver's answer.
import { Copy, KeyRound, Pencil, Plus, RefreshCw, Send, Trash2, Webhook } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Confirm } from '@/components/confirm';
import { SendAction } from '@/components/send-action';
import { Empty, Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status';
import { post, SessionRejected } from '@/lib/api';
import { clock } from '@/model/format';
import { EVENT_CHOICES, lastDelivery, secretOf, toggleEvent } from '@/model/webhooks';
import type { WebhooksEdit, WebhookView, WebhooksView } from '@/model/wire';
import { refreshWebhooks, setWebhooks, useHopper } from '@/store';
import { useCanAdmin } from '@/store/selectors';

type Send = (edit: WebhooksEdit, done: string) => Promise<WebhooksView | null>;

/** A secret the hopper made, with the subscription it signs: shown once. */
interface Made { name: string; secret: string }

function useSend(onMade: (m: Made) => void): { send: Send; busy: boolean } {
  const [busy, setBusy] = useState(false);
  const send: Send = async (edit, done) => {
    setBusy(true);
    try {
      const { generatedSecret, ...view } = await post<WebhooksView>('/ui/api/webhooks', edit);
      // The made secret never reaches the app's store: only the one-time box below holds it.
      setWebhooks(view);
      if (generatedSecret !== undefined) onMade({ name: edit.name, secret: generatedSecret });
      toast.success(done);
      return view;
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false });
      toast.error((e as Error).message);
      // Another session may have changed them: show what the database holds now.
      refreshWebhooks().catch(() => {});
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { send, busy };
}

function EventsPicker({ value, onChange, disabled }: { value: string[]; onChange: (v: string[]) => void; disabled: boolean }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Events">
      {EVENT_CHOICES.map((c) => {
        const on = value.includes(c);
        return (
          <button key={c} type="button" aria-pressed={on} disabled={disabled} onClick={() => onChange(toggleEvent(value, c))}
            className={`min-h-8 rounded-md border px-2 font-mono text-xs transition-colors disabled:opacity-50 ${on ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-transparent text-muted-foreground hover:bg-muted'}`}>
            {c === '*' ? '* every event' : c}
          </button>
        );
      })}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="text-xs font-medium text-muted-foreground">{children}</div>;
}

/** A signing secret typed in: what the hopper takes (src/webhooks/edit.ts). Left empty, the hopper makes one. */
const SECRET_PATTERN = '[\\x21-\\x7e]{32,4096}';
const SECRET_HELP = 'at least 32 characters, no spaces. Kept encrypted; never shown again';

/** A write-only secret input: never filled in from the hopper, never remembered by the browser. */
function SecretInput({ value, onChange, required }: { value: string; onChange: (v: string) => void; required?: boolean }) {
  return (
    <Input className="h-9 font-mono text-sm" type="password" value={value} required={required} pattern={SECRET_PATTERN}
      autoComplete="new-password" autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(e) => onChange(e.target.value)} />
  );
}

interface FormValues { name: string; url: string; events: string[]; active: boolean; secret: string }

/** The add form and the edit form: url, events, active. `name` and the signing secret only when adding. */
function SubscriptionForm({ initial, adding, busy, onSubmit, onCancel }: {
  initial: FormValues;
  adding: boolean; busy: boolean;
  onSubmit: (v: FormValues) => void;
  onCancel: () => void;
}) {
  const [v, setV] = useState(initial);
  const submit = (e: React.FormEvent) => { e.preventDefault(); onSubmit({ ...v, name: v.name.trim(), url: v.url.trim() }); };
  return (
    <form onSubmit={submit} className="space-y-3">
      {adding && (
        <label className="block space-y-1"><Label>Name — the subscription's key; fixed once added</Label>
          <Input className="h-9 font-mono text-sm" value={v.name} required autoCapitalize="off" autoCorrect="off" spellCheck={false}
            onChange={(e) => setV({ ...v, name: e.target.value })} /></label>
      )}
      {adding && (
        <label className="block space-y-1"><Label>Signing secret — leave empty and the hopper makes one, shown once to copy to the receiver; or type the receiver's: {SECRET_HELP}</Label>
          <SecretInput value={v.secret} onChange={(secret) => setV({ ...v, secret })} /></label>
      )}
      <label className="block space-y-1"><Label>URL (http or https)</Label>
        <Input className="h-9 font-mono text-sm" type="url" inputMode="url" value={v.url} required autoCapitalize="off" autoCorrect="off" spellCheck={false}
          placeholder="http://127.0.0.1:4795/hook" onChange={(e) => setV({ ...v, url: e.target.value })} /></label>
      <div className="space-y-1"><Label>Events</Label><EventsPicker value={v.events} disabled={busy} onChange={(events) => setV({ ...v, events })} /></div>
      <label className="flex min-h-8 items-center gap-2 text-sm"><Switch checked={v.active} disabled={busy} onCheckedChange={(active) => setV({ ...v, active })} />Active</label>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || !v.url.trim() || !v.events.length || (adding && !v.name.trim())}>{adding ? 'Add subscription' : 'Save'}</Button>
        <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

/** What the card says about the signing secret: set and when, or the runtime variable one from before reads; never the secret. */
function SecretLine({ sub }: { sub: WebhookView }) {
  const s = secretOf(sub);
  return (
    <div className={`flex flex-wrap items-center gap-1.5 text-xs ${s.problem ? 'text-bad' : 'text-muted-foreground'}`}>
      <KeyRound className="size-3.5" />
      {s.kind === 'stored' && <>secret set · changed {clock(s.changedAt)}</>}
      {s.kind === 'runtime' && <>secret from runtime variable <code className="font-mono">{s.variable}</code>: replace to store it in hopper</>}
      {s.kind === 'none' && <>no secret set: replace or rotate it</>}
      {s.problem && <span className="break-words">· {s.problem}: nothing is sent until it is fixed</span>}
    </div>
  );
}

/** Replace: a new secret typed in, write-only. */
function ReplaceForm({ name, busy, send, onDone }: { name: string; busy: boolean; send: Send; onDone: () => void }) {
  const [secret, setSecret] = useState('');
  return (
    <form className="space-y-2" onSubmit={async (e) => {
      e.preventDefault();
      if (await send({ action: 'replace', name, secret }, `${name}: secret replaced; deliveries sign with it from the next one`)) onDone();
    }}>
      <label className="block space-y-1"><Label>New signing secret — the receiver's: {SECRET_HELP}</Label>
        <SecretInput value={secret} required onChange={setSecret} /></label>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={busy || !secret}>Replace secret</Button>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}

/** A secret the hopper made, shown this once: copy it to the receiver. Dismissed, it is gone from the page. */
function MadeSecret({ made, onDone }: { made: Made; onDone: () => void }) {
  const copy = () => navigator.clipboard?.writeText(made.secret).then(() => toast.success('Copied'), () => toast.error('Clipboard blocked: select and copy it'));
  return (
    <div role="alert" className="space-y-2 rounded-lg border border-warn p-3">
      <div className="text-sm font-medium">New signing secret for <span className="font-mono">{made.name}</span></div>
      <div className="text-xs text-muted-foreground">Shown once. Copy it to the receiver now: the hopper keeps it encrypted and never shows it again.</div>
      <code className="block font-mono text-xs break-all select-all">{made.secret}</code>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => void copy()}><Copy />Copy</Button>
        <Button size="sm" onClick={onDone}>Done</Button>
      </div>
    </div>
  );
}

function SubscriptionCard({ sub, authed, send, busy }: {
  sub: WebhookView; authed: boolean; send: Send; busy: boolean;
}) {
  const deliveries = useHopper((s) => s.deliveries);
  const [editing, setEditing] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const last = lastDelivery(deliveries, sub.id);
  const can = authed && !busy;
  return (
    <li className="space-y-2 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-sm font-semibold">{sub.name}</span>
        <StatusBadge status={sub.active ? 'active' : 'paused'} tone={sub.active ? 'ok' : 'warn'} />
        <Switch aria-label={`${sub.name} active`} checked={sub.active} disabled={!can}
          onCheckedChange={(active) => void send({ action: 'edit', name: sub.name, active }, `${sub.name}: ${active ? 'active' : 'paused'}`)} />
      </div>
      {editing ? (
        <SubscriptionForm adding={false} busy={busy} initial={{ name: sub.name, url: sub.url, events: sub.events, active: sub.active, secret: '' }} onCancel={() => setEditing(false)}
          onSubmit={async ({ url, events, active }) => {
            if (await send({ action: 'edit', name: sub.name, url, events, active }, `${sub.name}: saved`)) setEditing(false);
          }} />
      ) : (
        <>
          <div className="font-mono text-xs break-all text-foreground/80">{sub.url}</div>
          <SecretLine sub={sub} />
          {replacing && <ReplaceForm name={sub.name} busy={busy} send={send} onDone={() => setReplacing(false)} />}
          <div className="flex flex-wrap gap-1">{sub.events.map((e) => <span key={e} className="rounded border bg-muted/50 px-1.5 py-0.5 font-mono text-[11px]">{e}</span>)}</div>
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            {last ? (
              <>last delivery <StatusBadge status={last.status} /> <span className="font-mono">{last.eventType}</span> · {clock(last.updatedAt)}
                {last.lastStatusCode !== undefined && <> · {last.lastStatusCode}</>}{last.lastError && <span className="break-all"> · {last.lastError}</span>}</>
            ) : 'no deliveries yet'}
          </div>
          {authed && (
            <div className="flex flex-wrap gap-2 pt-1">
              <Button size="sm" variant="outline" disabled={!can} onClick={() => setEditing(true)}><Pencil />Edit</Button>
              <Button size="sm" variant="outline" disabled={!can || replacing} onClick={() => setReplacing(true)}><KeyRound />Replace secret</Button>
              <Confirm title={`Rotate the secret of ${sub.name}?`} action="Rotate" onConfirm={() => void send({ action: 'rotate', name: sub.name }, `${sub.name}: secret rotated; copy it to the receiver`)}
                description="The hopper makes a new signing secret, shows it once, and signs with it from the next delivery. The receiver refuses deliveries until it has the new one.">
                <Button size="sm" variant="outline" disabled={!can}><RefreshCw />Rotate secret</Button>
              </Confirm>
              <SendAction label="Send test event" icon={Send} path="/ui/api/webhooks/test" body={{ name: sub.name }} disabled={!can} />
              <Confirm title={`Remove ${sub.name}?`} action="Remove" onConfirm={() => void send({ action: 'remove', name: sub.name }, `${sub.name}: removed`)}
                description="The subscription and its signing secret are deleted, and its pending deliveries fail.">
                <Button size="sm" variant="destructive" disabled={!can}><Trash2 />Remove</Button>
              </Confirm>
            </div>
          )}
        </>
      )}
    </li>
  );
}

export function Webhooks() {
  const subs = useHopper((s) => s.subscriptions);
  const deliveries = useHopper((s) => s.deliveries);
  const authed = useCanAdmin();
  const [made, setMade] = useState<Made | null>(null);
  const { send, busy } = useSend(setMade);
  const [adding, setAdding] = useState(false);
  const byId = new Map(subs.map((s) => [s.id, s]));
  // Another session may have changed them since load: read them afresh.
  useEffect(() => { refreshWebhooks().catch(() => {}); }, []);
  return (
    <div className="space-y-3">
      <Panel title="Subscriptions" icon={Webhook} count={subs.length || ''} bodyClassName="space-y-3"
        action={authed && !adding && <Button size="sm" variant="outline" onClick={() => setAdding(true)}><Plus />Add subscription</Button>}>
        {made && <MadeSecret made={made} onDone={() => setMade(null)} />}
        {adding && (
          <div className="rounded-lg border border-dashed p-3">
            <SubscriptionForm adding busy={busy} initial={{ name: '', url: '', events: [], active: true, secret: '' }} onCancel={() => setAdding(false)}
              onSubmit={async ({ secret, ...v }) => {
                if (await send({ action: 'add', ...v, ...(secret ? { secret } : {}) }, `${v.name}: added`)) setAdding(false);
              }} />
          </div>
        )}
        {subs.length ? (
          <ul className="space-y-2">
            {subs.map((s) => <SubscriptionCard key={s.id} sub={s} authed={authed} send={send} busy={busy} />)}
          </ul>
        ) : !adding && <Empty>no subscriptions</Empty>}
      </Panel>
      <Panel title="Deliveries" icon={Webhook} count={deliveries.length || ''} bodyClassName="p-0">
        {deliveries.length ? (
          <Table>
            <TableHeader><TableRow><TableHead className="pl-4">Subscription</TableHead><TableHead>Event</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Attempts</TableHead><TableHead className="hidden md:table-cell">Last</TableHead></TableRow></TableHeader>
            <TableBody>
              {deliveries.map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="pl-4 font-mono text-xs" title={byId.get(d.subscriptionId)?.url}>{byId.get(d.subscriptionId)?.name ?? d.subscriptionId.slice(0, 8)}</TableCell>
                  <TableCell className="font-mono text-xs">{d.eventType}</TableCell>
                  <TableCell><StatusBadge status={d.status} /></TableCell>
                  <TableCell className="num text-right text-xs">{d.attempts}</TableCell>
                  <TableCell className="hidden max-w-80 truncate text-xs text-muted-foreground md:table-cell">{d.lastStatusCode ?? ''} {d.lastError ?? ''}{d.nextAttemptAt && ` · next ${clock(d.nextAttemptAt)}`}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : <Empty>no deliveries</Empty>}
      </Panel>
    </div>
  );
}
