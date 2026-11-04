// The Vault settings page's model (issue #558): what a secret's card says — its scope, who set it and when, who last
// changed it — and whether a name is one the hopper takes. A secret here is only its metadata: there is no value to show.
// A secret kept in a vault backend (issue #585) says where: the backend and the reference read there at each use.
import { highFirst, isHighJob } from './priority.ts';
import type { Asset, CredentialRequest, Job, OperationProfile, ProfileAsk, RunCardView, SandboxApprovals, SandboxRequestView, TemplateRadius, TemplateView, VaultSecret, VaultView } from './wire.ts';

/** The hopper's rule for a vault secret's name (src/domain/vault.ts). */
const NAME = /^[A-Za-z][A-Za-z0-9_.-]*$/;

/** Why `name` is no vault secret name, or undefined. */
export function nameProblem(name: string): string | undefined {
  if (!name) return 'a name is needed';
  if (name.length > 64) return 'at most 64 characters';
  if (!NAME.test(name)) return 'a letter, then letters, digits, _ . or -';
  return undefined;
}

/** A date and time in the viewer's own form. */
const when = (iso: string): string => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

export interface Fact { label: string; value: string }

/** The card's facts: what it mints for or its scope when said, who set it, who changed it when that came later, and its last use. */
export function secretFacts(s: VaultSecret): Fact[] {
  return [
    ...(s.mints ? [{ label: 'Mints for', value: `${s.mints.kind} ${s.mints.name}` }] : []),
    ...(s.backend ? [{ label: 'Kept in', value: `${s.backend.name} · ${s.backend.reference}` }] : []),
    ...(s.scope ? [{ label: 'Scope', value: s.scope }] : []),
    { label: 'Set by', value: `${s.setBy} · ${when(s.createdAt)}` },
    ...(s.changedAt !== s.createdAt ? [{ label: 'Changed by', value: `${s.changedBy} · ${when(s.changedAt)}` }] : []),
    ...(s.lastUsed ? [{ label: s.mints ? 'Last minted' : 'Last delivered', value: `${s.lastUsed.machine} · ${s.lastUsed.job !== undefined ? `job ${s.lastUsed.job.slice(0, 8)}` : `schedule ${s.lastUsed.schedule}`} · ${when(s.lastUsed.at)}` }] : []),
  ];
}

const MINTS = /^(cluster|aws-account)\/([A-Za-z0-9][A-Za-z0-9._+=,-]{0,199})$/;
/** A database (issue #2231): its whole name, `/` in it too. */
const MINTS_DATABASE = /^database\/([A-Za-z0-9][A-Za-z0-9._/+=,-]{0,199})$/;

/**
 * What a minting credential mints for (issue #580), as typed: `cluster/NAME`, `aws-account/ID` or (issue #2231)
 * `database/CLUSTER/NAMESPACE/DATABASE`. Undefined when empty (a plain secret); a string says why it is not one.
 */
export function mintsOf(said: string): Asset | string | undefined {
  const v = said.trim();
  if (!v) return undefined;
  const m = MINTS.exec(v), d = MINTS_DATABASE.exec(v);
  if (d) return { kind: 'database', name: d[1]! };
  return m ? { kind: m[1] as Asset['kind'], name: m[2]! } : 'write it as cluster/NAME, aws-account/ID or database/CLUSTER/NAMESPACE/DATABASE';
}

/**
 * The value a minting credential holds (issue #1761), shown under the form's value: an AWS account's keys are one JSON
 * value, never a secret each. `problem`: why the typed value is not one, never the value.
 */
export function mintsValueOf(mints: Asset | undefined, value: string): { shape?: string; problem?: string } {
  if (mints?.kind === 'database') return databaseValueOf(value);
  if (mints?.kind === 'cluster') return { shape: 'JSON: {"server": "https://…", "token": "…"}, or {"type": "eks", "roleArn": "arn:aws:iam::<account>:role/<name>", …}' };
  if (mints?.kind !== 'aws-account') return {};
  const shape = 'JSON, both keys in one secret: {"AccessKeyId": "AKIA…", "SecretAccessKey": "…"} (and Region, Endpoint or SessionToken when it has them)';
  if (!value) return { shape };
  let v: Record<string, unknown> = {};
  try { v = JSON.parse(value) as Record<string, unknown>; } catch { /* below */ }
  const has = (k: string): boolean => typeof v?.[k] === 'string' && v[k] !== '';
  return has('AccessKeyId') && has('SecretAccessKey') ? { shape } : { shape, problem: 'an AWS account\'s minting credential is JSON with AccessKeyId and SecretAccessKey' };
}

/**
 * A database's minting credential (issue #2231): one JSON value, the login that makes and drops the database read roles and the
 * schemas and tables a database read role may SELECT from. `problem`: why the typed value is not one, never the value.
 */
function databaseValueOf(value: string): { shape: string; problem?: string } {
  const shape = 'JSON: {"engine": "postgres" or "sqlserver", "host": "…", "database": "…", "user": "<the minting login>", "password": "…", "schemas": ["public"], "tables": ["<schema>.<table>"]} (schemas, tables or both; and port, sslmode — verify-full, require or disable — or ca when it has them)';
  if (!value) return { shape };
  let v: Record<string, unknown> = {};
  try { v = JSON.parse(value) as Record<string, unknown>; } catch { /* below */ }
  const has = (k: string): boolean => typeof v?.[k] === 'string' && v[k] !== '';
  const count = (k: string): number => (Array.isArray(v?.[k]) ? (v[k] as unknown[]).length : 0);
  const whole = ['engine', 'host', 'database', 'user', 'password'].every(has) && count('schemas') + count('tables') > 0;
  return whole ? { shape } : { shape, problem: 'a database\'s minting credential is JSON with engine, host, database, user, password, and schemas or tables' };
}

/** What the card's title line says of the value: set in the hopper, or kept in a backend and read there. */
export const keptText = (s: VaultSecret): string => (s.backend ? `kept in ${s.backend.name} · read at each use` : 'value set · write-only');

/** An example of the reference each built-in vault backend reads (issue #585); none for another plugin. */
const REFERENCE_HINTS: Record<string, string> = {
  'hashicorp-vault': 'apps/db#password',
  '1password': 'op://Infra/db/password',
  bitwarden: '0f8fad5b-d9cb-469f-a165-70867728950e',
};
export const referenceHint = (plugin: string): string => REFERENCE_HINTS[plugin] ?? '';

/** The image a new template starts with: the published sandbox box. */
export const DEFAULT_BOX_IMAGE = 'ghcr.io/henningfutrell/hopper:box-claude';

/** The tools the hopper adds to a box's image (issue #716): the server's list (src/domain/sandboxes.ts BOX_TOOLS). */
export const BOX_TOOLS = ['aws', 'helm', 'jq', 'kubectl', 'logcli', 'promtool', 'terraform'] as const;

/** A template's tools, with `(waits)` when its tools are not the approved ones; `none` without. */
export function toolsText(t: { tools?: readonly string[]; approval?: { tools?: readonly string[] } }): string {
  const now = t.tools ?? [];
  if (now.length === 0) return 'none';
  const was = t.approval?.tools ?? [];
  return now.map((x) => (t.approval && !was.includes(x) ? `${x} (waits)` : x)).join(', ');
}

/** An egress host (issue #1875): `host:port`, a DNS name or an address (src/domain/vault.ts egressHostProblem). */
export const EGRESS_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*:[1-9][0-9]{0,4}$/;

/** The egress hosts typed in a field, split by spaces, commas or lines, in lowercase. */
export const egressOf = (text: string): string[] => [...new Set(text.toLowerCase().split(/[\s,]+/).filter((h) => h !== ''))];

/** A template's egress hosts, with `(waits)` when one is not approved; `none` without. */
export const egressText = (t: { egress?: readonly string[]; pending?: { egress: readonly string[] } }): string =>
  t.egress?.length ? t.egress.map((h) => (t.pending?.egress.includes(h) ? `${h} (waits)` : h)).join(', ') : 'none';

/** A template's bastion targets (issue #2146), with `(waits)` when one is not approved; `none` without. */
export const bastionTargetsText = (t: { bastionTargets?: readonly string[]; pending?: { bastionTargets?: readonly string[] } }): string =>
  t.bastionTargets?.length ? t.bastionTargets.map((x) => (t.pending?.bastionTargets?.includes(x) ? `${x} (waits)` : x)).join(', ') : 'none';

/** A bastion target (issue #2146): `<cluster>/<namespace>/<svc|pod|deploy>/<name>:<port>` (src/sandbox/bastion.ts parseTargets). */
export const BASTION_TARGET = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}\/[a-z0-9](?:[a-z0-9-]{0,251}[a-z0-9])?\/(?:svc|pod|deploy)\/[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?:[1-9][0-9]{0,4}$/;

/** The bastion targets typed in a field, split by spaces or commas, each once. */
export const bastionTargetsOf = (text: string): string[] => [...new Set(text.split(/[\s,]+/).filter((x) => x !== ''))];

/** `write on cluster x`. */
export const profileText = (p: OperationProfile): string => `${p.operation} on ${p.asset.kind} ${p.asset.name}`;

/** A terraform workspace profile's state backend (issue #715): where the read-only check pushes a state of its own, or that it has none. */
export const backendText = (p: OperationProfile): string => (p.backend
  ? `${p.asset.name}: state in s3://${[p.backend.bucket, p.backend.keyPrefix].filter(Boolean).join('/')} (${p.backend.region})`
  : `${p.asset.name}: no state backend, so the read-only check cannot prove a state write is refused`);

/** The hopper's high-radius operations (src/blast-radius/template.ts): a profile of one needs its own explicit approval (issue #584). */
const HIGH = ['write', 'sync', 'apply', 'observe'];
export const highRadius = (p: OperationProfile): boolean => HIGH.includes(p.operation);

/** The template's profiles that wait for their own explicit approval: approving the template does not approve them. */
export const explicitApprovals = (t: TemplateView): OperationProfile[] => t.pending.profiles.filter(highRadius);

/**
 * The edits that approve all a template card lists (issue #1001): the template as it is (when it waits), then each
 * explicit profile. Sent side by side (issue #1018): neither waits for the other.
 */
export function allListed(t: TemplateView): ({ action: 'approve-template'; name: string } | ({ action: 'approve-profile'; name: string } & OperationProfile))[] {
  const reads = t.pending.profiles.filter((p) => !highRadius(p));
  const whole = !t.approval || t.pending.image || t.pending.egress.length > 0 || (t.pending.bastionTargets?.length ?? 0) > 0 || t.pending.secrets.length > 0 || reads.length > 0;
  return [
    ...(whole ? [{ action: 'approve-template' as const, name: t.name }] : []),
    ...explicitApprovals(t).map((p) => ({ action: 'approve-profile' as const, name: t.name, ...p })),
  ];
}

/** An API token's ask to approve this profile of the template (issue #909), in words; undefined: none. */
export function profileAskOf(asks: readonly ProfileAsk[] | undefined, template: string, p: OperationProfile): string | undefined {
  const a = asks?.find((x) => x.template === template && x.operation === p.operation && x.asset.kind === p.asset.kind && x.asset.name === p.asset.name);
  return a ? `${a.asker} asked to approve this through the API at ${a.at}: approve it here to confirm it.` : undefined;
}

/**
 * Whether an event changes the vault's view: a vault event, or a template's (issue #2196: a job's template request
 * records `template.saved`, and Access requests and its badge must show it at once), or a bastion's start or end (issue
 * #2146: the view lists the bastions that run).
 */
export const rereadsVault = (type: string): boolean => type.startsWith('vault.') || type.startsWith('template.') || type === 'bastion.started' || type === 'bastion.ended';

/** A template waits for a person (issue #897, Access requests): never approved, or a new image, egress host, secret or profile waits. */
export const templateWaits = (t: TemplateView): boolean =>
  !t.approval || t.pending.image || t.pending.egress.length > 0 || (t.pending.bastionTargets?.length ?? 0) > 0 || t.pending.secrets.length > 0 || t.pending.profiles.length > 0;

/**
 * The run cards (issue #2197): one per job and template that waits for a person, its template's approval and its run in
 * one; high-priority jobs first (issue #535), then oldest first, as the daemon answers them.
 */
export const runCardsOf = (v: VaultView | null, high: (jobId: string) => boolean = () => false): RunCardView[] =>
  highFirst(v?.runs ?? [], (c) => high(c.jobId));

/** A run card's key: one per job and template. */
export const runCardKey = (c: Pick<RunCardView, 'jobId' | 'template'>): string => `${c.jobId} ${c.template}`;

/**
 * The templates that wait on a template card of their own (issue #2197): a person's own, that no run card holds. A
 * template a job asked for waits on its run card, never on a card of its own: the daemon makes that card only while
 * the job lives (issue #2196).
 */
export const ownTemplatesWaiting = (v: VaultView | null): TemplateView[] =>
  (v?.templates ?? []).filter((t) => templateWaits(t) && !t.askedBy && !(v?.runs ?? []).some((r) => r.template === t.name));

/** The sandbox runs that no longer wait (issue #991): approved or declined, with who decided. */
export const sandboxRunsDecided = (v: VaultView | null): SandboxRequestView[] => (v?.sandboxRequests ?? []).filter((r) => r.state !== 'waiting');

/** What jobs on boxes wait on a person for (issue #897): credential requests, vault grant asks, a person's own templates, the run cards and the asks for an AWS action (issue #2206). */
export const accessRequestsWaiting = (v: VaultView | null): number =>
  v === null ? 0 : (v.requests?.length ?? 0) + (v.grantAsks?.length ?? 0) + ownTemplatesWaiting(v).length + (v.runs?.length ?? 0) + (v.actionAsks?.length ?? 0);

/** The jobs the UI holds, by id: enough to say how high a job's priority is. */
type JobsById = Readonly<Record<string, Pick<Job, 'priority'>>>;

/** Of those, the run cards and the action asks of high-priority jobs (issues #535, #2196, #2197, #2206): the badge marks them. */
export const accessRequestsHigh = (v: VaultView | null, jobs: JobsById, threshold: number | null): number =>
  (v?.runs ?? []).filter((c) => isHighJob(jobs[c.jobId], threshold)).length + (v?.actionAsks ?? []).filter((a) => isHighJob(jobs[a.job], threshold)).length;

/** The auto-approve policy in force (issue #1001): the view answers it in full; absent, the default. */
export const autoApproveOf = (a: SandboxApprovals | undefined): NonNullable<SandboxApprovals['autoApprove']> => ({ low: true, medium: false, high: false, ...a?.autoApprove });

/** What the sandbox approval toggles and the auto-approve policy mean now (issues #991, #1001), in words. */
export function sandboxApprovalsText(a: SandboxApprovals | undefined): string {
  if (a?.skipTemplateApproval && a.skipSandboxApproval) return 'YOLO is on: a job gets its sandbox with no person. New templates are approved at once, and every sandbox run starts the moment a job asks, high blast radius too.';
  const auto = autoApproveOf(a);
  const levels = (['low', 'medium', 'high'] as const).filter((l) => auto[l]);
  const policy = levels.length ? `Templates and runs of ${levels.join(', ')} blast radius are approved with no person. ` : '';
  if (a?.skipTemplateApproval) return `${policy}Other new templates are approved at once. A person approves each other sandbox run.`;
  if (a?.skipSandboxApproval) return `${policy}A person approves each other new template. Sandbox runs start the moment a job asks, high blast radius too.`;
  return `${policy}A person approves each ${levels.length ? 'other ' : ''}new template and sandbox run.`;
}

/** Its reason in words (issue #2123): `no cluster staging; known: …`, or `cluster utility is ambiguous: …` (issue #2168), each unknown asset once. */
export const unknownReason = (t: TemplateView): string => (t.unknownAssets ?? [])
  .map((u) => (u.candidates ? `cluster ${u.cluster} is ambiguous: ${u.candidates.join(', ')}` : `no cluster ${u.cluster}; known: ${u.known.join(', ')}`)).join('; ');

/** A need's asset with its cluster `from` renamed `to`: a cluster, or the first part of a namespace or an Argo CD app. */
function pointAsset(a: Asset, from: string, to: string): Asset {
  if (a.kind === 'cluster') return a.name === from ? { ...a, name: to } : a;
  if (a.kind !== 'namespace' && a.kind !== 'argocd-app') return a;
  const [cluster, ...rest] = a.name.split('/');
  return cluster === from ? { ...a, name: [to, ...rest].join('/') } : a;
}

/**
 * The save that points a template at a cluster (issue #2168): each need on cluster `from` names `to`. What it leaves out
 * (limits, tools, egress, agent credential, probe marks) the save keeps as it was; its bastion targets on `from` name `to`.
 */
export const pointedAt = (t: TemplateView, from: string, to: string) => ({
  action: 'save-template' as const, name: t.name, image: t.image, secrets: t.secrets, profiles: t.profiles.map((p) => ({ ...p, asset: pointAsset(p.asset, from, to) })),
  // Issue #2146: a bastion target is `<cluster>/…`, as a namespace's name is.
  ...(t.bastionTargets?.length ? { bastionTargets: t.bastionTargets.map((x) => (x.split('/')[0] === from ? [to, ...x.split('/').slice(1)].join('/') : x)) } : {}),
});

/** A template's assets the vault cannot find (issue #2067), in words, as the server says them: `no cluster staging; known: …`. */
const unknownText = (t: TemplateView): string | undefined => (t.unknownAssets?.length ? `unknown asset: ${unknownReason(t)}` : undefined);

/** The templates with an unknown asset (issue #2067): what Access requests lists (issue #2123), and Needs you counts in a row of its own, never as an approval (issue #2168). */
export const unknownAssetTemplates = (v: VaultView | null): TemplateView[] => (v?.templates ?? []).filter((t) => (t.unknownAssets?.length ?? 0) > 0);

/** The templates with an unknown asset (issue #2067), one line each, for Needs you's Unknown clusters row: no approval makes them work. */
export const unknownAssetLines = (v: VaultView | null): string[] => unknownAssetTemplates(v).map((t) => `template ${t.label ?? t.name}: ${unknownText(t)!}`);

/** What a template's card says of its approval: an unknown asset (issue #2067), approved, or what waits for a person. */
export function approvalText(t: TemplateView, jobId?: string): string {
  const unknown = unknownText(t);
  if (unknown) return unknown;
  if (!t.approval) return 'not approved yet: its boxes take no job and get nothing from the vault';
  const waits = [
    ...(t.pending.image ? ['a new image'] : []), ...(t.pending.egress.length ? [`egress to ${t.pending.egress.join(', ')}`] : []), ...(t.pending.bastionTargets?.length ? [`bastion target ${t.pending.bastionTargets.join(', ')}`] : []), ...(t.pending.secrets.length ? [`${t.pending.secrets.join(', ')} added`] : []),
    ...t.pending.profiles.map((p) => `${profileText(p)}${highRadius(p) ? ' (explicit)' : ''}`),
  ];
  if (waits.length) return `waits for approval: ${waits.join('; ')}`;
  // Issue #2197 part 3: a run card approved with no allow again approves its jobs' runs only.
  return jobId !== undefined && t.approval.jobs && !t.approval.jobs.includes(jobId) ? 'approved for another job only: this job needs its own approval' : 'approved';
}

/** A template's rating in a few words (issue #584): the level, then the reasons that set it. */
export const radiusText = (r: TemplateRadius): string => `${r.level} radius: ${r.reasons.join('; ')}`;

/** Who waits on a credential request (issue #583): each job, its box, and what it said it needs the credential for. */
export function requestWaiting(r: CredentialRequest): string[] {
  return r.asked.map((a) => `job ${a.job.slice(0, 8)} on ${a.machine}${a.why ? `: ${a.why}` : ''}`);
}

/** The kinds a person may give: the hopper's suggestions first, then something else in their own words. */
export function kindChoices(r: CredentialRequest): { id: string; title: string }[] {
  return [...r.kinds, { id: 'other', title: 'Something else — say what it is' }];
}

/** Why a person's answer cannot be sent yet, or undefined. */
export function giveProblem(g: { name: string; kind: string; note: string; value: string }, r: CredentialRequest): string | undefined {
  const name = nameProblem(g.name.trim());
  if (name) return name;
  if (g.kind === 'other' && !g.note.trim()) return 'say what you give, so the job knows how to use it';
  if (!g.value && !r.existing.includes(g.name.trim())) return 'enter the value';
  return undefined;
}

/**
 * The read-only check of a template in words (issue #716): none when it takes none; else whether the check of its
 * current version passed, failed (with the probes that failed), runs, or has not run. `waits`: its boxes wait for it.
 */
export function checkText(t: { readOnly?: boolean; savedAt: string; check?: { version: string; state: string; probes: { id: string; asset: string; operation?: string; outcome: string; passed: boolean; mark?: string }[]; problem?: string; artifact?: string } }): { text: string; waits: boolean; report?: string } | undefined {
  if (!t.readOnly) return undefined;
  const c = t.check?.version === t.savedAt ? t.check : undefined;
  if (!c) return { text: 'not run on this version yet: it runs once the template is approved', waits: true };
  if (c.state === 'running') return { text: 'runs now', waits: true };
  // Its report, an artifact of the job that asked for the template (issue #715).
  const report = c.artifact ? { report: `#artifacts/${c.artifact}` } : {};
  // Probes a person marked (issue #916): a read that must be refused, or one not run.
  // A probe under an observe need's credential (issue #2146, part 5) says so.
  const on = (p: { id: string; asset: string; operation?: string }): string => `${p.id} on ${p.asset}${p.operation ? ` under ${p.operation}` : ''}`;
  const marked = c.probes.filter((p) => p.mark).map((p) => `${on(p)} (${p.mark})`);
  if (c.state === 'passed') return { text: `passed: ${c.probes.length} probes, every write refused, every read worked${marked.length ? `, as the template marks ${marked.join('; ')}` : ''}`, waits: false, ...report };
  const failed = c.probes.filter((p) => !p.passed).map((p) => `${on(p)} (${p.outcome})`);
  return { text: `failed: ${[...failed, ...(c.problem ? [c.problem] : [])].join('; ')}`, waits: true, ...report };
}

/** A template's probe marks in words (issue #916): `<probe> <mark>`, or none. */
export const probeMarksText = (marks: Readonly<Record<string, string>> | undefined): string[] => Object.entries(marks ?? {}).map(([probe, mark]) => `${probe} ${mark}`);

/** The choices for a read probe's mark (issue #916): none, the read must work; or a mark. */
export const PROBE_MARK_CHOICES: readonly { value: string; label: string }[] = [
  { value: '', label: 'must work' },
  { value: 'expect-denied', label: 'expect-denied: must be refused' },
  { value: 'skip', label: 'skip: not run' },
];

/** The read probes a person can mark (issue #916): the ones the template's last check ran as reads, and the ones it marks. */
export function markableProbes(t: { check?: { probes: { id: string; expect: string; mark?: string }[] } }, marks: Readonly<Record<string, string>>): string[] {
  const read = (t.check?.probes ?? []).filter((p) => p.expect === 'allowed' || p.mark).map((p) => p.id);
  return [...new Set([...read, ...Object.keys(marks)])].sort();
}

/**
 * An asset in plain words (issue #1001): the minting credential the vault holds for it — for a namespace, its cluster's;
 * for an AWS role, its account's — by name and scope, as a person set them. Undefined when the vault holds none.
 */
export function assetWords(secrets: readonly VaultSecret[], asset: Asset): string | undefined {
  const [head] = asset.name.split('/');
  const owner: Asset = asset.kind === 'namespace' ? { kind: 'cluster', name: head! } : asset.kind === 'aws-role' ? { kind: 'aws-account', name: head! } : asset;
  const s = secrets.find((x) => x.mints?.kind === owner.kind && x.mints.name === owner.name);
  return s ? `${s.name}${s.scope ? `: ${s.scope}` : ''}` : undefined;
}

/** One need in plain words (issue #1001): the operation on the asset, the asset's own words, and whether it changes the asset. */
export function needText(p: OperationProfile, secrets: readonly VaultSecret[]): string {
  const words = assetWords(secrets, p.asset);
  return `${profileText(p)}${words ? ` (${words})` : ''}: ${p.operation === 'read' ? 'reads it' : 'changes it'}`;
}

/** The key a remembered write approval is shown under (issue #1001). */
export const rememberedKey = (p: OperationProfile): string => `${p.operation}/${p.asset.kind}/${p.asset.name}`;
