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
import { createHash } from 'node:crypto';
import { ASSET_KINDS, ASSET_NAME, OPERATIONS, type AssetKind, type Operation, type OperationProfile } from '../domain/access.ts';
import { checkWait } from '../domain/read-only-check.ts';
import { inReadPolicy, type ReadPolicy } from '../domain/read-policy.ts';
import { NO_SKIPS, SKIP_TEMPLATE_APPROVER, type SandboxApprovals } from '../domain/sandbox-approvals.ts';
import type { TemplatePreview, TemplateView } from '../domain/vault.ts';
import { toolsForNeeds } from '../sandbox/tools.ts';
import { SKILLS } from './catalog.ts';
import { needsFromWords } from './needs-in-words.ts';

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

const sameNeeds = (a: readonly OperationProfile[], b: readonly OperationProfile[]): boolean => {
  const x = a.map(keyOf).sort(), y = b.map(keyOf).sort();
  return x.length === y.length && x.every((k, i) => k === y[i]);
};
const inWords = (p: OperationProfile): string => `${p.operation} on ${p.asset.kind} ${p.asset.name}`;

/** The template's name: from the needs alone, in any order. */
export function requestedName(needs: readonly OperationProfile[]): string {
  return `asked-${createHash('sha256').update(needs.map(keyOf).sort().join('\n')).digest('hex').slice(0, 12)}`;
}

type Result = { ok: true } | { ok: false; code: string; error: string };

/** One user's side: their templates, the vault's own save and approve, their read policy, the image a box runs. */
export interface TemplateRequestUser {
  template(name: string): TemplateView | undefined;
  /** Every template of the user's (issue #998): one approved for the same needs is used for them. */
  templates(): TemplateView[];
  save(t: { name: string; image: string; secrets: string[]; profiles: OperationProfile[]; tools: string[]; readOnly: boolean; askedBy?: string }, by: string): Promise<Result>;
  approve(name: string, by: string): Promise<Result>;
  approveProfile(name: string, profile: OperationProfile, by: string): Promise<Result>;
  policy(): ReadPolicy | undefined;
  /** The sandbox approval toggles (issue #991); absent: both off. */
  approvals?(): SandboxApprovals | undefined;
  image: string;
}

/** `template`: the template's name, when the needs could be read. */
export type TemplateAnswer = { status: 200 | 202; text: string; template: string } | { status: 400 | 409 | 503; reason: string };

const STATUS: Record<string, 400 | 409 | 503> = { invalid: 400, conflict: 409 };

/** What waits for a person on the template, in words; empty when nothing does. */
function waitsOf(t: TemplateView): string[] {
  return [
    ...(!t.approval ? ['the template is not approved'] : t.pending.image ? ['its image changed since it was approved'] : []),
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

/** Why the read policy does not approve the needs, in words; empty when it approves them. All or nothing. */
function outsidePolicy(needs: readonly OperationProfile[], policy: ReadPolicy | undefined): string[] {
  return [
    ...needs.filter((p) => p.operation === 'read' && !inReadPolicy(policy, p.asset)).map((p) => `the read policy does not hold ${inWords(p)}`),
    ...needs.filter((p) => p.operation !== 'read').map((p) => `${inWords(p)} changes the asset`),
  ];
}

/**
 * A template approved for exactly these needs (issue #998): the same profiles, no vault secret, nothing waiting for a
 * person; one whose read-only check passed first. Undefined when there is none.
 */
function approvedFor(u: Pick<TemplateRequestUser, 'templates'>, needs: readonly OperationProfile[]): TemplateView | undefined {
  const same = u.templates().filter((t) => t.secrets.length === 0 && sameNeeds(t.profiles, needs) && waitsOf(t).length === 0);
  return same.find((t) => !checkWait(t)) ?? same[0];
}

const approverOf = (t: TemplateView): TemplatePreview['approvedBy'] => {
  const by = t.approval?.by;
  return by === READ_POLICY_APPROVER || by === SKIP_TEMPLATE_APPROVER ? by : 'a person';
};

const skipsTemplate = (u: Pick<TemplateRequestUser, 'approvals'>): boolean => (u.approvals?.() ?? NO_SKIPS).skipTemplateApproval;

/** The template these needs make, and who approves it; or why the needs cannot be read. It saves nothing. */
export function previewTemplate(u: Pick<TemplateRequestUser, 'template' | 'templates' | 'policy' | 'image' | 'approvals'>, said: string | undefined): TemplatePreview | string {
  const needs = needsOf(said);
  if (typeof needs === 'string') return needs;
  const name = requestedName(needs);
  const was = u.template(name);
  const reused = was && waitsOf(was).length === 0 && sameNeeds(was.profiles, needs) ? undefined : approvedFor(u, needs);
  if (reused) {
    return {
      template: reused.name, image: reused.image, tools: [...(reused.tools ?? [])], needs: needs.map(inWords),
      readOnly: reused.readOnly === true, approvedBy: approverOf(reused), waits: [], exists: 'same',
    };
  }
  const outside = outsidePolicy(needs, u.policy());
  const skip = outside.length > 0 && skipsTemplate(u);
  const waits = skip ? [] : outside;
  return {
    template: name, image: u.image, tools: toolsForNeeds(needs), needs: needs.map(inWords),
    readOnly: needs.every((p) => p.operation === 'read'),
    approvedBy: outside.length === 0 ? READ_POLICY_APPROVER : skip ? SKIP_TEMPLATE_APPROVER : 'a person', waits,
    ...(was ? { exists: sameNeeds(was.profiles, needs) ? 'same' as const : 'changed' as const } : {}),
  };
}

/** A request, `by` the job (`job <id>`) or a person; `job`: the id of the job that asks (issue #715: its check's report goes there). */
export async function requestTemplate(u: TemplateRequestUser, said: string | undefined, by: string, job?: string): Promise<TemplateAnswer> {
  const needs = needsOf(said);
  if (typeof needs === 'string') return { status: 400, reason: needs };
  const asked = requestedName(needs);
  const was = u.template(asked);
  // Issue #998: the template the needs name, when it is approved for them; else another approved for them; else the one
  // the needs name, made now when it is not there.
  const reused = was && waitsOf(was).length === 0 && sameNeeds(was.profiles, needs) ? undefined : approvedFor(u, needs);
  const name = reused?.name ?? asked;
  if (!reused && was && !sameNeeds(was.profiles, needs)) {
    return { status: 409, reason: `a person changed template ${name} since it was asked for: a request does not change it back. Ask a person in Settings → Vault, or find another way.` };
  }
  if (!reused && !was) {
    const readOnly = needs.every((p) => p.operation === 'read');
    const saved = await u.save({ name, image: u.image, secrets: [], profiles: needs, tools: toolsForNeeds(needs), readOnly, ...(job ? { askedBy: job } : {}) }, by);
    if (!saved.ok) return { status: STATUS[saved.code] ?? 503, reason: saved.error };
    // The policy approves only a template it makes now, and only when every need is a read it holds. Else skip template
    // approval (issue #991) approves a template it makes now: as it is, then each write, sync or apply profile.
    const byPolicy = outsidePolicy(needs, u.policy()).length === 0;
    if (byPolicy || skipsTemplate(u)) {
      const approver = byPolicy ? READ_POLICY_APPROVER : SKIP_TEMPLATE_APPROVER;
      const approved = await u.approve(name, approver);
      if (!approved.ok) return { status: STATUS[approved.code] ?? 503, reason: approved.error };
      for (const p of byPolicy ? [] : u.template(name)?.pending.profiles ?? []) {
        const done = await u.approveProfile(name, p, approver);
        if (!done.ok) return { status: STATUS[done.code] ?? 503, reason: done.error };
      }
    }
  }
  const t = u.template(name);
  if (!t) return { status: 503, reason: `template ${name} was not kept: ask again` };
  const waits = waitsOf(t);
  if (waits.length > 0) {
    const why = outsidePolicy(needs, u.policy());
    return { status: 202, template: name, text: `waiting: template ${name} waits for a person on Access requests: ${waits.join('; ')}${why.length ? ` (${why.join('; ')})` : ''}.` };
  }
  const checking = checkWait(t);
  if (checking) return { status: 202, template: name, text: `waiting: template ${name} is approved; ${checking}. Each write it may make must be refused, each read must work.` };
  const who = `approved by ${approverOf(t)}`;
  return {
    status: 200,
    template: name,
    text: `${TEMPLATE_SKILL}: template ${name} is ready, ${who}, for: ${needs.map(inWords).join(', ')}.
A box of it does this work. Ask the hopper to start one: sh "$HOPPER_SKILL" ${SANDBOX_SKILL} --needs "<the same needs>" --wait. A person can also start one: hopper sandbox launch --template ${name}.
On the box, load the skill for each asset; the hopper asks a person for each credential the first time:
${loads(needs)}`,
  };
}
