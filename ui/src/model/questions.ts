// Which open questions wait on the owner: the nav badge counts them, seen or not (issue #499); the Questions view
// marks the unseen ones seen. And how the raising machine is named (issue #485).
import type { DomainEvent, Question, RaisedBy } from './wire.ts';

/** Open and at the human stage: it waits on the owner until it is answered, closed, dismissed or expired. */
export const awaitsOwner = (q: Question): boolean => q.status === 'open' && q.tier === 'human';

/** Waits on the owner and not yet shown to them: what the Questions view marks seen. */
export const unseenByOwner = (q: Question): boolean => awaitsOwner(q) && !q.seenAt;

/** The open questions' one order, the API's too: oldest first, the longest waiting on top, so an arrival lands at the
 *  bottom (issue #450). A gained attempt or a tier change never moves a question. Stable: ties keep the API's order. */
export const longestWaitingFirst = (qs: Question[]): Question[] => [...qs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

/** The raising machine as people read it: its name when it was asked, else its id; never blank (issue #485). */
export const raisedName = (r: RaisedBy | undefined): string => (r ? r.name ?? r.machineId : 'machine unknown');

/** What hovering the raising machine says: its id and lane, or that it was not recorded. */
export const raisedTitle = (r: RaisedBy | undefined): string =>
  (r ? [`machine ${r.machineId}`, ...(r.laneId ? [`lane ${r.laneId}`] : [])].join(' · ') : 'the machine that raised this question was not recorded');

/** A question event's raising machine: its data's snapshot, else its machine subject. Undefined: not a question event, or none known. */
export function raisedByOf(e: DomainEvent): RaisedBy | undefined {
  const d = (e.data as { raisedBy?: RaisedBy }).raisedBy;
  if (d) return d;
  return e.machineId ? { machineId: e.machineId, ...(e.laneId ? { laneId: e.laneId } : {}) } : undefined;
}
