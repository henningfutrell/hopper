// Follow-ons of an accepted proposal (issue #651, design.md "Proposals: a set of paths"). Each path a person selected
// continues on its own, as a new job with the parent's spec, priority and work tree, told its path, the person's note
// and the other paths selected with it. A person selected it, so it passes the queue gate at once. Like a fork, it has
// no source of its own: it names its parent's item, and the sync never reports it to that item. The selection on the
// proposal records each follow-on's job; the proposal shows each one's live state. Runs inside the review service's tx.
import type { FollowOnOf, Job, JobSpec, ReviewItem, SelectedPath } from '../domain/types.ts';
import { priorityTagOf, type EngineContext } from './context.ts';

/** Inside the tx that accepted `p`: one follow-on job per selected path; the selection, each with its job. */
export function createFollowOns(c: EngineContext, parent: Job, p: ReviewItem): SelectedPath[] {
  const { store } = c;
  const selected = p.signOff?.selected ?? [];
  if (selected.length === 0) return [];
  const v = p.versions[p.signOff!.version - 1] ?? p.versions.at(-1)!;
  const paths = v.paths?.paths ?? [];
  const { proposal: _p, research: _r, ...rest } = parent.spec;
  const spec: JobSpec = rest;
  const from = parent.source ?? parent.forkOf?.source;
  const source = from ? { source: from.source, key: from.key, kind: from.kind, ...(from.url ? { url: from.url } : {}), ...(from.title ? { title: from.title } : {}), ...(from.repo ? { repo: from.repo } : {}) } : undefined;
  const linked = selected.map((s): SelectedPath => {
    const followOn: FollowOnOf = {
      jobId: parent.id, proposalId: p.id, pathId: s.id, title: s.title, text: paths.find((x) => x.id === s.id)?.text ?? s.title,
      ...(s.note ? { note: s.note } : {}), siblings: selected.filter((o) => o.id !== s.id).map((o) => `Path ${o.id}: ${o.title}`), ...(source ? { source } : {}),
    };
    const created = store.jobs.create(spec, parent.priority);
    store.events.append({ type: 'job.queued', jobId: created.id, data: { spec, priority: parent.priority, followOn: { jobId: parent.id, proposalId: p.id, pathId: s.id } } });
    store.jobs.update(created.id, { accepted: true, followOn });
    return { ...s, jobId: created.id };
  });
  store.reviews.proposal.update(p.id, { signOff: { ...p.signOff!, selected: linked } });
  store.events.append({
    type: 'proposal.followed_on', jobId: parent.id,
    data: { proposalId: p.id, version: p.signOff!.version, followOns: linked.map((s) => ({ pathId: s.id, jobId: s.jobId! })), ...priorityTagOf(c, parent.id) },
  });
  return linked;
}
