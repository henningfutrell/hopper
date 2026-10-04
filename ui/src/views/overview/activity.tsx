// Live activity (the newest events, as they arrive) and Attention (what wants a human).
import { BellRing, Radio } from 'lucide-react';
import { Countdown } from '@/components/job';
import { EventLine } from '@/components/event-line';
import { Empty, Panel } from '@/components/panel';
import { Dot, StatusBadge } from '@/components/status';
import { useNow } from '@/hooks/use-now';
import { ago } from '@/model/format';
import { useHopper } from '@/store';
import { useJobName } from '@/store/selectors';

export function LivePanel() {
  const events = useHopper((s) => s.events);
  const conn = useHopper((s) => s.conn);
  const nameOf = useJobName();
  return (
    <Panel title="Live activity" icon={Radio} action={<a href="#events" className="text-xs text-muted-foreground hover:text-foreground">all events →</a>}
      count={<Dot tone={conn === 'live' ? 'ok' : 'warn'} pulse={conn === 'live'} />} bodyClassName="space-y-1.5">
      {events.length ? events.slice(0, 14).map((e) => <EventLine key={e.seq} e={e} nameOf={nameOf} className="animate-in fade-in slide-in-from-top-1 duration-300" />) : <Empty>no events yet</Empty>}
    </Panel>
  );
}

interface Alert { key: string; tone: 'question' | 'bad' | 'warn'; label: string; text: string; href?: string; at?: string; expires?: string }

export function AttentionPanel() {
  const questions = useHopper((s) => s.questions);
  const ended = useHopper((s) => s.queue.ended);
  const sources = useHopper((s) => s.sources);
  const health = useHopper((s) => s.health);
  const nameOf = useJobName();
  const now = useNow();
  const alerts: Alert[] = [
    ...questions.map((q): Alert => ({ key: q.id, tone: 'question', label: q.tier === 'human' ? 'for you' : q.tier, text: `${nameOf(q.jobId)} — ${q.text}`, href: '#questions', at: q.createdAt, ...(q.tier === 'human' && q.expiresAt ? { expires: q.expiresAt } : {}) })),
    ...(health?.fallback ? [{ key: 'router', tone: 'warn' as const, label: 'router', text: `${health.router} is not answering: pass-through advice` }] : []),
    ...sources.filter((s) => s.state === 'error').map((s): Alert => ({ key: `src-${s.name}`, tone: 'bad', label: 'source', text: `${s.name}: ${s.lastError ?? 'error'}`, href: '#sources', ...(s.lastSyncAt ? { at: s.lastSyncAt } : {}) })),
    ...ended.filter((j) => j.status === 'failed').slice(0, 5).map((j): Alert => ({ key: j.id, tone: 'bad', label: 'failed', text: `${nameOf(j.id)} — ${j.error ?? ''}`, ...(j.finishedAt ? { at: j.finishedAt } : {}) })),
  ];
  return (
    <Panel title="Attention" icon={BellRing} count={alerts.length || ''} bodyClassName="divide-y p-0">
      {alerts.length ? alerts.map((a) => {
        const body = (
          <div className="flex items-start gap-2.5 px-4 py-2.5">
            <StatusBadge status={a.label} tone={a.tone} className="mt-px" />
            <span className="line-clamp-2 min-w-0 flex-1 text-xs">{a.text}</span>
            <span className="num shrink-0 text-[11px] text-muted-foreground">{a.expires ? <Countdown iso={a.expires} /> : a.at ? ago(a.at, now) : ''}</span>
          </div>
        );
        return a.href ? <a key={a.key} href={a.href} className="block hover:bg-muted/40">{body}</a> : <div key={a.key}>{body}</div>;
      }) : <Empty>all quiet</Empty>}
    </Panel>
  );
}
