// Trust stamps (issue #655, part 1; design.md "Trust stamps"): each job carries a trust level from where its work came,
// stamped when the job is made and signed with a key of its user's, so a row changed outside the hopper's code shows.
// The rules give the level (the simple first tier: who wrote and nominated the item); a job a job made gets at most its
// parent's level, and never `owner`. A job starts only with a stamp that verifies, at the dispatch minimum or above.
// Pure: the key is passed in.
import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import type { Job } from './types.ts';

/** The trust levels, lowest first. */
export const TRUST_LEVELS = ['quarantined', 'untrusted', 'screened', 'approved', 'trusted', 'owner'] as const;
export type TrustLevel = typeof TRUST_LEVELS[number];

/** Who stamped a job: intake (the store at its making), a job that made it, a new spec, or the backfill at a start. */
export const STAMPED_BY = ['intake', 'job', 'respecify', 'backfill'] as const;
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
  /** HMAC-SHA256, base64url, under the user's stamp key. */
  mac: string;
}

/** A job starts only at this level or above (the brake per source and repository is a later part of issue #655). */
export const DISPATCH_MIN: TrustLevel = 'approved';

export const STAMP_MISSING = 'no trust stamp: held — the hopper did not make this job, or made it before stamps; cancel it, or run its item again';
export const STAMP_MISMATCH = 'its trust stamp does not match the job: held — the job changed outside the hopper; cancel it, or run its item again';

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

const macOf = (key: Buffer, job: Pick<Job, 'id' | 'spec'>, s: Omit<TrustStamp, 'mac'>): string => {
  const spec = createHash('sha256').update(canonical(job.spec)).digest('hex');
  return createHmac('sha256', key).update(canonical({ ...s, jobId: job.id, spec })).digest('base64url');
};

/** The stamp of `job` at `level`, signed under `key`. */
export function signStamp(key: Buffer, job: Pick<Job, 'id' | 'spec'>, s: { level: TrustLevel; reasons: string[]; by: StampedBy; at: string }): TrustStamp {
  const body = { v: 1 as const, level: s.level, reasons: [...s.reasons], by: s.by, at: s.at };
  return { ...body, mac: macOf(key, job, body) };
}

/** The job's level when its stamp verifies under `key`; undefined when it has none, or one that does not verify. */
export function verifiedLevel(key: Buffer, job: Pick<Job, 'id' | 'spec' | 'stamp'>): TrustLevel | undefined {
  const s = job.stamp;
  if (!s || s.v !== 1 || !TRUST_LEVELS.includes(s.level) || typeof s.mac !== 'string') return undefined;
  const { mac, ...body } = s;
  const want = Buffer.from(macOf(key, job, body));
  const got = Buffer.from(mac);
  return want.length === got.length && timingSafeEqual(want, got) ? s.level : undefined;
}

/** Why a job's stamp holds it: none, one that does not verify, or a level below the dispatch minimum; undefined: it may start. */
export function stampHold(key: Buffer, job: Pick<Job, 'id' | 'spec' | 'stamp'>): string | undefined {
  if (!job.stamp) return STAMP_MISSING;
  const level = verifiedLevel(key, job);
  if (level === undefined) return STAMP_MISMATCH;
  return atLeast(level, DISPATCH_MIN) ? undefined
    : `trust stamp ${level} is below ${DISPATCH_MIN}: held — a person approves its item in Intake, or cancels it`;
}
