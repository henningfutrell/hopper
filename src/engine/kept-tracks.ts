// The kept-track pass (issue #2775, design.md "Kept delivery tracks"): every KEPT_TRACKS_EVERY_MS, on the host that holds
// its lease, the events after the pass's cursor are folded into each job's kept track, and every open track is judged
// again — its job's status and the scheduled steps move with no event. The tracks it changed, their deployment records and
// the new cursor are kept in one transaction, so a pass a stop cut short is done again from the same cursor, on any host.
import { DEFAULT_DELIVERY_SETTINGS, deliveryOf } from '../domain/delivery-settings.ts';
import { foldTrackEvents, KEPT_TRACK_EVENTS, measuredOf, trackOf, type KeptTrack, type TrackMarks } from '../domain/kept-tracks.ts';
import type { UserStore } from '../domain/store.ts';
import type { DomainEvent } from '../domain/types.ts';
import { clearancesOf, clearedOf, HISTORY_DAYS } from './delivery-reads.ts';

export const KEPT_TRACKS_EVERY_MS = 60_000;
/** Events read per query after the cursor. */
const PAGE = 2000;
const DAY = 86_400_000;

/** The events after the cursor, of the track's types, and the new cursor. The first pass reads the last HISTORY_DAYS days only. */
function eventsOf(store: UserStore, now: Date): { events: DomainEvent[]; cursor: number } {
  const cursor = store.keptTracks.cursor();
  if (cursor === undefined) {
    const newest = store.events.recent(1)[0]?.seq ?? 0;
    const since = new Date(now.getTime() - HISTORY_DAYS * DAY).toISOString();
    return { events: store.events.between(KEPT_TRACK_EVENTS, since).filter((e) => e.seq <= newest), cursor: newest };
  }
  const types = new Set<string>(KEPT_TRACK_EVENTS);
  const events: DomainEvent[] = [];
  let last = cursor;
  for (let page = store.events.since(last, PAGE); page.length > 0; page = page.length < PAGE ? [] : store.events.since(last, PAGE)) {
    last = page.at(-1)!.seq;
    events.push(...page.filter((e) => types.has(e.type)));
  }
  return { events, cursor: last };
}

/** One pass at `now`: answers how many tracks it wrote. */
export function keepDeliveryTracks(store: UserStore, now: Date): number {
  const at = now.toISOString();
  const { events, cursor } = eventsOf(store, now);
  const open = new Map(store.keptTracks.open().map((t) => [t.jobId, t]));
  const marks = new Map<string, TrackMarks>([...open].map(([id, t]) => [id, structuredClone(t.marks)]));
  const queued = [...new Set(events.flatMap((e) => (e.type === 'job.queued' && e.jobId && !marks.has(e.jobId) ? [e.jobId] : [])))];
  foldTrackEvents(marks, events, store.keptTracks.closedOf(queued));
  const settings = store.settings.getDeliverySettings() ?? DEFAULT_DELIVERY_SETTINGS;
  const clearances = clearancesOf({ store });
  const jobs = store.jobs.getMany([...marks.keys()]);
  const changed: KeptTrack[] = [];
  for (const [jobId, m] of marks) {
    const d = deliveryOf(settings, m.repo);
    const job = jobs.get(jobId);
    const t = trackOf(jobId, m, { now: at, ...(job ? { job } : {}), delivery: d, cleared: clearedOf(clearances, d, m.repo, measuredOf(m).current) }, open.get(jobId));
    if (JSON.stringify(t) !== JSON.stringify(open.get(jobId))) changed.push(t);
  }
  if (changed.length > 0 || cursor !== store.keptTracks.cursor()) store.keptTracks.save(changed, cursor);
  return changed.length;
}
