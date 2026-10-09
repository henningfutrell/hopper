// Which open questions wait on the owner: the nav badge counts them, seen or not (issue #499); the Questions view
// marks the unseen ones seen. A parked job's question is not among them: it is in Parked, with its job (issue #565).
// And how the raising machine is named (issue #485).
import type { DomainEvent, Job, Question, RaisedBy } from './wire.ts';

/** Its job is parked on it (issue #501): it waits in Parked with the job, out of Questions, until the job is picked up. */
export const parkedOn = (q: Pick<Question, 'id' | 'jobId'>, jobs: ReadonlyMap<string, Job>): boolean => {
  const job = jobs.get(q.jobId);
  return job?.status === 'parked' && job.questionId === q.id;
};

/** The questions Questions shows, counts and the Attention panel lists: every one but a parked job's (issue #565). */
export const notParked = <T extends Pick<Question, 'id' | 'jobId'>>(qs: readonly T[], jobs: ReadonlyMap<string, Job>): T[] => qs.filter((q) => !parkedOn(q, jobs));

/** A question's first line, for a compact row: the full text is one click away. */
export const firstLine = (text: string): string => text.trim().split('\n')[0]!.trim();

/** Open and at the human stage: it waits on the owner until it is answered, closed, dismissed or expired. */
export const awaitsOwner = (q: Question): boolean => q.status === 'open' && q.tier === 'human';

/** Waits on the owner and not yet shown to them: what the Questions view marks seen. */
export const unseenByOwner = (q: Question): boolean => awaitsOwner(q) && !q.seenAt;

/** The open questions' one order, the API's too: oldest first, the longest waiting on top, so an arrival lands at the
 *  bottom (issue #450). A gained attempt or a tier change never moves a question. Stable: ties keep the API's order. */
export const longestWaitingFirst = <T extends Question>(qs: T[]): T[] => [...qs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

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
