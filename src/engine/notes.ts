// Notes to a job (issue #997, design.md "Notes to a running job"): a person sends one through the UI session or an API
// token (`job.note_added`); the job's executor takes the queued ones where its session can read them
// (`job.note_delivered`); a new job of its item carries the ones never delivered (`job.note_carried`). The notes live on
// the job, in the store: they outlive a restart.
import type { ExecutionContext } from '../domain/ports.ts';
import { noteRefusal, notesText, queuedNotes, type ActingPerson, type Job, type JobNote, type NoteDelivery } from '../domain/types.ts';
import { nowIso, type EngineContext } from './context.ts';
import { EngineError } from './errors.ts';

/** In the tx: the note, queued on the job. Not found, or a conflict when the job takes no note now. */
export function recordNote(c: EngineContext, id: string, text: string, acting: ActingPerson): JobNote {
  const { store } = c;
  const job = store.jobs.get(id);
  if (!job) throw new EngineError('not_found', `job ${id} not found`);
  const newest = !job.source || store.jobs.getBySourceKey(job.source.key)?.id === job.id;
  const refused = noteRefusal(job.status, newest);
  if (refused) throw new EngineError('conflict', `job ${id} takes no note: ${refused}`);
  const note: JobNote = { id: c.idGen(), text, by: acting.person, via: acting.via, at: nowIso(c), state: 'queued' };
  store.jobs.update(id, { notes: [...(job.notes ?? []), note] });
  store.events.append({ type: 'job.note_added', jobId: id, data: { noteId: note.id, text, person: acting.person, via: acting.via } });
  return note;
}

/** In a tx: the queued notes of the job delivered `how`, and the text that tells its session; undefined with none. */
export function deliverNotes(c: EngineContext, id: string, how: NoteDelivery): string | undefined {
  const { store } = c;
  const job = store.jobs.get(id);
  const queued = queuedNotes(job?.notes);
  if (!job || queued.length === 0) return undefined;
  const at = nowIso(c);
  const ids = new Set(queued.map((n) => n.id));
  store.jobs.update(id, { notes: job.notes!.map((n) => (ids.has(n.id) ? { ...n, state: 'delivered' as const, delivery: how, deliveredAt: at } : n)) });
  store.events.append({ type: 'job.note_delivered', jobId: id, data: { noteIds: [...ids], delivery: how } });
  return notesText(queued);
}

/** The run's way to the job's notes (ExecutionContext.notes): read from the store each time, so a note sent mid-run is seen. */
export function runNotes(c: EngineContext, id: string): NonNullable<ExecutionContext['notes']> {
  return {
    waiting: () => !c.stopping() && queuedNotes(c.store.jobs.get(id)?.notes).length > 0,
    take: (how) => (c.stopping() ? undefined : c.store.tx(() => deliverNotes(c, id, how))),
  };
}

/** In the tx: the notes `from` never delivered go to `to`, a new job of its item, queued there; carried on `from`. */
export function carryNotes(c: EngineContext, from: Job, to: string): void {
  const { store } = c;
  const queued = queuedNotes(from.notes);
  const next = store.jobs.get(to);
  if (queued.length === 0 || !next) return;
  const ids = new Set(queued.map((n) => n.id));
  store.jobs.update(from.id, { notes: from.notes!.map((n) => (ids.has(n.id) ? { ...n, state: 'carried' as const, carriedTo: to } : n)) });
  store.jobs.update(to, { notes: [...(next.notes ?? []), ...queued.map((n) => ({ ...n, carriedFrom: from.id }))] });
  store.events.append({ type: 'job.note_carried', jobId: from.id, data: { noteIds: [...ids], nextJobId: to } });
}
