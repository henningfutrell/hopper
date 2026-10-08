// Webhook subscriptions and their deliveries, live. The subscriptions are kept in the database
// (issue #78); a UI session edits them through POST /ui/api/webhooks (issue #18): add, edit (url,
// events, active), remove. The hopper keeps no secret (issue #56): a subscription names the WEBHOOK_SECRET_* variable
// the runtime gives its secret in, and the card says whether the runtime gives it. Send test event
// (issue #378) posts one signed `webhook.test` and shows the receiver's answer.
import { KeyRound, Pencil, Plus, Send, Trash2, Webhook } from 'lucide-react';
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
import { EVENT_CHOICES, lastDelivery, secretEnvFor, toggleEvent } from '@/model/webhooks';
import type { WebhooksEdit, WebhookView, WebhooksView } from '@/model/wire';
import { refreshWebhooks, setWebhooks, useHopper } from '@/store';
import { useCanAdmin } from '@/store/selectors';

type Send = (edit: WebhooksEdit, done: string) => Promise<WebhooksView | null>;

function useSend(): { send: Send; busy: boolean } {
  const [busy, setBusy] = useState(false);
  const send: Send = async (edit, done) => {
    setBusy(true);
    try {
      const view = await post<WebhooksView>('/ui/api/webhooks', edit);
      setWebhooks(view);
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

interface FormValues { name: string; url: string; events: string[]; active: boolean; secretEnv: string }

/** The add form and the edit form: url, events, active. `name` and the secret's variable only when adding. */
function SubscriptionForm({ initial, adding, busy, onSubmit, onCancel }: {
  initial: FormValues;
  adding: boolean; busy: boolean;
  onSubmit: (v: FormValues) => void;
  onCancel: () => void;
}) {
  const [v, setV] = useState(initial);
  // The variable follows the name until it is edited.
  const [ownEnv, setOwnEnv] = useState(false);
  const secretEnv = ownEnv ? v.secretEnv : secretEnvFor(v.name);
  const submit = (e: React.FormEvent) => { e.preventDefault(); onSubmit({ ...v, name: v.name.trim(), url: v.url.trim(), secretEnv: secretEnv.trim() }); };
  return (
    <form onSubmit={submit} className="space-y-3">
      {adding && (
        <label className="block space-y-1"><Label>Name — the subscription's key; fixed once added</Label>
          <Input className="h-9 font-mono text-sm" value={v.name} required autoCapitalize="off" autoCorrect="off" spellCheck={false}
            onChange={(e) => setV({ ...v, name: e.target.value })} /></label>
      )}
      {adding && (
        <label className="block space-y-1"><Label>Secret variable — set it in the hopper's runtime (or a mounted file named by {secretEnv}_FILE); hopper keeps no secret</Label>
          <Input className="h-9 font-mono text-sm" value={secretEnv} required pattern="WEBHOOK_SECRET_[A-Z0-9_]+" autoCapitalize="characters" autoCorrect="off" spellCheck={false}
            onChange={(e) => { setOwnEnv(true); setV({ ...v, secretEnv: e.target.value }); }} /></label>
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

function SubscriptionCard({ sub, authed, send, busy }: {
  sub: WebhookView; authed: boolean; send: Send; busy: boolean;
}) {
  const deliveries = useHopper((s) => s.deliveries);
  const [editing, setEditing] = useState(false);
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
        <SubscriptionForm adding={false} busy={busy} initial={{ name: sub.name, url: sub.url, events: sub.events, active: sub.active, secretEnv: sub.secretEnv }} onCancel={() => setEditing(false)}
          onSubmit={async ({ url, events, active }) => {
            if (await send({ action: 'edit', name: sub.name, url, events, active }, `${sub.name}: saved`)) setEditing(false);
          }} />
      ) : (
        <>
          <div className="font-mono text-xs break-all text-foreground/80">{sub.url}</div>
          <div className={`flex flex-wrap items-center gap-1.5 text-xs ${sub.secretProblem ? 'text-bad' : 'text-muted-foreground'}`}>
            <KeyRound className="size-3.5" />secret from <code className="font-mono">{sub.secretEnv}</code>
            {sub.secretProblem && <span className="break-words">· {sub.secretProblem}: deliveries wait until the runtime gives it</span>}
          </div>
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
              <SendAction label="Send test event" icon={Send} path="/ui/api/webhooks/test" body={{ name: sub.name }} disabled={!can} />
              <Confirm title={`Remove ${sub.name}?`} action="Remove" onConfirm={() => void send({ action: 'remove', name: sub.name }, `${sub.name}: removed`)}
                description="The subscription is deleted and its pending deliveries fail.">
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
  const { send, busy } = useSend();
  const [adding, setAdding] = useState(false);
  const byId = new Map(subs.map((s) => [s.id, s]));
  // Another session may have changed them since load: read them afresh.
  useEffect(() => { refreshWebhooks().catch(() => {}); }, []);
  return (
    <div className="space-y-3">
      <Panel title="Subscriptions" icon={Webhook} count={subs.length || ''} bodyClassName="space-y-3"
        action={authed && !adding && <Button size="sm" variant="outline" onClick={() => setAdding(true)}><Plus />Add subscription</Button>}>
        {adding && (
          <div className="rounded-lg border border-dashed p-3">
            <SubscriptionForm adding busy={busy} initial={{ name: '', url: '', events: [], active: true, secretEnv: '' }} onCancel={() => setAdding(false)}
              onSubmit={async (v) => {
                if (await send({ action: 'add', ...v }, `${v.name}: added; set ${v.secretEnv} in the runtime`)) setAdding(false);
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
