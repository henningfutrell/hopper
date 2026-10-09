// The SSE connection: replays after the newest event already loaded, then live. EventSource
// reconnects by itself (with Last-Event-ID); every (re)open refreshes what may have changed.
import { readToken } from '@/lib/api';
import { refreshAllReviews } from './reviews';
import { EVENT_TYPES } from '@/model/event-types';
import type { DomainEvent } from '@/model/wire';
import { onDelivery, onDomainEvent, onSource, onUsageRecorded, refreshFailures, refreshHealth, refreshLive, refreshLogins, refreshQuestions, refreshUpdate, setConn, useHopper } from './index';

export function connect(): () => void {
  const after = useHopper.getState().events[0]?.seq ?? 0;
  // EventSource sends no headers: across the LAN the session rides in the query.
  const token = readToken();
  const es = new EventSource(`/api/events/stream?after=${after}${token ? `&session=${token}` : ''}`);
  es.onopen = () => {
    setConn('live');
    refreshLive().catch(() => {});
    refreshQuestions().catch(() => {});
    refreshLogins().catch(() => {});
    refreshAllReviews();
    refreshFailures().catch(() => {});
    refreshUpdate().catch(() => {});
  };
  es.onerror = () => setConn('reconnecting');
  es.addEventListener('delivery.updated', (m) => onDelivery(JSON.parse(m.data)));
  es.addEventListener('source.updated', (m) => onSource(JSON.parse(m.data)));
  es.addEventListener('usage.recorded', () => onUsageRecorded());
  for (const t of EVENT_TYPES) es.addEventListener(t, (m) => onDomainEvent(JSON.parse(m.data) as DomainEvent));
  const health = setInterval(() => { refreshHealth().catch(() => {}); refreshUpdate().catch(() => {}); }, 10_000);
  return () => { clearInterval(health); es.close(); };
}
