// A job's trust stamp on the job view (issue #655): its trust level in plain words, and whether a person may quarantine
// it, or lift its quarantine; why Jev's trust check lowered it, and whether a person may approve its trust (part 4). The
// daemon checks the stamp; the UI only reads what it says. A person's deny at gate 2 lowers a job too (part 5), and an
// edit of a started job's item (part 7). Intake lists the waiting jobs a trust stamp holds, with why (`heldByTrust`).
import type { Job, JobStatus } from './wire.ts';

/** The statuses a job ends in (src/domain/types.ts TERMINAL_STATUSES): an ended job is not quarantined or lifted. */
const ENDED: readonly JobStatus[] = ['finished', 'failed', 'cancelled', 'rejected'];

type Level = NonNullable<Job['stamp']>['level'];

const LEVEL: Record<Level, string> = {
  owner: 'owner — you wrote and nominated its item',
  trusted: 'trusted — a trusted actor wrote its item',
  approved: 'approved — a person approved it',
  screened: 'screened — nothing found, no person approved it',
  untrusted: 'untrusted — held until a person approves it',
  quarantined: 'quarantined — held, and it reaches nothing through the hopper',
};

/** The job's trust level in plain words; undefined: it has no stamp. */
export const trustText = (job: Pick<Job, 'stamp'>): string | undefined => (job.stamp ? LEVEL[job.stamp.level] : undefined);

export const isQuarantined = (job: Pick<Job, 'stamp'>): boolean => job.stamp?.level === 'quarantined';

/** Whether the job view offers Quarantine or Lift quarantine: a job that has not ended, with a stamp. */
export const quarantineOffered = (job: Pick<Job, 'status' | 'stamp'>): boolean => job.stamp !== undefined && !ENDED.includes(job.status);

/** Why Jev's trust check lowers a job (src/domain/trust-check.ts), in plain words. */
const CHECK_REASON: Readonly<Record<string, string>> = {
  touches_ci: 'it changes CI, workflow files or branch rules',
  credentials: 'it asks for credentials, tokens or secrets',
  destructive: 'it deletes, overwrites or force-pushes',
  out_of_scope: 'it works outside its own repository',
  instructs_agent: 'its text gives instructions to the agent or to Jev',
  fork_code: 'it brings in a pull request of a fork that no trusted actor wrote',
  unclear: 'what it asks for is not clear',
  no_answer: 'Jev gave no answer',
  not_sure: 'Jev was not sure enough',
  skipped: 'Jev could not be asked',
};

/** A person's deny at gate 2 (src/domain/trust-stamp.ts DENY_REASON): a declined sandbox request. */
const DENY_REASON = 'deny:sandbox';
/** Jev's deny at gate 2 (src/domain/trust-stamp.ts JEV_DENY_REASON, part 13): its sandbox-request check denied a request. */
const JEV_DENY_REASON = 'deny:jev';
/** An edit of a started job's item (src/domain/trust-stamp.ts EDIT_REASON). */
const EDIT_REASON = 'edit:text';

/** The last reason that lowered the stamp: a deny's, an edit's, or Jev's trust check's id; undefined: none lowered it. */
const loweredBy = (job: Pick<Job, 'stamp'>): string | undefined =>
  job.stamp?.reasons.filter((r) => r === DENY_REASON || r === JEV_DENY_REASON || r === EDIT_REASON || r.startsWith('jev:')).at(-1);

/** Below this a job is held for a person (src/domain/trust-stamp.ts DISPATCH_MIN): `untrusted`, `screened`. */
const BELOW_APPROVED: readonly Level[] = ['untrusted', 'screened'];

/** Why Jev's trust check, a person's deny or an edit holds the job, in plain words; undefined: none holds it. */
export function trustCheckText(job: Pick<Job, 'stamp'>): string | undefined {
  const r = loweredBy(job);
  if (!r || !job.stamp || !BELOW_APPROVED.includes(job.stamp.level)) return undefined;
  if (r === DENY_REASON) return 'A person declined its sandbox request';
  if (r === JEV_DENY_REASON) return 'Jev denied its sandbox request';
  if (r === EDIT_REASON) return 'Its item was edited after it started';
  const id = r.slice('jev:'.length);
  return `Jev's trust check lowered it: ${CHECK_REASON[id] ?? id}`;
}

/** Whether the job view offers Approve trust: a job that has not ended that Jev's trust check, a deny or an edit lowered below approved. */
export const trustApprovalOffered = (job: Pick<Job, 'status' | 'stamp'>): boolean => quarantineOffered(job) && trustCheckText(job) !== undefined;

type OriginAct = NonNullable<NonNullable<Job['source']>['originActs']>[number];

const ROLE_TEXT: Record<OriginAct['role'], string> = { author: 'written', labelled: 'labelled', assigned: 'assigned', edited: 'edited' };
const DID_TEXT: Record<OriginAct['role'], string> = { author: 'wrote', labelled: 'labelled', assigned: 'assigned', edited: 'edited' };

/**
 * The job's origin acts (part 14) in plain words: who wrote, labelled and assigned its item, through which app, and whether
 * a trusted actor did each (src/domain/intake-origin.ts). None: the job keeps none.
 */
export function originActLines(job: Pick<Job, 'source'>): { text: string; trusted: boolean }[] {
  return (job.source?.originActs ?? []).map((a) => ({
    text: a.login ? `${ROLE_TEXT[a.role]} by ${a.login}${a.app ? ` through ${a.app}` : ''}` : `who ${DID_TEXT[a.role]} it is not known`,
    trusted: a.trusted,
  }));
}

/** `owner/name#N` of a GitHub pull request or issue URL; the URL itself when it is neither. */
const nameOf = (url: string): string => /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/(?:pull|issues)\/(\d+)$/.exec(url)?.slice(1, 3).join('#') ?? url;

/**
 * The job's links (part 19) in plain words: its repository's visibility, then each pull request its item's text names —
 * who wrote it, whether it is of a fork, whether a trusted actor wrote it (src/domain/linked-pulls.ts). `warn`: a pull request
 * no trusted actor wrote, or one not read. None: the job keeps none.
 */
export function linkLines(job: Pick<Job, 'source'>): { text: string; warn: boolean; url?: string }[] {
  const s = job.source;
  return [
    ...(s?.visibility ? [{ text: `${s.visibility} repository`, warn: false }] : []),
    ...(s?.linkedPulls ?? []).map((p) => ({
      text: p.unread ? `names ${nameOf(p.url)}, which could not be read`
        : `names ${nameOf(p.url)}${p.fork ? ', of a fork' : ''}${p.author ? `, by ${p.author}` : ''}${p.trusted ? '' : ' (not a trusted actor)'}`,
      warn: !p.trusted, url: p.url,
    })),
  ];
}

/**
 * How a waiting job's trust stamp holds it (src/domain/trust-stamp.ts `stampHold`, `CHECK_PENDING`): `missing` no stamp,
 * `mismatch` one that does not verify, `quarantined`, `checking` Jev's trust check is due, `below` a level below the
 * dispatch minimum, `brake` a level below the intake strictness.
 */
export type TrustHold = 'missing' | 'mismatch' | 'quarantined' | 'checking' | 'below' | 'brake';

/** The start of each trust hold the daemon gives (the UI imports nothing of src/ at run time; test/ui/trust-held.test.ts checks them). */
const HOLD_START: readonly [string, TrustHold][] = [
  ['no trust stamp: held', 'missing'],
  ['its trust stamp does not match the job: held', 'mismatch'],
  ['quarantined by a person: held', 'quarantined'],
  ['Jev checks its trust: held', 'checking'],
];

/** How the job's trust stamp holds it; undefined: the job is not held, or held for another reason. */
export function trustHold(job: Pick<Job, 'status' | 'holdReason'>): TrustHold | undefined {
  const r = job.holdReason;
  if (job.status !== 'held' || !r) return undefined;
  const found = HOLD_START.find(([start]) => r.startsWith(start));
  if (found) return found[1];
  if (!r.startsWith('trust stamp ')) return undefined;
  return r.includes('(intake strictness ') ? 'brake' : 'below';
}

export interface TrustHeld { job: Job; hold: TrustHold; forPerson: boolean }

/** The waiting jobs a trust stamp holds: those a person acts on first, then those Jev still checks. */
export function heldByTrust(jobs: readonly Job[]): TrustHeld[] {
  const held = jobs.flatMap((job) => { const hold = trustHold(job); return hold ? [{ job, hold, forPerson: hold !== 'checking' }] : []; });
  return [...held.filter((h) => h.forPerson), ...held.filter((h) => !h.forPerson)];
}

/** How many waiting jobs a trust stamp holds for a person: the nav's Intake badge and Needs you count them. */
export const trustHeldWaiting = (jobs: Readonly<Record<string, Job>>): number => heldByTrust(Object.values(jobs)).filter((h) => h.forPerson).length;
