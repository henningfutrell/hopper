// The SSE connection: replays after the newest event already loaded, then live. EventSource
// reconnects by itself (with Last-Event-ID); every (re)open refreshes what may have changed. Each connection opens with
// its hopper's tag (issue #1295): no event is taken before it, and another hopper's ends the stream.
import { readToken } from '@/lib/api';
import { checkInstance, knownHopper, otherHopper } from '@/lib/instance';
import { refreshAllReviews } from './reviews';
import { EVENT_TYPES } from '@/model/event-types';
import type { DomainEvent } from '@/model/wire';
import { announceCredentialAsked } from './vault';
import { ARTIFACTS_REREAD_MS, refreshArtifacts, refreshArtifactsSoon } from './artifacts';
import { refreshLineage, refreshLineageSoon } from './lineage';
import { onGiveBackEvent } from './give-back';
import { onPullRequestActEvent } from './pull-request-acts';
import { onDelivery, onDomainEvent, onRecorded, onSource, refreshFailures, refreshHealth, refreshLive, refreshLogins, refreshQuestions, refreshUpdate, setConn, useHopper } from './index';

export function connect(): () => void {
  const after = useHopper.getState().events[0]?.seq ?? 0;
  // EventSource sends no headers: across the LAN the session rides in the query.
  const token = readToken();
  const es = new EventSource(`/api/events/stream?after=${after}${token ? `&session=${token}` : ''}`);
  // The hopper this connection reaches: none yet at each (re)open, until its first event names it. A page that knows no
  // hopper yet has nothing to hold the stream to: it reads before it connects, so it knows its hopper by then.
  let ours = false;
  es.addEventListener('hopper.instance', (m) => {
    try { checkInstance(JSON.parse(m.data) as string); ours = true; } catch { es.close(); }
  });
  const on = (type: string, fn: (m: MessageEvent<string>) => void) => es.addEventListener(type, (m) => { if (ours || knownHopper() === undefined) fn(m); });
  es.onopen = () => {
    ours = false;
    if (otherHopper()) { es.close(); return; }
    setConn('live');
    refreshLive().catch(() => {});
    refreshQuestions().catch(() => {});
    refreshLogins().catch(() => {});
    refreshAllReviews();
    refreshFailures().catch(() => {});
    refreshUpdate().catch(() => {});
    void refreshArtifacts();
    void refreshLineage();
  };
  es.onerror = () => { ours = false; setConn('reconnecting'); };
  on('delivery.updated', (m) => onDelivery(JSON.parse(m.data)));
  on('source.updated', (m) => onSource(JSON.parse(m.data)));
  on('usage.recorded', () => onRecorded('usage'));
  on('machine.recorded', () => onRecorded('machine'));
  for (const t of EVENT_TYPES) on(t, (m) => { const e = JSON.parse(m.data) as DomainEvent; onDomainEvent(e); onGiveBackEvent(e); onPullRequestActEvent(e); });
  // A job asks the user for a credential (issue #583): said as it comes, never on a replay of what the page holds.
  on('vault.credential_asked', (m) => { const e = JSON.parse(m.data) as DomainEvent; if (e.seq > after) announceCredentialAsked(e); });
  // Artifacts (issue #624): made, shared, revoked or removed — read again; and before their content URLs run out.
  for (const t of EVENT_TYPES.filter((x) => x.startsWith('artifact.'))) on(t, () => refreshArtifactsSoon());
  // Issue lineage (issue #729): a job filed a child issue — read the links again.
  on('job.child_issue_filed', () => refreshLineageSoon());
  const artifacts = setInterval(() => { void refreshArtifacts(); }, ARTIFACTS_REREAD_MS);
  const health = setInterval(() => { refreshHealth().catch(() => {}); refreshUpdate().catch(() => {}); }, 10_000);
  return () => { clearInterval(health); clearInterval(artifacts); es.close(); };
}
