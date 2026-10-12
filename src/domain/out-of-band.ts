// Out-of-band changes (issue #871, design.md "Out-of-band changes"): infrastructure changes that did not come through IaC
// or GitOps, tracked in Infra changes. One generic rule and no per-action classifier: a write is out of band unless a
// GitOps controller identity or a plan-bound apply credential made it. Drift (a GitOps app out of sync, a non-empty
// `terraform plan` on unchanged code) is out of band by itself. The types, the limits, the rule and the repository port. Pure.

/** Where a signal comes from: drift (`gitops`, `terraform-plan`) or an audit log (`cloudtrail`, `kube-audit`). */
export const SIGNAL_SOURCES = ['gitops', 'terraform-plan', 'cloudtrail', 'kube-audit'] as const;
export type SignalSource = (typeof SIGNAL_SOURCES)[number];
/** The audit logs: each of their signals names who wrote, and the rule judges that principal. */
export const AUDIT_SOURCES: readonly SignalSource[] = ['cloudtrail', 'kube-audit'];

/** What a person marks an out-of-band change: brought back into git, undone, or kept as it is (with a reason). */
export const MARKS = ['adopted', 'reverted', 'accepted'] as const;
export type Mark = (typeof MARKS)[number];

/** The most signals one report holds, and the most text a signal's detail keeps (the plan text, the diff, the record). */
export const SIGNALS_MAX = 500;
export const DETAIL_MAX = 64 * 1024;
const LINE_MAX = 300;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * One signal a read-only check found: drift, or an audit-log write (the check keeps only writes). `key`: the signal's own
 * id, so a report sent twice records it once (CloudTrail's `eventID`, the audit log's `auditID`; for drift, what drifted).
 */
export interface Signal {
  source: SignalSource;
  key: string;
  /** What changed: the resource, the app, the workspace, in the source's words. */
  target: string;
  /** The action, in the source's words: `ec2:AuthorizeSecurityGroupIngress`, `patch deployments`, `OutOfSync`, `1 to change`. */
  what: string;
  /** The principal that wrote, as the audit log names it. An audit-log signal names one. */
  who?: string;
  /** When it happened (an audit log) or when it was found (drift). */
  at: string;
  /** The record, the diff, or the plan text, as the source gives it. */
  detail?: string;
}

/**
 * An out-of-band change as kept: the signal, who reported it, and when. Never changed once kept. Who reported it: the
 * `job` whose check did, or the `reporter`, an outside collector by its API token's grant label (part 2). One of the two.
 */
export interface OutOfBandChange extends Signal { id: string; job?: string; reporter?: string; recordedAt: string }

/** Who reports signals: a running job's check, or an outside collector with an API token, by its grant's label. */
export type SignalReporter = { job: string; issue?: string } | { reporter: string };

/** A person's mark on a change: a row of its own, so the change itself never changes. */
export interface OutOfBandMark { change: string; mark: Mark; reason?: string; by: string; at: string }

export interface OutOfBandView extends OutOfBandChange { marked?: OutOfBandMark }

/** A credential the vault minted for an approved plan (issue #870): who it writes as, and while it is valid. */
export interface ApplyIdentity { principal: string; plan: string; job: string; from: string; until: string }

export interface OutOfBandRepository {
  add(change: OutOfBandChange): void;
  get(id: string): OutOfBandChange | undefined;
  /** The kept changes of this source and key, each with whether it is marked. */
  find(source: SignalSource, key: string): { id: string; marked: boolean }[];
  /** The newest first, at most `limit`, with their marks. */
  list(limit: number): OutOfBandView[];
  mark(m: OutOfBandMark): void;
  markOf(id: string): OutOfBandMark | undefined;
  controllers(): string[];
  setControllers(identities: string[]): void;
}

const oneLine = (s: unknown, max = LINE_MAX): boolean => typeof s === 'string' && s.trim().length > 0 && s.length <= max && !/[\n\r]/.test(s);

/** Why a signal is not one the hopper keeps, or undefined. */
export function signalProblem(s: Signal): string | undefined {
  if (!(SIGNAL_SOURCES as readonly string[]).includes(s.source)) return `source must be one of ${SIGNAL_SOURCES.join(', ')}`;
  if (!oneLine(s.key, 200)) return 'key must be the signal\'s own id, one line of 1 to 200 characters: the eventID, the auditID, or what drifted';
  if (!oneLine(s.target)) return `target must be one line of 1 to ${LINE_MAX} characters: what changed`;
  if (!oneLine(s.what)) return `what must be one line of 1 to ${LINE_MAX} characters: the action, in the source's words`;
  if (s.who !== undefined && !oneLine(s.who)) return `who must be one line of 1 to ${LINE_MAX} characters`;
  if (AUDIT_SOURCES.includes(s.source) && s.who === undefined) return 'who must name the principal that wrote: an audit-log signal is judged by it';
  if (typeof s.at !== 'string' || !ISO.test(s.at) || Number.isNaN(Date.parse(s.at))) return 'at must be when it happened, an ISO 8601 time';
  if (s.detail !== undefined && (typeof s.detail !== 'string' || Buffer.byteLength(s.detail) > DETAIL_MAX)) return `detail must be at most ${DETAIL_MAX} bytes of text`;
  return undefined;
}

/** Why a list of controller identities is not one the hopper keeps, or undefined. */
export function controllerProblem(identities: readonly string[]): string | undefined {
  if (identities.length > 100) return 'at most 100 controller identities';
  for (const id of identities) {
    if (!oneLine(id)) return `each controller identity is one line of 1 to ${LINE_MAX} characters`;
    if (id.trim() === '*') return 'a controller identity of * names every principal: then nothing is out of band';
    if (id.slice(0, -1).includes('*')) return `${id}: a * goes only at the end`;
  }
  return undefined;
}

/** Why a mark is not one a person can set, or undefined. */
export function markProblem(mark: Mark, reason: string | undefined): string | undefined {
  if (!(MARKS as readonly string[]).includes(mark)) return `mark must be one of ${MARKS.join(', ')}`;
  if (reason !== undefined && reason.length > 1000) return 'reason must be at most 1000 characters';
  if (mark === 'accepted' && !reason?.trim()) return 'accepted needs a reason: why the change stays out of git';
  return undefined;
}

const matches = (pattern: string, principal: string): boolean =>
  (pattern.endsWith('*') ? principal.startsWith(pattern.slice(0, -1)) : principal === pattern);

/**
 * The rule. Drift is out of band. An audit-log write is in band only when a controller identity or a plan-bound apply
 * credential, valid at the time of the write, made it; `why` names which. Hopper never asks what the action was.
 */
export function judge(s: Signal, controllers: readonly string[], applies: readonly ApplyIdentity[]): { outOfBand: true } | { outOfBand: false; why: string } {
  if (!AUDIT_SOURCES.includes(s.source) || s.who === undefined) return { outOfBand: true };
  const who = s.who;
  const controller = controllers.find((c) => matches(c, who));
  if (controller) return { outOfBand: false, why: `controller ${controller}` };
  const at = Date.parse(s.at);
  const bound = applies.find((a) => a.principal === who && Date.parse(a.from) <= at && at <= Date.parse(a.until));
  if (bound) return { outOfBand: false, why: `apply of plan ${bound.plan} by job ${bound.job}` };
  return { outOfBand: true };
}

/** An IAM role's ARN: its partition, account and name (after any path). */
const ROLE = /^arn:(aws[a-z-]*):iam::(\d{12}):role\/(?:[\w+=,.@-]+\/)*([\w+=,.@-]+)$/;

/**
 * Who a minted credential writes as, as an audit log names it: the assumed role's session (CloudTrail's
 * `userIdentity.arn`), or the service account (the Kubernetes audit log's `user.username`).
 */
export function mintPrincipal(m: { kind: 'aws'; roleArn: string; sessionName: string } | { kind: 'kube'; namespace: string; serviceAccount: string }): string | undefined {
  if (m.kind === 'kube') return `system:serviceaccount:${m.namespace}:${m.serviceAccount}`;
  const r = ROLE.exec(m.roleArn);
  return r ? `arn:${r[1]}:sts::${r[2]}:assumed-role/${r[3]}/${m.sessionName}` : undefined;
}
