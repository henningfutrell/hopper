// A template request (issue #716, design.md "Templates on request"): a running job asks the hopper for the sandbox
// template its work needs — `sh "$HOPPER_SKILL" sandbox-template --needs "read/cluster/lab read/aws-account/ID"` — and
// the hopper makes it. The template is named from the needs alone, so the same needs get the same template; it runs the
// hopper's box image with the tools its needs use (issue #716, item 2: src/sandbox/tools.ts), holds no vault secret
// (the dynamic vault asks a person for each credential when a job on its box loads the skill, issue #583), and declares
// one operation profile per need. The hopper approves it with no person only when it makes it now and every need is a
// read the user's read policy holds; anything else waits for a person, as a template saved in the UI does. A job never
// widens a template, approves one, or approves it again after a revoke. A template of read needs only takes the
// read-only check (issue #716, item 4; src/sandbox/check.ts) before its first box: until it passed, the job waits.
import { createHash } from 'node:crypto';
import { ASSET_KINDS, ASSET_NAME, OPERATIONS, type AssetKind, type Operation, type OperationProfile } from '../domain/access.ts';
import { checkWait } from '../domain/read-only-check.ts';
import { inReadPolicy, type ReadPolicy } from '../domain/read-policy.ts';
import type { TemplateView } from '../domain/vault.ts';
import { toolsForNeeds } from '../sandbox/tools.ts';
import { SKILLS } from './catalog.ts';

/** The skill name a job asks for a template by. */
export const TEMPLATE_SKILL = 'sandbox-template';
/** The most needs one request names. */
export const NEEDS_MAX = 16;
/** Who approves a template the read policy holds: what its approval and its events say. */
export const READ_POLICY_APPROVER = 'the read policy';

const HOW = `write each need as <operation>/<kind>/<asset>: sh "$HOPPER_SKILL" ${TEMPLATE_SKILL} --needs "read/cluster/NAME read/aws-account/ID"`;

/** The needs a job said, split by spaces, commas or lines, each once; or why they cannot be read. */
export function needsOf(said: string | undefined): OperationProfile[] | string {
  const items = (said ?? '').split(/[\s,]+/).filter((x) => x !== '');
  if (items.length === 0) return `name what the work needs: ${HOW}`;
  if (items.length > NEEDS_MAX) return `one request names at most ${NEEDS_MAX} needs: ${HOW}`;
  const needs = new Map<string, OperationProfile>();
  for (const item of items) {
    const [operation, kind, ...rest] = item.split('/');
    const name = rest.join('/');
    if (!name || !ASSET_NAME.test(name)) return `${item}: ${HOW}`;
    if (!(OPERATIONS as readonly string[]).includes(operation!)) return `${item}: the operation is one of ${OPERATIONS.join(', ')}; ${HOW}`;
    if (!(ASSET_KINDS as readonly string[]).includes(kind!)) return `${item}: the asset kind is one of ${ASSET_KINDS.join(', ')}; ${HOW}`;
    needs.set(item, { operation: operation as Operation, asset: { kind: kind as AssetKind, name } });
  }
  return [...needs.values()];
}

const keyOf = (p: OperationProfile): string => `${p.operation}/${p.asset.kind}/${p.asset.name}`;
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
  save(t: { name: string; image: string; secrets: string[]; profiles: OperationProfile[]; tools: string[]; readOnly: boolean }, by: string): Promise<Result>;
  approve(name: string, by: string): Promise<Result>;
  policy(): ReadPolicy | undefined;
  image: string;
}

export type TemplateAnswer = { status: 200 | 202; text: string } | { status: 400 | 409 | 503; reason: string };

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

/** A job's request, `by` the job (`job <id>`). */
export async function requestTemplate(u: TemplateRequestUser, said: string | undefined, by: string): Promise<TemplateAnswer> {
  const needs = needsOf(said);
  if (typeof needs === 'string') return { status: 400, reason: needs };
  const name = requestedName(needs);
  const was = u.template(name);
  if (was && !sameNeeds(was.profiles, needs)) {
    return { status: 409, reason: `a person changed template ${name} since it was asked for: a request does not change it back. Ask a person in Settings → Vault, or find another way.` };
  }
  if (!was) {
    const readOnly = needs.every((p) => p.operation === 'read');
    const saved = await u.save({ name, image: u.image, secrets: [], profiles: needs, tools: toolsForNeeds(needs), readOnly }, by);
    if (!saved.ok) return { status: STATUS[saved.code] ?? 503, reason: saved.error };
    // The policy approves only a template it makes now, and only when every need is a read it holds.
    const outside = needs.filter((p) => p.operation !== 'read' || !inReadPolicy(u.policy(), p.asset));
    if (outside.length === 0) {
      const approved = await u.approve(name, READ_POLICY_APPROVER);
      if (!approved.ok) return { status: STATUS[approved.code] ?? 503, reason: approved.error };
    }
  }
  const t = u.template(name);
  if (!t) return { status: 503, reason: `template ${name} was not kept: ask again` };
  const waits = waitsOf(t);
  if (waits.length > 0) {
    const policy = needs.filter((p) => p.operation === 'read' && !inReadPolicy(u.policy(), p.asset)).map((p) => `the read policy does not hold ${inWords(p)}`);
    const high = needs.filter((p) => p.operation !== 'read').map((p) => `${inWords(p)} changes the asset`);
    return { status: 202, text: `waiting: template ${name} waits for a person in Settings → Vault: ${waits.join('; ')}${[...policy, ...high].length ? ` (${[...policy, ...high].join('; ')})` : ''}.` };
  }
  const checking = checkWait(t);
  if (checking) return { status: 202, text: `waiting: template ${name} is approved; ${checking}. Each write it may make must be refused, each read must work.` };
  const who = t.approval?.by === READ_POLICY_APPROVER ? 'approved by the read policy' : 'approved by a person';
  return {
    status: 200,
    text: `${TEMPLATE_SKILL}: template ${name} is ready, ${who}, for: ${needs.map(inWords).join(', ')}.
A box of it does this work. A person starts one: Machines → Add machine → A sandbox box → ${name}, or hopper sandbox launch --template ${name}.
On the box, load the skill for each asset; the hopper asks a person for each credential the first time:
${loads(needs)}`,
  };
}
