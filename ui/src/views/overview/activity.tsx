// Live activity (the newest events, as they arrive) and Attention (what wants a human). Each
// Attention item can be dismissed in this browser (issue #83); the thing it points at is unchanged.
import { BellRing, Radio, X } from 'lucide-react';
import { Countdown } from '@/components/job';
import { EventLine } from '@/components/event-line';
import { Empty, Panel } from '@/components/panel';
import { Dot, StatusBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { dismissNotice, showDismissed, useDismissed } from '@/hooks/use-dismissed';
import { useNow } from '@/hooks/use-now';
import { noticeKey } from '@/model/dismissed';
import { diskText } from '@/model/machines';
import { raisedName } from '@/model/questions';
import { ago } from '@/model/format';
import { useHopper } from '@/store';
import { useJobBoard, useJobName } from '@/store/selectors';

export function LivePanel({ count }: { count: number }) {
  const events = useHopper((s) => s.events);
  const conn = useHopper((s) => s.conn);
  const machines = useHopper((s) => s.machines);
  const nameOf = useJobName();
  return (
    <Panel title="Live activity" icon={Radio} action={<a href="#events" className="text-xs text-muted-foreground hover:text-foreground">all events →</a>}
      count={<Dot tone={conn === 'live' ? 'ok' : 'warn'} pulse={conn === 'live'} />} list bodyClassName="space-y-1.5">
      {events.length ? events.slice(0, count).map((e) => <EventLine key={e.seq} e={e} nameOf={nameOf} machines={machines} className="animate-in fade-in slide-in-from-top-1 duration-300" />) : <Empty>no events yet</Empty>}
    </Panel>
  );
}

interface Alert { key: string; tone: 'question' | 'bad' | 'warn'; label: string; text: string; href?: string; at?: string; expires?: string }

export function AttentionPanel() {
  const questions = useHopper((s) => s.questions);
  const { ended } = useJobBoard();
  const sources = useHopper((s) => s.sources);
  const health = useHopper((s) => s.health);
  const machines = useHopper((s) => s.machines);
  const dismissed = useDismissed();
  const nameOf = useJobName();
  const now = useNow();
  const all: Alert[] = [
    ...questions.map((q): Alert => ({ key: noticeKey.question(q.id), tone: 'question', label: q.tier === 'human' ? 'for you' : q.tier, text: `${nameOf(q.jobId)} on ${raisedName(q.raisedBy)} — ${q.text}`, href: '#questions', at: q.createdAt, ...(q.tier === 'human' && q.expiresAt ? { expires: q.expiresAt } : {}) })),
    ...(health?.fallback ? [{ key: noticeKey.router(health), tone: 'warn' as const, label: 'router', text: `${health.router} is not answering: pass-through advice` }] : []),
    ...sources.filter((s) => s.state === 'error').map((s): Alert => ({ key: noticeKey.source(s), tone: 'bad', label: 'source', text: `${s.name}: ${s.lastError ?? 'error'}`, href: '#sources', ...(s.lastSyncAt ? { at: s.lastSyncAt } : {}) })),
    ...machines.filter((m) => m.disk?.low).map((m): Alert => ({ key: noticeKey.disk(m.id), tone: 'warn', label: 'disk', text: `${m.label || m.id}: ${diskText(m.disk)}`, href: '#machines' })),
    ...ended.filter((j) => j.cleanupDeferred).map((j): Alert => ({ key: noticeKey.paneOpen(j.id), tone: 'warn', label: 'pane open', text: `${nameOf(j.id)} — its pane may still be open: the hopper could not reach its machine (${j.cleanupDeferred!.error})`, at: j.cleanupDeferred!.at })),
    ...ended.filter((j) => j.status === 'failed').slice(0, 5).map((j): Alert => ({ key: noticeKey.failed(j.id), tone: 'bad', label: 'failed', text: `${nameOf(j.id)} — ${j.error ?? ''}`, ...(j.finishedAt ? { at: j.finishedAt } : {}) })),
  ];
  const alerts = all.filter((a) => !dismissed.includes(a.key));
  const hidden = all.filter((a) => dismissed.includes(a.key)).map((a) => a.key);
  return (
    <Panel title="Attention" icon={BellRing} count={alerts.length || ''} list bodyClassName="divide-y p-0"
      action={hidden.length > 0 && (
        <Button variant="ghost" size="xs" className="text-muted-foreground" aria-label="Show dismissed" onClick={() => showDismissed(hidden)}>
          {hidden.length} dismissed · show
        </Button>
      )}>
      {alerts.length ? alerts.map((a) => {
        const body = (
          <div className="flex min-w-0 flex-1 items-start gap-2.5 py-2.5 pl-4">
            <StatusBadge status={a.label} tone={a.tone} className="mt-px" />
            <span className="line-clamp-2 min-w-0 flex-1 text-xs">{a.text}</span>
            <span className="num shrink-0 text-[11px] text-muted-foreground">{a.expires ? <Countdown iso={a.expires} /> : a.at ? ago(a.at, now) : ''}</span>
          </div>
        );
        return (
          <div key={a.key} data-notice={a.key} className="group flex items-start">
            {a.href ? <a href={a.href} className="flex min-w-0 flex-1 hover:bg-muted/40">{body}</a> : body}
            <Button variant="ghost" size="icon-xs" aria-label="Dismiss" title="Dismiss: hide here, in this browser; nothing else changes"
              className="mt-2 mr-2 ml-1 text-muted-foreground" onClick={() => dismissNotice(a.key)}><X /></Button>
          </div>
        );
      }) : <Empty>{hidden.length ? 'nothing new' : 'all quiet'}</Empty>}
    </Panel>
  );
}
