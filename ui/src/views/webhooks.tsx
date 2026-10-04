// Webhook subscriptions and their deliveries, live. webhooks.yaml is the source of truth; a UI
// session edits it through POST /ui/api/webhooks (issue #18): add, edit (url, events, active),
// rotate secret, remove. A new secret is shown once, in a dialog, and never again.
import { Copy, KeyRound, Pencil, Plus, Trash2, Webhook } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AlertDialog, AlertDialogAction, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Confirm } from '@/components/confirm';
import { Empty, Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status';
import { post, SessionRejected } from '@/lib/api';
import { clock } from '@/model/format';
import { EVENT_CHOICES, lastDelivery, toggleEvent } from '@/model/webhooks';
import type { WebhookSubscription, WebhooksEdit, WebhooksView } from '@/model/wire';
import { refreshWebhooks, setWebhooks, useHopper } from '@/store';

/** A new secret to show once: whose, and why. */
interface Shown { name: string; secret: string; why: 'added' | 'rotated' }

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
      // A stale version or a file edited by hand: show what the file says now.
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

/** The add form and the edit form: url, events, active. `name` only when adding. */
function SubscriptionForm({ initial, adding, busy, onSubmit, onCancel }: {
  initial: { name: string; url: string; events: string[]; active: boolean };
  adding: boolean; busy: boolean;
  onSubmit: (v: { name: string; url: string; events: string[]; active: boolean }) => void;
  onCancel: () => void;
}) {
  const [v, setV] = useState(initial);
  const submit = (e: React.FormEvent) => { e.preventDefault(); onSubmit({ ...v, name: v.name.trim(), url: v.url.trim() }); };
  return (
    <form onSubmit={submit} className="space-y-3">
      {adding && (
        <label className="block space-y-1"><Label>Name — the key in webhooks.yaml; fixed once added</Label>
          <Input className="h-9 font-mono text-sm" value={v.name} required autoCapitalize="off" autoCorrect="off" spellCheck={false}
            onChange={(e) => setV({ ...v, name: e.target.value })} /></label>
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

function SubscriptionCard({ sub, authed, version, send, busy, onSecret }: {
  sub: WebhookSubscription; authed: boolean; version: string; send: Send; busy: boolean; onSecret: (s: Shown) => void;
}) {
  const deliveries = useHopper((s) => s.deliveries);
  const [editing, setEditing] = useState(false);
  const last = lastDelivery(deliveries, sub.id);
  const can = authed && !busy;
  const rotate = async () => {
    const r = await send({ action: 'rotate-secret', name: sub.name, version }, `${sub.name}: secret rotated`);
    if (r?.secret) onSecret({ name: sub.name, secret: r.secret, why: 'rotated' });
  };
  return (
    <li className="space-y-2 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-sm font-semibold">{sub.name}</span>
        <StatusBadge status={sub.active ? 'active' : 'paused'} tone={sub.active ? 'ok' : 'warn'} />
        <Switch aria-label={`${sub.name} active`} checked={sub.active} disabled={!can}
          onCheckedChange={(active) => void send({ action: 'edit', name: sub.name, active, version }, `${sub.name}: ${active ? 'active' : 'paused'}`)} />
      </div>
      {editing ? (
        <SubscriptionForm adding={false} busy={busy} initial={{ name: sub.name, url: sub.url, events: sub.events, active: sub.active }} onCancel={() => setEditing(false)}
          onSubmit={async ({ url, events, active }) => {
            if (await send({ action: 'edit', name: sub.name, url, events, active, version }, `${sub.name}: saved`)) setEditing(false);
          }} />
      ) : (
        <>
          <div className="font-mono text-xs break-all text-foreground/80">{sub.url}</div>
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
              <Confirm title={`Rotate the secret of ${sub.name}?`} action="Rotate secret" onConfirm={() => void rotate()}
                description="A new secret replaces the current one in webhooks.yaml at once. Deliveries signed with the old one stop verifying until the subscriber has the new one.">
                <Button size="sm" variant="outline" disabled={!can}><KeyRound />Rotate secret</Button>
              </Confirm>
              <Confirm title={`Remove ${sub.name}?`} action="Remove" onConfirm={() => void send({ action: 'remove', name: sub.name, version }, `${sub.name}: removed`)}
                description="Its entry leaves webhooks.yaml and its pending deliveries fail.">
                <Button size="sm" variant="destructive" disabled={!can}><Trash2 />Remove</Button>
              </Confirm>
            </div>
          )}
        </>
      )}
    </li>
  );
}

/** The new secret, once. Plain HTTP on a LAN name has no clipboard API: then the text is selected for the device's own copy. */
function SecretDialog({ shown, onClose }: { shown: Shown | null; onClose: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const select = () => { ref.current?.focus(); ref.current?.select(); };
  const copy = async () => {
    if (!shown) return;
    try {
      if (!navigator.clipboard) throw new Error('no clipboard');
      await navigator.clipboard.writeText(shown.secret);
      toast.success('Copied');
    } catch {
      select();
      toast.info('Selected: copy it with your device\'s copy');
    }
  };
  return (
    <AlertDialog open={shown !== null} onOpenChange={(o) => { if (!o) onClose(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{shown?.name}: {shown?.why === 'added' ? 'subscription added' : 'secret rotated'}</AlertDialogTitle>
          <AlertDialogDescription>This secret is shown once. Give it to the subscriber now; job-hopper keeps it in webhooks.yaml and never shows it again.</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex items-center gap-2">
          <Input ref={ref} readOnly value={shown?.secret ?? ''} aria-label="Secret" className="h-9 min-w-0 flex-1 font-mono text-xs" onFocus={(e) => e.target.select()} />
          <Button variant="outline" size="icon" aria-label="Copy secret" onClick={() => void copy()}><Copy /></Button>
        </div>
        <div className="space-y-1 text-xs text-muted-foreground">
          <p>The subscriber verifies each delivery: the header</p>
          <code className="block rounded bg-muted px-2 py-1 font-mono break-all text-foreground/80">x-jobhopper-signature: sha256=&lt;hex HMAC-SHA256(secret, "&lt;x-jobhopper-timestamp&gt;.&lt;raw body&gt;")&gt;</code>
          <p>must match, compared in constant time; dedupe on <code className="font-mono">x-jobhopper-delivery</code> (docs/design.md "Webhooks").</p>
        </div>
        <AlertDialogFooter><AlertDialogAction onClick={onClose}>I have stored it</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function Webhooks() {
  const subs = useHopper((s) => s.subscriptions);
  const deliveries = useHopper((s) => s.deliveries);
  const cfg = useHopper((s) => s.webhookConfig);
  const authed = useHopper((s) => s.authed);
  const { send, busy } = useSend();
  const [adding, setAdding] = useState(false);
  const [shown, setShown] = useState<Shown | null>(null);
  const version = cfg?.version ?? 'missing';
  const byId = new Map(subs.map((s) => [s.id, s]));
  // The file may have been edited by hand since load: read its version and entries afresh.
  useEffect(() => { refreshWebhooks().catch(() => {}); }, []);
  return (
    <div className="space-y-3">
      <Panel title="Subscriptions" icon={Webhook} count={subs.length || ''} bodyClassName="space-y-3"
        action={authed && !adding && <Button size="sm" variant="outline" onClick={() => setAdding(true)}><Plus />Add subscription</Button>}>
        {cfg && <div className="text-xs break-all text-muted-foreground">config <code className="font-mono text-foreground/80">{cfg.path ?? '?'}</code>{cfg.loadedAt && <> · loaded {clock(cfg.loadedAt)}</>}</div>}
        {cfg?.error && <div className="text-xs break-words text-bad">error: {cfg.error}</div>}
        {(cfg?.warnings ?? []).map((w) => <div key={w} className="text-xs break-words text-warn">warning: {w}</div>)}
        {adding && (
          <div className="rounded-lg border border-dashed p-3">
            <SubscriptionForm adding busy={busy} initial={{ name: '', url: '', events: [], active: true }} onCancel={() => setAdding(false)}
              onSubmit={async (v) => {
                const r = await send({ action: 'add', ...v, version }, `${v.name}: added`);
                if (r) { setAdding(false); if (r.secret) setShown({ name: v.name, secret: r.secret, why: 'added' }); }
              }} />
          </div>
        )}
        {subs.length ? (
          <ul className="space-y-2">
            {subs.map((s) => <SubscriptionCard key={s.id} sub={s} authed={authed} version={version} send={send} busy={busy} onSecret={setShown} />)}
          </ul>
        ) : !adding && <Empty>no subscriptions in webhooks.yaml</Empty>}
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
      <SecretDialog shown={shown} onClose={() => setShown(null)} />
    </div>
  );
}
