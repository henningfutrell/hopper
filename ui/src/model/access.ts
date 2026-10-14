// Access in plain words (issues #559, #581): a relationship tuple and a chain of them, as Settings → Access shows an
// approval and the path that allowed a decision; a requester by its kind and name. Pure.
import type { Requester, RelationshipTuple } from './wire.ts';

const OPERATION_WORD = /^grants_(read|write|sync|apply)$/;

/** `operation_profile:read/cluster/x` → `read on cluster x`; `asset:cluster/x` → `cluster x`; `template:t` → `template t`. */
function objectText(object: string): string {
  const colon = object.indexOf(':');
  const type = object.slice(0, colon);
  const id = object.slice(colon + 1);
  const first = id.indexOf('/');
  if (type === 'template') return `template ${id}`;
  if (type === 'user') return `user ${id}`;
  // A job and a machine are named after their user: `job:<user>/<job>`, `machine:<user>/<name, escaped>`.
  if ((type === 'job' || type === 'machine') && first > 0) return `${type} ${type === 'machine' ? decodeURIComponent(id.slice(first + 1)) : id.slice(first + 1)}`;
  if (type === 'asset' && first > 0) return `${id.slice(0, first)} ${id.slice(first + 1)}`;
  if (type === 'operation_profile') {
    const second = id.indexOf('/', first + 1);
    if (first > 0 && second > first) return `${id.slice(0, first)} on ${id.slice(first + 1, second)} ${id.slice(second + 1)}`;
  }
  return object;
}

/** One tuple as a sentence; one the model does not know as it is. */
export function tupleText(t: RelationshipTuple): string {
  if (t.relation === 'running' && t.subject.startsWith('job:')) return `this job runs from ${objectText(t.object)}`;
  if (t.relation === 'owns') return `${objectText(t.subject)} owns ${objectText(t.object)}`;
  if (t.relation === 'runs_on') return `${objectText(t.subject)} runs on ${objectText(t.object)}`;
  if (t.relation === 'instance_of') return `${objectText(t.subject)} is an instance of ${objectText(t.object)}`;
  if (t.relation === 'approved_for') return `${objectText(t.subject)} is approved for ${objectText(t.object)}`;
  const grant = OPERATION_WORD.exec(t.relation);
  if (grant) return `${objectText(t.subject)} grants ${grant[1]} on ${objectText(t.object)}`;
  return `${t.subject} ${t.relation} ${t.object}`;
}

export const chainText = (chain: readonly RelationshipTuple[]): string => chain.map(tupleText).join(' → ');

/** A requester as a row names it: `job j1`, `machine kbox`, `user admin`. */
export const requesterText = (r: Requester): string => (r.kind === 'job' ? `job ${r.jobId}` : r.kind === 'machine' ? `machine ${r.machine}` : `user ${r.userId}`);

/** The requester's OpenFGA object, as the hopper names it (`src/authz/objects.ts`): a row's key. */
export const requesterKey = (r: Requester): string =>
  r.kind === 'job' ? `job:${r.userId}/${r.jobId}` : r.kind === 'machine' ? `machine:${r.userId}/${encodeURIComponent(r.machine)}` : `user:${r.userId}`;
