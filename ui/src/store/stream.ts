// The SSE connection: replays after the newest event already loaded, then live. EventSource
// reconnects by itself (with Last-Event-ID); every (re)open refreshes what may have changed.
import { readToken } from '@/lib/api';
import { refreshAllReviews } from './reviews';
import { EVENT_TYPES } from '@/model/event-types';
import type { DomainEvent } from '@/model/wire';
import { announceCredentialAsked } from './vault';
import { ARTIFACTS_REREAD_MS, refreshArtifacts, refreshArtifactsSoon } from './artifacts';
import { onDelivery, onDomainEvent, onRecorded, onSource, refreshFailures, refreshHealth, refreshLive, refreshLogins, refreshQuestions, refreshUpdate, setConn, useHopper } from './index';

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
    void refreshArtifacts();
  };
  es.onerror = () => setConn('reconnecting');
  es.addEventListener('delivery.updated', (m) => onDelivery(JSON.parse(m.data)));
  es.addEventListener('source.updated', (m) => onSource(JSON.parse(m.data)));
  es.addEventListener('usage.recorded', () => onRecorded('usage'));
  es.addEventListener('machine.recorded', () => onRecorded('machine'));
  for (const t of EVENT_TYPES) es.addEventListener(t, (m) => onDomainEvent(JSON.parse(m.data) as DomainEvent));
  // A job asks the user for a credential (issue #583): said as it comes, never on a replay of what the page holds.
  es.addEventListener('vault.credential_asked', (m) => { const e = JSON.parse(m.data) as DomainEvent; if (e.seq > after) announceCredentialAsked(e); });
  // Artifacts (issue #624): made, shared, revoked or removed — read again; and before their content URLs run out.
  for (const t of EVENT_TYPES.filter((x) => x.startsWith('artifact.'))) es.addEventListener(t, () => refreshArtifactsSoon());
  const artifacts = setInterval(() => { void refreshArtifacts(); }, ARTIFACTS_REREAD_MS);
  const health = setInterval(() => { refreshHealth().catch(() => {}); refreshUpdate().catch(() => {}); }, 10_000);
  return () => { clearInterval(health); clearInterval(artifacts); es.close(); };
}
