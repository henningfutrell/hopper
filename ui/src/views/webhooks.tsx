// Webhook subscriptions (from webhooks.yaml) and their deliveries, live.
import { Webhook } from 'lucide-react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Empty, Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status';
import { clock } from '@/model/format';
import { useHopper } from '@/store';

export function Webhooks() {
  const subs = useHopper((s) => s.subscriptions);
  const deliveries = useHopper((s) => s.deliveries);
  const cfg = useHopper((s) => s.webhookConfig);
  const byId = new Map(subs.map((s) => [s.id, s]));
  return (
    <div className="space-y-3">
      <Panel title="Subscriptions" icon={Webhook} count={subs.length || ''} bodyClassName="space-y-2">
        {cfg && <div className="text-xs text-muted-foreground">config <code className="font-mono text-foreground/80">{cfg.path ?? '?'}</code>{cfg.loadedAt && <> · loaded {clock(cfg.loadedAt)}</>}</div>}
        {cfg?.error && <div className="text-xs text-bad">error: {cfg.error}</div>}
        {(cfg?.warnings ?? []).map((w) => <div key={w} className="text-xs text-warn">warning: {w}</div>)}
        <div className="flex flex-wrap gap-1.5">{subs.map((s) => <StatusBadge key={s.id} status={s.name} tone={s.active ? 'ok' : 'warn'} />)}</div>
        {!subs.length && <Empty>no subscriptions in webhooks.yaml</Empty>}
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
