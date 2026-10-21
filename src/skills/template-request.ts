// A template request (issue #716, design.md "Templates on request"): a running job asks the hopper for the sandbox
// template its work needs — `sh "$HOPPER_SKILL" sandbox-template --needs "read/cluster/lab read/aws-account/ID"` — and
// the hopper makes it. The template is named from the needs alone, so the same needs get the same template; it runs the
// hopper's box image with the tools its needs use (issue #716, item 2: src/sandbox/tools.ts), holds no vault secret
// (the dynamic vault asks a person for each credential when a job on its box loads the skill, issue #583), and declares
// one operation profile per need. The hopper approves it with no person only when it makes it now and every need is a
// read the user's read policy holds; anything else waits for a person, as a template saved in the UI does. A job never
// widens a template, approves one, or approves it again after a revoke. A template of read needs only takes the
// read-only check (issue #716, item 4; src/sandbox/check.ts) before its first box: until it passed, the job waits.
// Issue #991: with the user's **skip template approval** on, a template it makes now that the read policy does not
// approve is approved at once by that toggle, its write, sync and apply profiles with it. A job then asks for a box of
// it (`sandbox`, src/sandbox/requests.ts).
// Issue #998: a template already approved for exactly these needs — the same operation profiles, no vault secret, nothing
// waiting for a person — is used for them, whatever its name, and no second template is made. A person may have saved it,
// or changed an asked-for template to these needs. A template that gives a box more than the needs is never used for them.
// Issue #1001: after the read policy, the user's **auto-approve policy** approves a template it makes now whose blast
// radius is a level the policy holds — by default low: read needs only, as a requested template holds no vault secret.
// Then a person's remembered write approvals: each write, sync or apply need one a person approved before for that asset
// and access, and each read approved with no person (src/domain/remembered-writes.ts). A template keeps the purpose and
// the plan of the job that asked for it first, for the card a person decides on.
// Issue #1779: a template whose check failed as the vault minted nothing for a read need is a 409, not a wait: it cannot
// pass until a person fixes the minting credential, so the job is told which needs mint, and asks for those.
// Issue #1875: a request may also name vault secrets, the hopper's test image and egress hosts (template-ask.ts); with a
// secret or an egress host, its needs may be none, and only a person approves the template.
// Issue #1977: a request that would make a template of an image that is not published is refused at once (`imageProblem`),
// not saved to fail its read-only check later with "manifest unknown".
// Issue #2067: a request that names a cluster the vault cannot find (an unknown asset: src/domain/unknown-assets.ts) is
// refused at once, with the clusters the topology lists, nearest first, so the job asks again with the right name.
import { createHash } from 'node:crypto';
import { ASSET_KINDS, ASSET_NAME, OPERATIONS, type Asset, type AssetKind, type Operation, type OperationProfile } from '../domain/access.ts';
import { OPERATOR_CLI_NAME } from '../domain/failures.ts';
import { mintKindFor } from '../domain/minting.ts';
import { checkedNeed, checkWait, currentCheck, unmintedNeeds, type Unminted } from '../domain/read-only-check.ts';
import { inReadPolicy, type ReadPolicy } from '../domain/read-policy.ts';
import { AUTO_APPROVER, autoApproves, NO_SKIPS, SKIP_TEMPLATE_APPROVER, type SandboxApprovals } from '../domain/sandbox-approvals.ts';
import { readApprovedWithoutPerson, REMEMBERED_APPROVER, rememberedCovers, type RememberedWrite } from '../domain/remembered-writes.ts';
import { DEFAULT_BLAST_RADIUS_SETTINGS } from '../domain/types.ts';
import { rateTemplate } from '../blast-radius/template.ts';
import { approvalCovers, type TemplatePreview, type TemplateView } from '../domain/vault.ts';
import { clusterOf, unknownAssetText, type UnknownAsset } from '../domain/unknown-assets.ts';
import { toolsForNeeds } from '../sandbox/tools.ts'; import { templateTargets } from '../sandbox/bastion.ts';
import { toolSet } from '../domain/sandboxes.ts';
import { SKILLS } from './catalog.ts';
import { needsFromWords } from './needs-in-words.ts';
import { extrasInWords, extrasKey, extrasOf, forPerson, hasExtras, REQUEST_IMAGES, sameExtras, type AskExtras, type TemplateAsk } from './template-ask.ts';

/** The skill name a job asks for a template by. */
export const TEMPLATE_SKILL = 'sandbox-template';
/** The skill name a job asks for a box by (issue #991): the template its needs make, then a box of it. */
export const SANDBOX_SKILL = 'sandbox';
/** The most needs one request names. */
export const NEEDS_MAX = 16;
/** Who approves a template the read policy holds: what its approval and its events say. */
export const READ_POLICY_APPROVER = 'the read policy';

const keyOf = (p: OperationProfile): string => `${p.operation}/${p.asset.kind}/${p.asset.name}`;

const HOW = `say it in words, one line each (kubectl get pods on cluster NAME), or write each need as <operation>/<kind>/<asset>: sh "$HOPPER_SKILL" ${SANDBOX_SKILL} --needs "read/cluster/NAME read/aws-account/ID"`;

/** One need written out, `<operation>/<kind>/<asset>`; or why it cannot be read. */
function writtenNeed(item: string): OperationProfile | string {
  const [operation, kind, ...rest] = item.split('/');
  const name = rest.join('/');
  if (!name || !ASSET_NAME.test(name)) return `${item}: ${HOW}`;
  if (!(OPERATIONS as readonly string[]).includes(operation!)) return `${item}: the operation is one of ${OPERATIONS.join(', ')}; ${HOW}`;
  if (!(ASSET_KINDS as readonly string[]).includes(kind!)) return `${item}: the asset kind is one of ${ASSET_KINDS.join(', ')}; ${HOW}`;
  return { operation: operation as Operation, asset: { kind: kind as AssetKind, name } };
}

/**
 * The needs said, each once; or why they cannot be read. Each line is written out — needs split by spaces or commas,
 * every one with a `/` — or in plain words (issue #708, src/skills/needs-in-words.ts).
 */
export function needsOf(said: string | undefined): OperationProfile[] | string {
  const lines = (said ?? '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
  if (lines.length === 0) return `name what the work needs: ${HOW}`;
  const needs = new Map<string, OperationProfile>();
  for (const line of lines) {
    const items = line.split(/[\s,]+/).filter((x) => x !== '');
    const read = items.every((x) => x.includes('/')) ? items.map(writtenNeed) : [needsFromWords(line)].flat();
    for (const p of read) {
      if (typeof p === 'string') return p.endsWith(HOW) ? p : `${p}; ${HOW}`;
      needs.set(keyOf(p), p);
      if (needs.size > NEEDS_MAX) return `one request names at most ${NEEDS_MAX} needs: ${HOW}`;
    }
  }
  return [...needs.values()];
}

/** The need to ask for in place of a read the read-only check gets no credential for (issue #1468), by its asset's kind. */
const READ_INSTEAD: Partial<Record<AssetKind, (name: string) => string>> = {
  'aws-account': (account) => `read/aws-role/${account}/<role>`,
};

/**
 * Why a template of these needs cannot pass its read-only check (issue #1468); undefined when it can. A template of read
 * needs only takes the check, and the vault mints the check's read credentials for an aws-role, a cluster or a namespace
 * only (a terraform workspace takes the aws-role's). Any other read need fails the check at every run, so it is refused
 * when it is asked for, with the need to ask for in its place.
 */
function uncheckable(needs: readonly OperationProfile[]): string | undefined {
  if (!needs.every((p) => p.operation === 'read')) return undefined;
  const bad = needs.filter((p) => p.asset.kind !== 'terraform-workspace' && mintKindFor(p.asset.kind) === undefined);
  if (bad.length === 0) return undefined;
  return bad.map((p) => {
    const instead = READ_INSTEAD[p.asset.kind]?.(p.asset.name);
    return `${keyOf(p)}: a template of read needs only takes the read-only check, and the vault mints a read credential for an aws-role, a cluster or a namespace only. ${instead ? `Ask for ${instead} in its place` : 'Ask for read on an aws-role, a cluster or a namespace in its place'}`;
  }).join('; ');
}

/** Where a person changed a template (issue #1468): the operator CLI keeps its own name as the saver. */
const changedWhere = (t: TemplateView): string => (t.savedBy === OPERATOR_CLI_NAME ? 'through the operator CLI' : 'in Settings → Vault');

const sameNeeds = (a: readonly OperationProfile[], b: readonly OperationProfile[]): boolean => {
  const x = a.map(keyOf).sort(), y = b.map(keyOf).sort();
  return x.length === y.length && x.every((k, i) => k === y[i]);
};
const inWords = (p: OperationProfile): string => `${p.operation} on ${p.asset.kind} ${p.asset.name}`;

/** The template's name: from the needs alone, in any order; and from the extras when it names any (issue #1875). */
export function requestedName(needs: readonly OperationProfile[], extras?: AskExtras): string {
  return `asked-${createHash('sha256').update([...needs.map(keyOf).sort(), ...(extras ? extrasKey(extras) : [])].join('\n')).digest('hex').slice(0, 12)}`;
}

/** A request read (issue #1875): its needs, its extras, and the image its template runs. */
interface ReadAsk { needs: OperationProfile[]; extras: AskExtras; image: string }

/** The request read; or why it cannot be. Needs may be none only when it names a vault secret or an egress host. */
function readAsk(u: Pick<TemplateRequestUser, 'image'>, ask: TemplateAsk): ReadAsk | string {
  const extras = extrasOf(ask);
  if (typeof extras === 'string') return extras;
  const needs = !ask.needs?.trim() && forPerson(extras) ? [] : needsOf(ask.needs);
  if (typeof needs === 'string') return needs;
  // Issue #2146 part 3: each bastion target needs an observe of the request on its namespace or cluster.
  const placed = extras.targets ? templateTargets(extras.targets, needs) : [];
  if (typeof placed === 'string') return placed;
  return { needs, extras, image: extras.image ? REQUEST_IMAGES[extras.image]! : u.image };
}

/** The tools a template made for the request adds: its needs', and the ones it names (issue #2146). */
const toolsOf = (r: ReadAsk): string[] => toolSet([...toolsForNeeds(r.needs), ...(r.extras.tools ?? [])]);

/** Whether a template is what the request asks for: the same needs, and the same extras when it names any. */
const sameAsk = (t: TemplateView, r: ReadAsk): boolean => sameNeeds(t.profiles, r.needs) && (!hasExtras(r.extras) || sameExtras(t, r.extras, r.image));
/** Whether the template takes the read-only check: no need changes its asset (a read or an observe; issue #2146, part 5). */
const readOnlyOf = (needs: readonly OperationProfile[]): boolean => needs.length > 0 && needs.every(checkedNeed);

type Result = { ok: true } | { ok: false; code: string; error: string };

/** One user's side: their templates, the vault's own save and approve, their read policy, the image a box runs. */
export interface TemplateRequestUser {
  template(name: string): TemplateView | undefined;
  /** Every template of the user's (issue #998): one approved for the same needs is used for them. */
  templates(): TemplateView[];
  save(t: { name: string; image: string; secrets: string[]; egress?: string[]; bastionTargets?: string[]; profiles: OperationProfile[]; tools: string[]; readOnly: boolean; askedBy?: string; purpose?: string; plan?: string }, by: string): Promise<Result>;
  approve(name: string, by: string): Promise<Result>;
  approveProfile(name: string, profile: OperationProfile, by: string): Promise<Result>;
  policy(): ReadPolicy | undefined;
  /** The sandbox approval toggles (issue #991); absent: both off. */
  approvals?(): SandboxApprovals | undefined;
  /** A person's write approvals the hopper remembers now (issue #1001), ended ones left out; absent: none. */
  remembered?(): RememberedWrite[];
  /** The needs' assets the vault cannot find (issue #2067); absent: none asked. */
  unknownAssets?(needs: readonly OperationProfile[]): UnknownAsset[];
  /** Why an image cannot be used (issue #1977: it is not published), or undefined: published, or not known. Absent: none asked. */
  imageProblem?(image: string): Promise<string | undefined>;
  image: string;
}

/** `template`: the template's name, when the needs could be read. */
/** Issue #2356: how a job gets a vault secret that does not exist yet into a template, when a request names one. */
const NO_SECRET = 'the vault holds no secret';
const NEW_SECRET_HOW = 'Ask without --secrets, and once the sandbox runs are approved ask a person for it: sh "$HOPPER_SKILL" SERVICE --template NAME --credential "<what it takes>" --why "<what for>". The secret a person gives is added to the template.';

export type TemplateAnswer = { status: 200 | 202; text: string; template: string } | { status: 400 | 409 | 503; reason: string };

const STATUS: Record<string, 400 | 409 | 503> = { invalid: 400, conflict: 409 };

/** What waits for a person on the template for the job's runs (none: a person's ask), in words; empty when nothing does. */
function waitsOf(t: TemplateView, job: string | undefined): string[] {
  return [
    ...(!t.approval ? ['the template is not approved'] : t.pending.image ? ['its image changed since it was approved'] : []),
    // Issue #2197 part 3: a run card approved with no allow again approves its job's runs only.
    ...(t.approval && !approvalCovers(t, job) ? ['the template is approved for another job\'s runs only'] : []),
    ...(t.approval && t.pending.secrets.length ? [`its vault secret ${t.pending.secrets.join(', ')} is not approved`] : []),
    ...(t.approval && t.pending.egress.length ? [`its egress host ${t.pending.egress.join(', ')} is not approved`] : []),
    ...(t.approval && t.pending.bastionTargets?.length ? [`its bastion target ${t.pending.bastionTargets.join(', ')} is not approved`] : []),
    ...t.pending.profiles.map((p) => `${inWords(p)} is not approved`),
  ];
}

/** The skills a box of the template loads, one line per need: the link skill for its asset kind, if the hopper has one. */
function loads(needs: readonly OperationProfile[]): string {
  return needs.map((p) => {
    const s = SKILLS.find((x) => x.link?.kinds.includes(p.asset.kind));
    return s ? `  sh "$HOPPER_SKILL" ${s.name} ${p.asset.kind}/${p.asset.name}` : `  ${p.asset.kind}/${p.asset.name}: the hopper has no skill for it yet; ask in your own words (--credential)`;
  }).join('\n');
}

/** The part of an asset's name that names its account or cluster: `167028478405` of `167028478405/readonly`. */
const scopeOf = (a: Asset): string => `${a.kind}/${a.name.split('/')[0]}`;

/**
 * Why a template cannot pass its read-only check (issue #1779): the needs the vault minted nothing for, with its reasons,
 * and the read needs on the same accounts or clusters a check of another template passed with, which mint now.
 */
function cannotMint(u: Pick<TemplateRequestUser, 'templates'>, t: TemplateView, unminted: readonly Unminted[]): string {
  const scopes = new Set(unminted.map((x) => scopeOf(x.asset)));
  const failed = new Set(unminted.map((x) => `${x.asset.kind}/${x.asset.name}`));
  const mint = new Set(u.templates().filter((x) => currentCheck(x)?.state === 'passed').flatMap((x) => (x.profiles ?? [])
    .filter((p) => p.operation === 'read' && scopes.has(scopeOf(p.asset)) && !failed.has(`${p.asset.kind}/${p.asset.name}`)).map(keyOf)));
  const why = unminted.map((x) => `read on ${x.asset.kind} ${x.asset.name}: ${x.reason}`).join('; ');
  const instead = mint.size > 0 ? `These read needs on the same account or cluster passed a check: ${[...mint].join(' ')}. Ask for them in its place` : 'Ask for a read need the vault mints for in its place';
  return `template ${t.name} cannot pass its read-only check: the vault minted no credential for ${why}. ${instead}. The hopper runs the check again by itself in an hour, or when a person sets the minting credential again.`;
}

/**
 * Why the needs cannot be met as asked (issue #2067): each unknown asset, with the clusters the topology lists, and the
 * needs with each unknown cluster's nearest one in its place; undefined when every asset is known.
 */
function unknownOf(u: Pick<TemplateRequestUser, 'unknownAssets'>, needs: readonly OperationProfile[]): string | undefined {
  const unknown = u.unknownAssets?.(needs) ?? [];
  if (unknown.length === 0) return undefined;
  const nearest = new Map(unknown.map((x) => [x.cluster, x.known[0]!]));
  const instead = needs.map((p) => {
    const cluster = clusterOf(p.asset);
    const known = cluster && nearest.get(cluster);
    return keyOf(known ? { ...p, asset: { ...p.asset, name: [known, ...p.asset.name.split('/').slice(1)].join('/') } } : p);
  });
  return `${unknown.map(unknownAssetText).join('; ')}. The vault finds a cluster by its EKS name in the AWS accounts it mints for, and the topology lists no cluster of that name there, or several that start with it. Ask again with a known name, for example --needs "${instead.join(' ')}". For a cluster made since the topology was read, a person runs Discover now on the topology page, or names the cluster in a cluster override on Settings → Clusters.`;
}

/** Why the read policy does not approve the needs, in words; empty when it approves them. All or nothing. */
function outsidePolicy(needs: readonly OperationProfile[], policy: ReadPolicy | undefined, extras?: AskExtras): string[] {
  return [
    ...(extras && forPerson(extras) ? ['a vault secret or an egress host is approved by a person only'] : []),
    ...needs.filter((p) => p.operation === 'read' && !inReadPolicy(policy, p.asset)).map((p) => `the read policy does not hold ${inWords(p)}`),
    ...needs.filter((p) => p.operation !== 'read').map((p) => `${inWords(p)} ${p.operation === 'observe' ? 'port-forwards to the asset\'s pods' : 'changes the asset'}`),
  ];
}

/**
 * A template approved for exactly these needs (issue #998): the same profiles, no vault secret, nothing waiting for a
 * person for the job's runs; one whose read-only check passed first. Undefined when there is none.
 */
function approvedFor(u: Pick<TemplateRequestUser, 'templates'>, r: ReadAsk, job: string | undefined): TemplateView | undefined {
  const same = u.templates().filter((t) => (hasExtras(r.extras) ? sameAsk(t, r) : t.secrets.length === 0 && sameNeeds(t.profiles, r.needs)) && waitsOf(t, job).length === 0);
  return same.find((t) => !checkWait(t)) ?? same[0];
}

const approverOf = (t: TemplateView): TemplatePreview['approvedBy'] => {
  const by = t.approval?.by;
  return by === READ_POLICY_APPROVER || by === SKIP_TEMPLATE_APPROVER || by === AUTO_APPROVER || by === REMEMBERED_APPROVER ? by : 'a person';
};

const skipsTemplate = (u: Pick<TemplateRequestUser, 'approvals'>): boolean => (u.approvals?.() ?? NO_SKIPS).skipTemplateApproval;

/**
 * Who approves a template made now for these needs with no person, in order: the read policy (every need a read it
 * holds), the auto-approve policy (issue #1001: the template's blast radius is a level it holds), a person's remembered
 * write approvals (issue #1001: they cover every change, and each read is approved with no person), skip template
 * approval. Undefined: a person. A requested template holds no vault secret, so its radius comes from the needs alone.
 */
function automaticApprover(u: Pick<TemplateRequestUser, 'policy' | 'approvals' | 'remembered'>, needs: readonly OperationProfile[], extras: AskExtras): TemplatePreview['approvedBy'] | undefined {
  // Issue #1875: a vault secret or an egress host is a person's to approve, whatever the policies and toggles say.
  if (forPerson(extras)) return undefined;
  if (outsidePolicy(needs, u.policy()).length === 0) return READ_POLICY_APPROVER;
  const level = rateTemplate({ secrets: [], profiles: [...needs] }, [], DEFAULT_BLAST_RADIUS_SETTINGS.rules).level;
  if (autoApproves(u.approvals?.(), level)) return AUTO_APPROVER;
  if (rememberedCovers({ secrets: [], profiles: needs }, u.remembered?.() ?? [], readApprovedWithoutPerson(u.policy(), u.approvals?.()))) return REMEMBERED_APPROVER;
  return skipsTemplate(u) ? SKIP_TEMPLATE_APPROVER : undefined;
}

/** The template these needs make, and who approves it; or why the needs cannot be read. It saves nothing. */
export function previewTemplate(u: Pick<TemplateRequestUser, 'template' | 'templates' | 'policy' | 'image' | 'approvals' | 'remembered' | 'unknownAssets'>, ask: TemplateAsk): TemplatePreview | string {
  const r = readAsk(u, ask);
  if (typeof r === 'string') return r;
  const { needs, extras } = r;
  const cannot = uncheckable(needs) ?? unknownOf(u, needs);
  if (cannot) return cannot;
  const name = requestedName(needs, extras);
  const was = u.template(name);
  const reused = was && waitsOf(was, undefined).length === 0 && sameAsk(was, r) ? undefined : approvedFor(u, r, undefined);
  if (reused) {
    return {
      template: reused.name, image: reused.image, tools: [...(reused.tools ?? [])], needs: needs.map(inWords),
      readOnly: reused.readOnly === true, approvedBy: approverOf(reused), waits: [], exists: 'same',
    };
  }
  const approver = automaticApprover(u, needs, extras);
  return {
    template: name, image: r.image, tools: toolsOf(r), needs: [...needs.map(inWords), ...extrasInWords(extras)],
    readOnly: readOnlyOf(needs),
    approvedBy: approver ?? 'a person', waits: approver ? [] : outsidePolicy(needs, u.policy(), extras),
    ...(was ? { exists: sameAsk(was, r) ? 'same' as const : 'changed' as const } : {}),
  };
}

/** Why a job asks, and what its box will do (issue #1001): kept on a template made now, for the person who approves it. */
export interface AskAbout { purpose: string; plan?: string }

/**
 * A request, `by` the job (`job <id>`) or a person; `job`: the id of the job that asks (issue #715: its check's report
 * goes there); `about`: why it asks and its plan (issue #1001).
 */
export async function requestTemplate(u: TemplateRequestUser, ask: TemplateAsk, by: string, job?: string, about?: AskAbout): Promise<TemplateAnswer> {
  const r = readAsk(u, ask);
  if (typeof r === 'string') return { status: 400, reason: r };
  const { needs, extras } = r;
  const cannot = uncheckable(needs) ?? unknownOf(u, needs);
  if (cannot) return { status: 400, reason: cannot };
  const asked = requestedName(needs, extras);
  const was = u.template(asked);
  // Issue #998: the template the needs name, when it is approved for them; else another approved for them; else the one
  // the needs name, made now when it is not there.
  const reused = was && waitsOf(was, job).length === 0 && sameAsk(was, r) ? undefined : approvedFor(u, r, job);
  const name = reused?.name ?? asked;
  if (!reused && was && !sameAsk(was, r)) {
    // Issue #1468: the needs it holds now, so a job can ask for those.
    const now = (was.profiles ?? []).map(keyOf).join(' ');
    return {
      status: 409,
      reason: `a person changed template ${name} ${changedWhere(was)} since it was asked for: a request does not change it back. ${now ? `It holds these needs now: ask for them with --needs "${now}".` : 'It holds no need now.'} Else ask a person in Settings → Vault, or find another way.`,
    };
  }
  if (!reused && !was) {
    // Only for a template made now: one made before was asked about then, and a poll of a waiting job asks no registry.
    const missing = await u.imageProblem?.(r.image);
    if (missing) return { status: 400, reason: `${missing}. A box of this template could not start, so the hopper makes no template of it. Ask with another --image, or ask a person to publish it.` };
    const readOnly = readOnlyOf(needs);
    const saved = await u.save({ name, image: r.image, secrets: extras.secrets, ...(extras.egress.length ? { egress: extras.egress } : {}), ...(extras.targets ? { bastionTargets: extras.targets } : {}), profiles: needs, tools: toolsOf(r), readOnly, ...(job ? { askedBy: job } : {}),
      ...(about ? { purpose: about.purpose, ...(about.plan ? { plan: about.plan } : {}) } : {}) }, by);
    if (!saved.ok) return { status: STATUS[saved.code] ?? 503, reason: saved.error.startsWith(NO_SECRET) ? `${saved.error}. ${NEW_SECRET_HOW}` : saved.error };
    // Only a template made now is approved with no person (automaticApprover): as it is, then each write, sync or apply
    // profile, unless the read policy approved it, which holds reads only.
    const approver = automaticApprover(u, needs, extras);
    if (approver) {
      const approved = await u.approve(name, approver);
      if (!approved.ok) return { status: STATUS[approved.code] ?? 503, reason: approved.error };
      for (const p of approver === READ_POLICY_APPROVER ? [] : u.template(name)?.pending.profiles ?? []) {
        const done = await u.approveProfile(name, p, approver);
        if (!done.ok) return { status: STATUS[done.code] ?? 503, reason: done.error };
      }
    }
  }
  const t = u.template(name);
  if (!t) return { status: 503, reason: `template ${name} was not kept: ask again` };
  const waits = waitsOf(t, job);
  if (waits.length > 0) {
    const why = outsidePolicy(needs, u.policy(), extras);
    return { status: 202, template: name, text: `waiting: template ${name} waits for a person on Access requests: ${waits.join('; ')}${why.length ? ` (${why.join('; ')})` : ''}.` };
  }
  const unminted = unmintedNeeds(t);
  if (unminted.length > 0) return { status: 409, reason: cannotMint(u, t, unminted) };
  const checking = checkWait(t);
  if (checking) return { status: 202, template: name, text: `waiting: template ${name} is approved; ${checking}. Each write it may make must be refused, each read must work.` };
  const who = `approved by ${approverOf(t)}`;
  return {
    status: 200,
    template: name,
    text: `${TEMPLATE_SKILL}: template ${name} is ready, ${who}, for: ${[...needs.map(inWords), ...extrasInWords(extras)].join(', ')}.
Each command that needs it runs in a sandbox of its own, which the hopper destroys when the command ends. Ask for the sandbox runs once: sh "$HOPPER_SKILL" ${SANDBOX_SKILL} ${hasExtras(extras) ? `--template ${name}` : '--needs "<the same needs>"'} --wait. Then run each command as a box step: sh "$HOPPER_STEP" box ${name} --command "…".
To run one command that needs it from this job with no sandbox request, run it as a need step: sh "$HOPPER_STEP" need "<the same needs>" --why "…" --command "…".
Load the skill for each asset; the hopper asks a person for each credential the first time:
${loads(needs)}`,
  };
}
