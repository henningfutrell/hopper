// Trust stamps (issue #655, part 1; design.md "Trust stamps"): each job carries a trust level from where its work came,
// stamped when the job is made and signed with a key of its user's, so a row changed outside the hopper's code shows.
// The rules give the level (the simple first tier: who wrote and nominated the item); a job a job made gets at most its
// parent's level, and never `owner`. A job starts only with a stamp that verifies, at the dispatch minimum or above.
// A person can quarantine a job (part 2): its level is `quarantined` until a person lifts it, and its proxy token opens
// no door meanwhile, as for a job whose stamp does not verify. Jev's trust check (part 4, ./trust-check.ts) can lower a
// level the rules gave, never raise it; a person approves the trust of a job it lowered. A person's deny at gate 2 (part
// 5: a declined sandbox request) lowers the level one step, and the second deny in the job quarantines it. An edit of a
// started job's item that a sync sees lowers it to `untrusted` (part 7); below `approved`, gate 2 gives the job nothing
// with no person (`autoApprovable`). Pure: the key is passed in.
import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import type { Job } from './types.ts';
import { brakeWhere, type Brake } from './intake-strictness.ts';
import { CHECKED_LEVELS, checkedLevel, checkReasonOf, checkReasonText, type TrustCheck } from './trust-check.ts';

/** The trust levels, lowest first. */
export const TRUST_LEVELS = ['quarantined', 'untrusted', 'screened', 'approved', 'trusted', 'owner'] as const;
export type TrustLevel = typeof TRUST_LEVELS[number];

/**
 * Who stamped a job: intake (the store at its making), a job that made it, a new spec, the backfill at a start, a person
 * (a quarantine, its lift, an approval of its trust), Jev's trust check (part 4), or an edit of its item a sync saw after
 * the job started (part 7).
 */
export const STAMPED_BY = ['intake', 'job', 'respecify', 'backfill', 'person', 'jev', 'edit'] as const;
export type StampedBy = typeof STAMPED_BY[number];

/** A job's trust stamp: its level, why, who stamped it and when, and the MAC over these, the job's id and its spec. */
export interface TrustStamp {
  /** The stamp format: what the MAC covers. */
  v: 1;
  level: TrustLevel;
  /** Why, one reason id each (`origin:trusted`, `author:assignee`, `parent:<job id>`). */
  reasons: string[];
  by: StampedBy;
  at: string;
  /** A quarantined job's level before its quarantine: the level its lift gives back. Absent: none, or no quarantine. */
  was?: TrustLevel;
  /** Jev's trust check on this stamp (part 4): absent, none was made, or the point was not active. */
  check?: TrustCheck;
  /** HMAC-SHA256, base64url, under the user's stamp key. */
  mac: string;
}

/** A job starts only at this level or above, unless the intake strictness (brake 1, part 3) asks for another. */
export const DISPATCH_MIN: TrustLevel = 'approved';

export const STAMP_MISSING = 'no trust stamp: held — the hopper did not make this job, or made it before stamps; cancel it, or run its item again';
export const STAMP_MISMATCH = 'its trust stamp does not match the job: held — the job changed outside the hopper; cancel it, or run its item again';
export const QUARANTINED_HOLD = 'quarantined by a person: held — a person lifts the quarantine, or cancels it';
export const CHECK_PENDING = 'Jev checks its trust: held — it starts when the check keeps its level; a person can cancel it';
/** The reason id a quarantine adds to the stamp's reasons; its lift takes it away. */
const QUARANTINED = 'quarantined';
/** The reason id a person's deny at gate 2 adds to the stamp's reasons (part 5): a declined sandbox request. It stays. */
export const DENY_REASON = 'deny:sandbox';
/** The deny that quarantines a job: the second in the job. */
const DENIES_TO_QUARANTINE = 2;
const DENY_TEXT = 'a person declined its sandbox request';
/** The reason id Jev's deny at gate 2 adds (part 13: Jev's `sandbox-request` check denied a request). It stays, and counts as a deny. */
export const JEV_DENY_REASON = 'deny:jev';
const JEV_DENY_TEXT = 'Jev denied its sandbox request';
const isDeny = (r: string): boolean => r === DENY_REASON || r === JEV_DENY_REASON;
/** The reason id an edit of a started job's item adds to the stamp's reasons (part 7). It stays. */
export const EDIT_REASON = 'edit:text';
const EDIT_TEXT = 'its item was edited after it started';
/** The level an edit of a started job's item lowers it to: a person reads the new text before gate 2 gives it more. */
const EDITED_LEVEL: TrustLevel = 'untrusted';

/** The user's stamp key: HKDF of the hopper's link key for that user (issue #308), as the job proxy token's (issue #563). */
export const stampKeyOf = (linkPrivateKey: string, userId: string): Buffer =>
  Buffer.from(hkdfSync('sha256', linkPrivateKey, 'hopper-job-stamp/1', userId, 32));

const rank = (l: TrustLevel): number => TRUST_LEVELS.indexOf(l);

/** Whether `level` is `min` or above. */
export const atLeast = (level: TrustLevel, min: TrustLevel): boolean => rank(level) >= rank(min);

/** The lowest of the levels. */
export const lowest = (first: TrustLevel, ...rest: TrustLevel[]): TrustLevel =>
  rest.reduce((a, b) => (rank(b) < rank(a) ? b : a), first);

/** The source kinds that judge origins (issue #652): the GitHub sources. */
const JUDGING_KINDS = ['github', 'github-account', 'github-app'];

/**
 * Whether the job's item judges origins and the job has none (issue #1974): made before origins were judged. Its home is its
 * item: it waits for its origin (`originPending`), the next sync judges it, and a person approves its request card in Intake.
 */
export const awaitsOrigin = (job: Pick<Job, 'source'>): boolean => job.source !== undefined && JUDGING_KINDS.includes(job.source.kind) && !job.source.origin;

/** The level the rules give a job from where its work came, and why. */
export function ruleCeiling(job: Pick<Job, 'source'>): { level: TrustLevel; reasons: string[] } {
  const s = job.source;
  if (!s) return { level: 'untrusted', reasons: ['source:none'] };
  if (s.kind === 'direct') return { level: 'approved', reasons: ['source:direct'] };
  if (!JUDGING_KINDS.includes(s.kind)) return { level: 'approved', reasons: ['source:configured'] };
  if (s.origin === 'approved') return { level: 'approved', reasons: ['origin:approved'] };
  if (s.origin !== 'trusted') return { level: 'untrusted', reasons: ['origin:none'] };
  const own = s.author !== undefined && s.assignee !== undefined && s.author.toLowerCase() === s.assignee.toLowerCase();
  return own ? { level: 'owner', reasons: ['origin:trusted', 'author:assignee'] } : { level: 'trusted', reasons: ['origin:trusted'] };
}

/** The level of a job a job made: at most its parent's, and never `owner`. */
export const childLevel = (parent: TrustLevel): TrustLevel => lowest(parent, 'trusted');

/** JSON with each object's keys sorted: the same value signs the same, whatever its key order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** The SHA-256 of a spec as canonical JSON, hex: the text a stamp covers, and that `intake.stamped` names (part 11). */
export const specHashOf = (spec: Job['spec']): string => createHash('sha256').update(canonical(spec)).digest('hex');

/** What `intake.stamped` says of a stamp signed from where a job came (part 11): never the MAC. */
export type StampedEvent = { level: TrustLevel; reasons: string[]; by: StampedBy; was?: TrustLevel; from?: TrustLevel; spec: string };

/** The `intake.stamped` data of the job's stamp; `from`: the level its stamp verified at before. Undefined: no stamp. */
export function stampedEvent(job: Pick<Job, 'spec' | 'stamp'>, from?: TrustLevel): StampedEvent | undefined {
  const s = job.stamp;
  return s && { level: s.level, reasons: s.reasons, by: s.by, ...(s.was ? { was: s.was } : {}), ...(from ? { from } : {}), spec: specHashOf(job.spec) };
}

const macOf = (key: Buffer, job: Pick<Job, 'id' | 'spec'>, s: Omit<TrustStamp, 'mac'>): string =>
  createHmac('sha256', key).update(canonical({ ...s, jobId: job.id, spec: specHashOf(job.spec) })).digest('base64url');

/** The stamp of `job` at `level`, signed under `key`. */
export function signStamp(key: Buffer, job: Pick<Job, 'id' | 'spec'>, s: { level: TrustLevel; reasons: string[]; by: StampedBy; at: string; was?: TrustLevel; check?: TrustCheck }): TrustStamp {
  const body = { v: 1 as const, level: s.level, reasons: [...s.reasons], by: s.by, at: s.at, ...(s.was ? { was: s.was } : {}), ...(s.check ? { check: { ...s.check } } : {}) };
  return { ...body, mac: macOf(key, job, body) };
}

/** The job's level when its stamp verifies under `key`; undefined when it has none, or one that does not verify. */
export function verifiedLevel(key: Buffer, job: Pick<Job, 'id' | 'spec' | 'stamp'>): TrustLevel | undefined {
  const s = job.stamp;
  if (!s || s.v !== 1 || !TRUST_LEVELS.includes(s.level) || typeof s.mac !== 'string') return undefined;
  if (s.was !== undefined && !TRUST_LEVELS.includes(s.was)) return undefined;
  const { mac, ...body } = s;
  const want = Buffer.from(macOf(key, job, body));
  const got = Buffer.from(mac);
  return want.length === got.length && timingSafeEqual(want, got) ? s.level : undefined;
}

/** The last reason id that lowered a level: a deny's, an edit's or a check's; undefined: none. */
const lastLowered = (reasons: readonly string[]): string | undefined => reasons.filter((r) => isDeny(r) || r === EDIT_REASON || r.startsWith('jev:')).at(-1);

/** Why a reason id lowered a level, in words; undefined: it is none that lowers. */
function loweredText(reasons: readonly string[]): string | undefined {
  const last = lastLowered(reasons);
  if (last === DENY_REASON) return DENY_TEXT;
  if (last === JEV_DENY_REASON) return JEV_DENY_TEXT;
  if (last === EDIT_REASON) return EDIT_TEXT;
  const checked = checkReasonOf(reasons);
  return checked ? `Jev's trust check: ${checkReasonText(checked)}` : undefined;
}

/**
 * Why a job's stamp holds it: none, one that does not verify, or a level below the level `brake` needs (the dispatch
 * minimum with none); undefined: it may start. Below `approved` a person's approval is the way out; at `approved` or
 * above, only a looser brake.
 */
export function stampHold(key: Buffer, job: Pick<Job, 'id' | 'spec' | 'stamp' | 'source'>, brake?: Brake): string | undefined {
  if (!job.stamp) return STAMP_MISSING;
  const level = verifiedLevel(key, job);
  if (level === undefined) return STAMP_MISMATCH;
  if (level === 'quarantined') return QUARANTINED_HOLD;
  const min = brake?.min ?? DISPATCH_MIN;
  if (atLeast(level, min)) return undefined;
  const why = loweredText(job.stamp.reasons);
  if (why && !atLeast(level, DISPATCH_MIN)) return `trust stamp ${level} is below ${min} (${why}): held — a person approves its trust on the job, or cancels it`;
  // A job with no item has no request card: its trust is approved on the job (issue #1974).
  if (!job.source && !atLeast(level, DISPATCH_MIN)) return `trust stamp ${level} is below ${min}: held — a person approves its trust on the job, or cancels it`;
  if (!atLeast(level, DISPATCH_MIN) || !brake) return `trust stamp ${level} is below ${min}: held — a person approves its item in Intake, or cancels it`;
  return `trust stamp ${level} is below ${min} (intake strictness ${brake.strictness} ${brakeWhere(brake)}): held — an admin changes the intake strictness in Settings → Intake, or a person cancels it`;
}

/**
 * The job quarantined by a person, at `at`: its level `quarantined`, its level before kept as `was` when its stamp
 * verifies. A job whose stamp does not verify keeps no level and no reasons: its lift gives it the rules' level.
 */
export function quarantinedStamp(key: Buffer, job: Pick<Job, 'id' | 'spec' | 'stamp'>, at: string): TrustStamp {
  const was = verifiedLevel(key, job);
  const reasons = was !== undefined && job.stamp ? job.stamp.reasons : [];
  return signStamp(key, job, { level: 'quarantined', reasons: [...reasons, QUARANTINED], by: 'person', at, ...(was ? { was } : {}) });
}

/** The quarantine lifted by a person, at `at`: the level the job had before it, never more; with none kept, the rules' level. */
export function liftedStamp(key: Buffer, job: Pick<Job, 'id' | 'spec' | 'stamp' | 'source'>, at: string): TrustStamp {
  const was = job.stamp?.was;
  if (!was) { const ceiling = ruleCeiling(job); return signStamp(key, job, { level: ceiling.level, reasons: ceiling.reasons, by: 'person', at }); }
  return signStamp(key, job, { level: was, reasons: (job.stamp?.reasons ?? []).filter((r) => r !== QUARANTINED), by: 'person', at });
}

/**
 * Whether the job's proxy token opens the hopper's doors (gate 2's first step): only with a stamp that verifies, at any
 * level but `quarantined`. A running job was at the dispatch minimum when it started; a level below it now opens them still.
 */
export function opensDoors(key: Buffer, job: Pick<Job, 'id' | 'spec' | 'stamp'>): boolean {
  const level = verifiedLevel(key, job);
  return level !== undefined && level !== 'quarantined';
}

/** The level gate 2 needs to approve a job's privileged requests with no person: `approved`, or the brake's when higher (part 12). */
export const gate2Min = (brake: Brake): TrustLevel => (atLeast(brake.min, DISPATCH_MIN) ? brake.min : DISPATCH_MIN);

/**
 * Whether gate 2 may approve the job's privileged requests with no person (part 7): its stamp verifies at the dispatch
 * minimum `approved` or above, and at the level `brake` (brake 1, read at each ask) needs (part 12). Below it — an edit,
 * Jev's check or a deny lowered it, or an admin tightened the brake after the start — a sandbox request waits for a
 * person, the standing read grant grants nothing, and a need step is refused.
 */
export function autoApprovable(key: Buffer, job: Pick<Job, 'id' | 'spec' | 'stamp'>, brake: Brake): boolean {
  return gate2Hold(key, job, brake) === undefined;
}

/** Why gate 2 asks a person for each of the job's privileged requests under `brake`; undefined: it does not. */
export function gate2Hold(key: Buffer, job: Pick<Job, 'id' | 'spec' | 'stamp'>, brake: Brake): string | undefined {
  const level = verifiedLevel(key, job);
  if (level === undefined) return 'its trust stamp does not verify';
  const min = gate2Min(brake);
  if (atLeast(level, min)) return undefined;
  return atLeast(level, DISPATCH_MIN)
    ? `its trust stamp ${level} is below ${min} (intake strictness ${brake.strictness} ${brakeWhere(brake)})`
    : `its trust stamp ${level} is below ${min}`;
}

/**
 * The stamp after a sync saw the item of a started job edited (part 7), at `at`: `untrusted`, with the edit's reason, by
 * the edit; Jev's check stays on it. Undefined: the job is at `untrusted` or lower already, or its stamp does not verify.
 */
export function editedStamp(key: Buffer, job: Pick<Job, 'id' | 'spec' | 'stamp'>, at: string): TrustStamp | undefined {
  const level = verifiedLevel(key, job);
  if (level === undefined || !job.stamp || rank(level) <= rank(EDITED_LEVEL)) return undefined;
  return signStamp(key, job, { level: EDITED_LEVEL, reasons: [...job.stamp.reasons, EDIT_REASON], by: 'edit', at, ...(job.stamp.check ? { check: job.stamp.check } : {}) });
}

/**
 * Whether Jev's trust check is due for the job: its stamp verifies at a level it would start at on the rules alone
 * (`approved`, `trusted`), no person stamped it, and no check was made on it. A new spec or an origin judged later makes a
 * new stamp, so the check is due again.
 */
export function checkDue(key: Buffer, job: Pick<Job, 'id' | 'spec' | 'stamp'>): boolean {
  const level = verifiedLevel(key, job);
  return level !== undefined && CHECKED_LEVELS.includes(level) && job.stamp?.by !== 'person' && job.stamp?.by !== 'jev' && job.stamp?.check === undefined;
}

/** The stamp after Jev's check (the point active), at `at`: the level it keeps or the lower one, with the check and its reason. */
export function checkedStamp(key: Buffer, job: Pick<Job, 'id' | 'spec' | 'stamp'>, out: Parameters<typeof checkedLevel>[1], at: string): TrustStamp | undefined {
  const level = verifiedLevel(key, job);
  if (level === undefined || !job.stamp) return undefined;
  const c = checkedLevel(level, out);
  return signStamp(key, job, { level: c.level, reasons: [...job.stamp.reasons, ...(c.reason ? [c.reason] : [])], by: 'jev', at, check: c.check });
}

/**
 * Whether a person may approve the job's trust: Jev's check, a person's deny or an edit lowered it below the dispatch
 * minimum, or it has no item (issue #1974: no request card can approve it), and its stamp verifies. A job of an item is
 * approved through its item's request card (issue #896).
 */
export function trustApprovable(key: Buffer, job: Pick<Job, 'id' | 'spec' | 'stamp' | 'source'>): boolean {
  const level = verifiedLevel(key, job);
  return level !== undefined && level !== 'quarantined' && !atLeast(level, DISPATCH_MIN) && (lastLowered(job.stamp?.reasons ?? []) !== undefined || !job.source);
}

/**
 * The stamp after a deny at gate 2, at `at`: a person's (part 5) or Jev's (part 13, `by: jev`). One level lower, with the
 * deny's reason; the second deny in the job, a person's or Jev's, or a deny of a job at `untrusted`, quarantines it, its
 * level before kept as `was`. Undefined: the job is quarantined already, or its stamp does not verify. Denies stay on the
 * stamp: a lift or a person's approval keeps them.
 */
export function deniedStamp(key: Buffer, job: Pick<Job, 'id' | 'spec' | 'stamp'>, at: string, by: 'person' | 'jev' = 'person'): TrustStamp | undefined {
  const level = verifiedLevel(key, job);
  if (level === undefined || level === 'quarantined' || !job.stamp) return undefined;
  const reasons = [...job.stamp.reasons, by === 'jev' ? JEV_DENY_REASON : DENY_REASON];
  const check = job.stamp.check ? { check: job.stamp.check } : {};
  const lower = TRUST_LEVELS[rank(level) - 1]!;
  if (lower === 'quarantined' || reasons.filter(isDeny).length >= DENIES_TO_QUARANTINE) {
    return signStamp(key, job, { level: 'quarantined', reasons: [...reasons, QUARANTINED], by, at, was: level, ...check });
  }
  return signStamp(key, job, { level: lower, reasons, by, at, ...check });
}

/** The job's trust approved by a person, at `at`: `approved`, never more; Jev's check stays on the stamp, so it is not asked again. */
export const trustApprovedStamp = (key: Buffer, job: Pick<Job, 'id' | 'spec' | 'stamp'>, at: string): TrustStamp =>
  signStamp(key, job, { level: 'approved', reasons: [...(job.stamp?.reasons ?? []), 'person:approved'], by: 'person', at, ...(job.stamp?.check ? { check: job.stamp.check } : {}) });
